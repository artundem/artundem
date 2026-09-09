import { and, eq, sql } from "drizzle-orm";
import { getDb } from ".";
import {
  directoryWallets,
  telegramTrackerEvents,
  telegramUnmatchedWallets,
} from "./schema";
import { buildTrackerEventDedupeKey } from "./tracker-key";

export { buildTrackerEventDedupeKey } from "./tracker-key";

export type TrackerEventType = "buy" | "sell" | "transfer";

export type TrackerEventInput = {
  eventType: TrackerEventType;
  transferKind?: "wallet" | "bridge";
  serviceName?: string | null;
  direction?: "in" | "out" | "unknown";
  network: string;
  walletAddress: string;
  counterpartyAddress?: string | null;
  tokenSymbol?: string | null;
  tokenAddress?: string | null;
  amount: string;
  usdValue?: string | null;
  txHash: string;
  occurredAt: string;
  sourceId?: string | null;
  sourceMessageId?: string | null;
  sourceChatTitle?: string | null;
  rawText?: string | null;
  linkedUrls?: string[];
};

export async function recordTrackerEvent(input: TrackerEventInput) {
  const db = getDb();
  const eventId = crypto.randomUUID();
  const dedupeKey = buildTrackerEventDedupeKey(input);
  const network = input.network.trim();
  const walletAddress = input.walletAddress.trim();
  const [knownWallet] = await db
    .select({ personName: directoryWallets.personName })
    .from(directoryWallets)
    .where(
      sql`lower(${directoryWallets.address}) = lower(${walletAddress})`,
    )
    .limit(1);
  const linkedUrlsJson = JSON.stringify(input.linkedUrls ?? []);
  const values = {
    dedupeKey,
    eventType: input.eventType,
    transferKind: input.transferKind ?? "wallet",
    serviceName: input.serviceName?.trim() || null,
    direction: input.direction ?? "unknown",
    network,
    walletAddress,
    counterpartyAddress: input.counterpartyAddress?.trim() || null,
    tokenSymbol: input.tokenSymbol?.trim() || null,
    tokenAddress: input.tokenAddress?.trim() || null,
    amount: input.amount.trim(),
    usdValue: input.usdValue?.trim() || null,
    txHash: input.txHash.trim(),
    occurredAt: input.occurredAt,
    sourceId: input.sourceId?.trim() || null,
    sourceMessageId: input.sourceMessageId?.trim() || null,
    sourceChatTitle: input.sourceChatTitle?.trim() || null,
    rawText: input.rawText?.trim() || null,
    linkedUrlsJson,
    matchedPersonName: knownWallet?.personName ?? null,
  };

  const sourceId = input.sourceId?.trim();
  const sourceMessageId = input.sourceMessageId?.trim();
  const [existingSourceEvent] =
    sourceId && sourceMessageId
      ? await db
          .select({
            id: telegramTrackerEvents.id,
            network: telegramTrackerEvents.network,
            walletAddress: telegramTrackerEvents.walletAddress,
          })
          .from(telegramTrackerEvents)
          .where(
            and(
              eq(telegramTrackerEvents.sourceId, sourceId),
              eq(telegramTrackerEvents.sourceMessageId, sourceMessageId),
            ),
          )
          .limit(1)
      : [];

  if (existingSourceEvent) {
    await db
      .update(telegramTrackerEvents)
      .set(values)
      .where(eq(telegramTrackerEvents.id, existingSourceEvent.id));

    if (
      existingSourceEvent.walletAddress
        .toLocaleLowerCase("en-US")
        .endsWith("pump") &&
      existingSourceEvent.walletAddress !== walletAddress
    ) {
      await db
        .delete(telegramUnmatchedWallets)
        .where(
          and(
            eq(
              telegramUnmatchedWallets.network,
              existingSourceEvent.network,
            ),
            eq(
              telegramUnmatchedWallets.walletAddress,
              existingSourceEvent.walletAddress,
            ),
          ),
        );
    }

    if (!knownWallet) {
      await recordUnmatchedWallet(
        network,
        walletAddress,
        input.occurredAt,
        false,
      );
    }

    return { inserted: false, updated: true, id: existingSourceEvent.id };
  }

  const inserted = await db
    .insert(telegramTrackerEvents)
    .values({
      id: eventId,
      ...values,
    })
    .onConflictDoUpdate({
      target: telegramTrackerEvents.dedupeKey,
      set: values,
    })
    .returning({ id: telegramTrackerEvents.id });

  if (inserted.length === 0) {
    return { inserted: false, updated: false, id: null };
  }

  if (knownWallet) {
    return { inserted: true, updated: false, id: inserted[0].id };
  }

  await recordUnmatchedWallet(network, walletAddress, input.occurredAt);

  return { inserted: true, updated: false, id: inserted[0].id };
}

async function recordUnmatchedWallet(
  network: string,
  walletAddress: string,
  occurredAt: string,
  incrementEventCount = true,
) {
  const db = getDb();
  await db
    .insert(telegramUnmatchedWallets)
    .values({
      id: crypto.randomUUID(),
      network,
      walletAddress,
      firstSeenAt: occurredAt,
      lastSeenAt: occurredAt,
      eventCount: 1,
      reviewStatus: "pending",
    })
    .onConflictDoUpdate({
      target: [
        telegramUnmatchedWallets.network,
        telegramUnmatchedWallets.walletAddress,
      ],
      set: {
        lastSeenAt: occurredAt,
        ...(incrementEventCount
          ? {
              eventCount: sql`${telegramUnmatchedWallets.eventCount} + 1`,
            }
          : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}
