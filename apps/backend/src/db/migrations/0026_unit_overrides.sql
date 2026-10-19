ALTER TABLE `organize_matches` ADD `title_override` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_matches` ADD `year_override` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_units` ADD `title_override` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_units` ADD `year_override` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_units` ADD `pins` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_units` ADD `renames` text DEFAULT '{}' NOT NULL;