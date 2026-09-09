ALTER TABLE `telegram_tracker_events` ADD `transfer_kind` text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_tracker_events` ADD `service_name` text;--> statement-breakpoint
ALTER TABLE `telegram_tracker_events` ADD `linked_urls_json` text DEFAULT '[]' NOT NULL;