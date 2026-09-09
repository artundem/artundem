import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const directoryPeople = sqliteTable(
  "directory_people",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("directory_people_name_unique").on(table.name)],
);

export const directoryWallets = sqliteTable(
  "directory_wallets",
  {
    id: text("id").primaryKey(),
    personName: text("person_name").notNull(),
    chain: text("chain", { enum: ["solana", "evm"] }).notNull(),
    category: text("category", { enum: ["trade", "funding"] })
      .notNull()
      .default("funding"),
    label: text("label").notNull(),
    address: text("address").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("directory_wallets_address_unique").on(table.address),
  ],
);

export const directoryDeletions = sqliteTable(
  "directory_deletions",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type", {
      enum: ["person", "wallet"],
    }).notNull(),
    entityKey: text("entity_key").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("directory_deletions_entity_unique").on(
      table.entityType,
      table.entityKey,
    ),
  ],
);

export const telegramTrackerSources = sqliteTable(
  "telegram_tracker_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sourceType: text("source_type", {
      enum: [
        "private_chat",
        "group",
        "channel",
        "webhook",
        "api",
        "unknown",
      ],
    })
      .notNull()
      .default("unknown"),
    externalChatId: text("external_chat_id"),
    connectionStatus: text("connection_status", {
      enum: ["not_configured", "disconnected", "connected", "error"],
    })
      .notNull()
      .default("not_configured"),
    lastConnectedAt: text("last_connected_at"),
    lastMessageAt: text("last_message_at"),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("telegram_tracker_sources_name_unique").on(table.name),
    index("telegram_tracker_sources_status_idx").on(table.connectionStatus),
  ],
);

export const telegramTrackerEvents = sqliteTable(
  "telegram_tracker_events",
  {
    id: text("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    eventType: text("event_type", {
      enum: ["buy", "sell", "transfer"],
    }).notNull(),
    transferKind: text("transfer_kind", {
      enum: ["wallet", "bridge"],
    })
      .notNull()
      .default("wallet"),
    serviceName: text("service_name"),
    direction: text("direction", {
      enum: ["in", "out", "unknown"],
    })
      .notNull()
      .default("unknown"),
    network: text("network").notNull(),
    walletAddress: text("wallet_address").notNull(),
    counterpartyAddress: text("counterparty_address"),
    tokenSymbol: text("token_symbol"),
    tokenAddress: text("token_address"),
    amount: text("amount").notNull(),
    usdValue: text("usd_value"),
    txHash: text("tx_hash").notNull(),
    occurredAt: text("occurred_at").notNull(),
    sourceId: text("source_id"),
    sourceMessageId: text("source_message_id"),
    sourceChatTitle: text("source_chat_title"),
    rawText: text("raw_text"),
    linkedUrlsJson: text("linked_urls_json").notNull().default("[]"),
    matchedPersonName: text("matched_person_name"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("telegram_tracker_events_dedupe_unique").on(table.dedupeKey),
    index("telegram_tracker_events_type_time_idx").on(
      table.eventType,
      table.occurredAt,
    ),
    index("telegram_tracker_events_wallet_idx").on(table.walletAddress),
    index("telegram_tracker_events_tx_hash_idx").on(table.txHash),
  ],
);

export const telegramUnmatchedWallets = sqliteTable(
  "telegram_unmatched_wallets",
  {
    id: text("id").primaryKey(),
    network: text("network").notNull(),
    walletAddress: text("wallet_address").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    eventCount: integer("event_count").notNull().default(1),
    reviewStatus: text("review_status", {
      enum: ["pending", "resolved", "ignored"],
    })
      .notNull()
      .default("pending"),
    resolvedPersonName: text("resolved_person_name"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("telegram_unmatched_wallets_network_address_unique").on(
      table.network,
      table.walletAddress,
    ),
    index("telegram_unmatched_wallets_review_idx").on(
      table.reviewStatus,
      table.lastSeenAt,
    ),
  ],
);

export const telegramSummaryJobs = sqliteTable(
  "telegram_summary_jobs",
  {
    id: text("id").primaryKey(),
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    requestedAt: text("requested_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    responsesJson: text("responses_json").notNull().default("[]"),
    error: text("error"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("telegram_summary_jobs_status_requested_idx").on(
      table.status,
      table.requestedAt,
    ),
  ],
);
