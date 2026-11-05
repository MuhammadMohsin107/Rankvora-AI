CREATE TABLE `link_scan_urls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` integer NOT NULL,
	`url` text NOT NULL,
	`role` text(8) DEFAULT 'target' NOT NULL,
	`internal` integer DEFAULT false NOT NULL,
	`in_sitemap` integer DEFAULT false NOT NULL,
	`state` text(8) DEFAULT 'pending' NOT NULL,
	`outcome` text(12),
	`status` integer,
	`final_url` text,
	`hops` integer DEFAULT 0 NOT NULL,
	`reason` text(32),
	`detail` text,
	`source_count` integer,
	`outlinks` text,
	`checked_at` integer,
	FOREIGN KEY (`scan_id`) REFERENCES `link_scans`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "link_scan_urls_role_valid" CHECK("link_scan_urls"."role" IN ('page', 'sitemap', 'target')),
	CONSTRAINT "link_scan_urls_state_valid" CHECK("link_scan_urls"."state" IN ('pending', 'done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_scan_urls_scan_url_idx` ON `link_scan_urls` (`scan_id`,`url`);--> statement-breakpoint
CREATE INDEX `link_scan_urls_work_idx` ON `link_scan_urls` (`scan_id`,`state`,`role`,`id`);--> statement-breakpoint
CREATE INDEX `link_scan_urls_result_idx` ON `link_scan_urls` (`scan_id`,`outcome`,`internal`);--> statement-breakpoint
CREATE TABLE `link_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`status` text(16) DEFAULT 'queued' NOT NULL,
	`shop_domain` text(255),
	`trigger` text(16) DEFAULT 'manual' NOT NULL,
	`phase` text(16) DEFAULT 'discovering' NOT NULL,
	`origin` text(512),
	`hosts` text,
	`robots` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`stage` text(191),
	`limit_reached` text(16),
	`summary` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "link_scans_status_valid" CHECK("link_scans"."status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "link_scans_phase_valid" CHECK("link_scans"."phase" IN ('discovering', 'crawling', 'checking', 'finishing')),
	CONSTRAINT "link_scans_progress_range" CHECK("link_scans"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE INDEX `link_scans_store_created_idx` ON `link_scans` (`store_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_scans_store_active_unique_idx` ON `link_scans` (`store_id`) WHERE "link_scans"."status" IN ('queued', 'running');