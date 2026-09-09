CREATE TABLE `telegram_tracker_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`event_type` text NOT NULL,
	`network` text NOT NULL,
	`wallet_address` text NOT NULL,
	`counterparty_address` text,
	`token_symbol` text,
	`token_address` text,
	`amount` text NOT NULL,
	`usd_value` text,
	`tx_hash` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source_id` text,
	`source_message_id` text,
	`matched_person_name` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_tracker_events_dedupe_unique` ON `telegram_tracker_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `telegram_tracker_events_type_time_idx` ON `telegram_tracker_events` (`event_type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `telegram_tracker_events_wallet_idx` ON `telegram_tracker_events` (`wallet_address`);--> statement-breakpoint
CREATE INDEX `telegram_tracker_events_tx_hash_idx` ON `telegram_tracker_events` (`tx_hash`);--> statement-breakpoint
CREATE TABLE `telegram_tracker_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text DEFAULT 'unknown' NOT NULL,
	`external_chat_id` text,
	`connection_status` text DEFAULT 'not_configured' NOT NULL,
	`last_connected_at` text,
	`last_message_at` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_tracker_sources_name_unique` ON `telegram_tracker_sources` (`name`);--> statement-breakpoint
CREATE INDEX `telegram_tracker_sources_status_idx` ON `telegram_tracker_sources` (`connection_status`);--> statement-breakpoint
CREATE TABLE `telegram_unmatched_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`network` text NOT NULL,
	`wallet_address` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`event_count` integer DEFAULT 1 NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`resolved_person_name` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_unmatched_wallets_network_address_unique` ON `telegram_unmatched_wallets` (`network`,`wallet_address`);--> statement-breakpoint
CREATE INDEX `telegram_unmatched_wallets_review_idx` ON `telegram_unmatched_wallets` (`review_status`,`last_seen_at`);