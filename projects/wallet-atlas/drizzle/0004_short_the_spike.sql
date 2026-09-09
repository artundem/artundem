ALTER TABLE `telegram_tracker_events` ADD `direction` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_tracker_events` ADD `source_chat_title` text;--> statement-breakpoint
ALTER TABLE `telegram_tracker_events` ADD `raw_text` text;