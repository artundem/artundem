CREATE TABLE `directory_deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_deletions_entity_unique` ON `directory_deletions` (`entity_type`,`entity_key`);--> statement-breakpoint
CREATE TABLE `directory_people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_people_name_unique` ON `directory_people` (`name`);--> statement-breakpoint
CREATE TABLE `directory_wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`person_name` text NOT NULL,
	`chain` text NOT NULL,
	`label` text NOT NULL,
	`address` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_wallets_address_unique` ON `directory_wallets` (`address`);