CREATE TABLE `organize_skips` (
	`account_name` text NOT NULL,
	`path` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`account_name`, `path`)
);
--> statement-breakpoint
ALTER TABLE `organize_units` ADD `missing` text DEFAULT '{}' NOT NULL;