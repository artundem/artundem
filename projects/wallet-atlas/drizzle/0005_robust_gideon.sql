CREATE TABLE `telegram_summary_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`responses_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telegram_summary_jobs_status_requested_idx` ON `telegram_summary_jobs` (`status`,`requested_at`);