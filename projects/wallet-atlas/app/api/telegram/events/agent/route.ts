import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { telegramTrackerSources } from "../../../../../db/schema";
import { recordTrackerEvent } from "../../../../../db/tracker";
import {
  parseTelegramTrade,
  parseTelegramTransfer,
} from "../../../../../lib/telegram-transfer";
import {
  shouldIngestTelegramTransferSource,
  shouldStoreTelegramMessage,
  shouldStoreTelegramTransfer,
} from "../../../../../lib/telegram-sources";

type AgentEvent = {
  chatId?: string;
  chatTitle?: string;
  messageId?: string;
  text?: string;
  linkedUrls?: string[];
  occurredAt?: string;
};

function authorized(request: Request) {
  const secret = (env as unknown as { WALLET_ATLAS_AGENT_SECRET?: string })
    .WALLET_ATLAS_AGENT_SECRET;
  return Boolean(
    secret &&
      request.headers.get("x-wallet-atlas-agent-secret") === secret,
  );
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Yetkisiz." }, { status: 401 });
  }

  const event = (await request.json()) as AgentEvent;
  if (
    !event.chatId ||
    !event.chatTitle ||
    !event.messageId ||
    !event.text ||
    !event.occurredAt
  ) {
    return Response.json({ error: "Telegram mesajı eksik." }, { status: 400 });
  }

  if (!shouldIngestTelegramTransferSource(event.chatTitle)) {
    return Response.json({ ok: true, ignored: "source_disabled" });
  }
  if (!shouldStoreTelegramMessage(event.chatTitle, event.text)) {
    return Response.json({ ok: true, ignored: "source_message_filtered" });
  }

  const transfer = parseTelegramTransfer(event.text, event.linkedUrls ?? []);
  const trade = parseTelegramTrade(event.text, event.linkedUrls ?? []);
  if (!transfer && !trade) {
    return Response.json({ ok: true, ignored: "not_transfer" });
  }
  if (
    transfer &&
    !shouldStoreTelegramTransfer(event.chatTitle, transfer.usdValue)
  ) {
    return Response.json({ ok: true, ignored: "below_usd_threshold" });
  }

  const db = getDb();
  const sourceId = `telegram:${event.chatId}`;
  await db
    .insert(telegramTrackerSources)
    .values({
      id: sourceId,
      name: event.chatTitle,
      sourceType: "group",
      externalChatId: event.chatId,
      connectionStatus: "connected",
      lastConnectedAt: event.occurredAt,
      lastMessageAt: event.occurredAt,
      note: "Wallet Atlas Telegram user agent",
    })
    .onConflictDoUpdate({
      target: telegramTrackerSources.name,
      set: {
        externalChatId: event.chatId,
        connectionStatus: "connected",
        lastMessageAt: event.occurredAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  const activity = transfer ?? trade!;
  const result = await recordTrackerEvent({
    eventType: trade?.eventType ?? "transfer",
    transferKind: transfer?.transferKind ?? "wallet",
    serviceName: transfer?.serviceName ?? null,
    direction: transfer?.direction ?? "unknown",
    network: activity.network,
    walletAddress: activity.walletAddress,
    counterpartyAddress: transfer?.counterpartyAddress ?? null,
    tokenSymbol: activity.tokenSymbol,
    tokenAddress: activity.tokenAddress,
    amount: activity.amount,
    usdValue: activity.usdValue,
    txHash:
      activity.txHash ?? `telegram:${event.chatId}:${event.messageId}`,
    occurredAt: event.occurredAt,
    sourceId,
    sourceMessageId: event.messageId,
    sourceChatTitle: event.chatTitle,
    rawText: event.text,
    linkedUrls: event.linkedUrls ?? [],
  });

  return Response.json({
    ok: true,
    inserted: result.inserted,
    updated: result.updated,
  });
}
