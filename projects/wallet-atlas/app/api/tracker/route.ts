import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import {
  directoryWallets,
  telegramTrackerEvents,
  telegramTrackerSources,
  telegramUnmatchedWallets,
} from "../../../db/schema";
import {
  presentTrackerEvents,
  type StoredTrackerEvent,
  type WalletDirectoryProfile,
} from "../../../lib/tracker-presentation";
import walletData from "../../../data/wallet-data.json";

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Beklenmeyen hata";
  if (message.includes("no such table")) {
    return "Telegram Tracker veritabanı henüz hazır değil.";
  }
  return message;
}

export async function GET() {
  try {
    const db = getDb();
    const [storedEvents, unmatchedWallets, sources, wallets] =
      await Promise.all([
        db
          .select()
          .from(telegramTrackerEvents)
          .orderBy(desc(telegramTrackerEvents.occurredAt))
          .limit(1000),
        db
          .select()
          .from(telegramUnmatchedWallets)
          .where(eq(telegramUnmatchedWallets.reviewStatus, "pending"))
          .orderBy(desc(telegramUnmatchedWallets.lastSeenAt))
          .limit(100),
        db
          .select()
          .from(telegramTrackerSources)
          .orderBy(asc(telegramTrackerSources.name)),
        db
          .select({
            address: directoryWallets.address,
            personName: directoryWallets.personName,
            label: directoryWallets.label,
            note: directoryWallets.note,
          })
          .from(directoryWallets),
      ]);
    const baselineWallets =
      (
        walletData as {
          wallets?: {
            address: string;
            group?: string;
            label?: string;
            cleanLabel?: string;
            status?: string | null;
            latestTradeAt?: number | null;
            analysisNote?: string | null;
          }[];
        }
      ).wallets ?? [];
    const walletProfiles = new Map<string, WalletDirectoryProfile>();
    for (const wallet of baselineWallets) {
      const label = wallet.cleanLabel ?? wallet.label ?? wallet.group;
      const personName = wallet.group ?? label;
      if (!label || !personName) continue;
      walletProfiles.set(wallet.address.toLocaleLowerCase("en-US"), {
        personName,
        label,
        note: wallet.analysisNote ?? null,
        status: wallet.status ?? null,
        latestTradeAt: wallet.latestTradeAt ?? null,
      });
    }
    for (const wallet of wallets) {
      const key = wallet.address.toLocaleLowerCase("en-US");
      const research = walletProfiles.get(key);
      walletProfiles.set(key, {
        personName: wallet.personName,
        label: wallet.label,
        note: wallet.note,
        status: research?.status ?? null,
        latestTradeAt: research?.latestTradeAt ?? null,
      });
    }
    const events = presentTrackerEvents(
      storedEvents as StoredTrackerEvent[],
      walletProfiles,
    ).slice(0, 500);
    const bridgeCount = events.filter(
      (event) => event.transferKind === "bridge",
    ).length;

    return Response.json({
      events,
      unmatchedWallets,
      sources,
      counts: {
        recent: events.length,
        transfers: events.length,
        incoming: events.filter((event) => event.direction === "in").length,
        outgoing: events.filter((event) => event.direction === "out").length,
        known: events.filter((event) => event.matchedPersonName).length,
        unmatched: unmatchedWallets.length,
        bridges: bridgeCount,
        walletTransfers: events.length - bridgeCount,
      },
      connectionStatus: sources.some(
        (source) => source.connectionStatus === "connected",
      )
        ? "connected"
        : sources.length > 0
          ? "disconnected"
          : "not_configured",
    });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}
