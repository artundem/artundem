import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { telegramTrackerSources } from "../../../../db/schema";
import { recordTrackerEvent } from "../../../../db/tracker";
import {
  shouldIngestTelegramTransferSource,
  shouldStoreTelegramMessage,
  shouldStoreTelegramTransfer,
} from "../../../../lib/telegram-sources";
import { parseTelegramTransfer } from "../../../../lib/telegram-transfer";

type TelegramEntity = {
  type?: string;
  url?: string;
};

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  chat: {
    id: number;
    title?: string;
    username?: string;
    type?: string;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_message?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

function webhookSecret() {
  return (env as unknown as { TELEGRAM_WEBHOOK_SECRET?: string })
    .TELEGRAM_WEBHOOK_SECRET;
}

export async function POST(request: Request) {
  const configuredSecret = webhookSecret();
  const suppliedSecret = request.headers.get(
    "x-telegram-bot-api-secret-token",
  );

  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;
  const message =
    update.message ??
    update.channel_post ??
    update.edited_message ??
    update.edited_channel_post;
  if (!message) return Response.json({ ok: true, ignored: "no_message" });

  const chatId = String(message.chat.id);
  const sourceName =
    message.chat.title ?? message.chat.username ?? `Telegram ${chatId}`;
  if (!shouldIngestTelegramTransferSource(sourceName)) {
    return Response.json({ ok: true, ignored: "source_disabled" });
  }

  const text = message.text ?? message.caption ?? "";
  if (!shouldStoreTelegramMessage(sourceName, text)) {
    return Response.json({ ok: true, ignored: "source_message_filtered" });
  }
  const entities = message.entities ?? message.caption_entities ?? [];
  const linkedUrls = entities
    .map((entity) => entity.url)
    .filter((url): url is string => Boolean(url));
  const transfer = parseTelegramTransfer(text, linkedUrls);
  if (!transfer) {
    return Response.json({ ok: true, ignored: "not_transfer" });
  }
  if (!shouldStoreTelegramTransfer(sourceName, transfer.usdValue)) {
    return Response.json({ ok: true, ignored: "below_usd_threshold" });
  }

  const db = getDb();
  const sourceId = `telegram:${chatId}`;
  const occurredAt = new Date(message.date * 1000).toISOString();

  await db
    .insert(telegramTrackerSources)
    .values({
      id: sourceId,
      name: sourceName,
      sourceType:
        message.chat.type === "channel"
          ? "channel"
          : message.chat.type?.includes("group")
            ? "group"
            : "private_chat",
      externalChatId: chatId,
      connectionStatus: "connected",
      lastConnectedAt: occurredAt,
      lastMessageAt: occurredAt,
      note: "Wallet Atlas Receiver",
    })
    .onConflictDoUpdate({
      target: telegramTrackerSources.name,
      set: {
        externalChatId: chatId,
        connectionStatus: "connected",
        lastMessageAt: occurredAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });

  const fallbackTxHash = `telegram:${chatId}:${message.message_id}`;
  const result = await recordTrackerEvent({
    eventType: "transfer",
    transferKind: transfer.transferKind,
    serviceName: transfer.serviceName,
    direction: transfer.direction,
    network: transfer.network,
    walletAddress: transfer.walletAddress,
    counterpartyAddress: transfer.counterpartyAddress,
    tokenSymbol: transfer.tokenSymbol,
    tokenAddress: transfer.tokenAddress,
    amount: transfer.amount,
    usdValue: transfer.usdValue,
    txHash: transfer.txHash ?? fallbackTxHash,
    occurredAt,
    sourceId,
    sourceMessageId: String(message.message_id),
    sourceChatTitle: sourceName,
    rawText: text,
    linkedUrls,
  });

  await db
    .update(telegramTrackerSources)
    .set({
      connectionStatus: "connected",
      lastMessageAt: occurredAt,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(telegramTrackerSources.id, sourceId));

  return Response.json({
    ok: true,
    inserted: result.inserted,
    updated: result.updated,
  });
}
