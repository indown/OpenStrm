CREATE TABLE `media_probes` (
	`account_name` text NOT NULL,
	`key` text NOT NULL,
	`path` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`probed_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`account_name`, `key`)
);
