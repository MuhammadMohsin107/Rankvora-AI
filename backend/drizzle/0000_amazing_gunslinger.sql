CREATE TABLE `audit_scores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`audit_id` int NOT NULL,
	`pillar` varchar(32) NOT NULL,
	`sub_pillar` varchar(120),
	`sub_pillar_key` varchar(120) GENERATED ALWAYS AS ((COALESCE(`sub_pillar`, ''))) STORED NOT NULL,
	`score` int NOT NULL,
	`checks_total` int,
	`checks_passed` int,
	`analyzed_count` int,
	`healthy_count` int,
	`details` json,
	CONSTRAINT `audit_scores_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_scores_unique_idx` UNIQUE(`audit_id`,`pillar`,`sub_pillar_key`),
	CONSTRAINT `audit_scores_score_range` CHECK(`audit_scores`.`score` BETWEEN 0 AND 100),
	CONSTRAINT `audit_scores_pillar_valid` CHECK(`audit_scores`.`pillar` IN ('seo', 'content', 'speed', 'cro', 'ai-discovery'))
);
--> statement-breakpoint
CREATE TABLE `audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`overall_score` int NOT NULL,
	`run_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`source` varchar(16) NOT NULL DEFAULT 'engine',
	`metadata` json,
	CONSTRAINT `audits_id` PRIMARY KEY(`id`),
	CONSTRAINT `audits_score_range` CHECK(`audits`.`overall_score` BETWEEN 0 AND 100),
	CONSTRAINT `audits_source_valid` CHECK(`audits`.`source` IN ('engine', 'seed'))
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`audit_id` int NOT NULL,
	`pillar` varchar(32) NOT NULL,
	`sub_pillar` varchar(120) NOT NULL,
	`title` varchar(512) NOT NULL,
	`severity` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'open',
	`resolution_type` varchar(32),
	`affected_count` int NOT NULL,
	`affected_label` varchar(255) NOT NULL,
	`impact` varchar(32) NOT NULL,
	`score_lift` int NOT NULL DEFAULT 0,
	`problem` text,
	`why` text NOT NULL,
	`recommendation` text NOT NULL,
	`evidence` json NOT NULL DEFAULT ('[]'),
	`evidence_rows` json,
	`details` json,
	`status_changed_at` datetime,
	CONSTRAINT `findings_id` PRIMARY KEY(`id`),
	CONSTRAINT `findings_severity_valid` CHECK(`findings`.`severity` IN ('critical', 'high', 'medium', 'low')),
	CONSTRAINT `findings_status_valid` CHECK(`findings`.`status` IN ('open', 'reviewed', 'resolved', 'ignored')),
	CONSTRAINT `findings_pillar_valid` CHECK(`findings`.`pillar` IN ('seo', 'content', 'speed', 'cro', 'ai-discovery'))
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`provider` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'not_connected',
	`account_detail` varchar(255),
	`last_synced_at` datetime,
	`notice` text,
	CONSTRAINT `integrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `integrations_store_provider_idx` UNIQUE(`store_id`,`provider`),
	CONSTRAINT `integrations_status_valid` CHECK(`integrations`.`status` IN ('connected', 'needs_attention', 'not_connected'))
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`type` varchar(32) NOT NULL DEFAULT 'audit_run',
	`status` varchar(16) NOT NULL DEFAULT 'queued',
	`active_flag` tinyint GENERATED ALWAYS AS ((CASE WHEN `status` IN ('queued', 'running') THEN 1 ELSE NULL END)) STORED,
	`progress` int NOT NULL DEFAULT 0,
	`error` text,
	`audit_id` int,
	`started_at` datetime,
	`finished_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_store_active_unique_idx` UNIQUE(`store_id`,`active_flag`),
	CONSTRAINT `jobs_status_valid` CHECK(`jobs`.`status` IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT `jobs_progress_range` CHECK(`jobs`.`progress` BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`type` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`tone` varchar(16) NOT NULL DEFAULT 'info',
	`is_read` boolean NOT NULL DEFAULT false,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `notifications_tone_valid` CHECK(`notifications`.`tone` IN ('neutral', 'success', 'warning', 'critical', 'info'))
);
--> statement-breakpoint
CREATE TABLE `page_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`slug` varchar(190) NOT NULL,
	`values` json NOT NULL DEFAULT ('{}'),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `page_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `page_settings_store_slug_idx` UNIQUE(`store_id`,`slug`)
);
--> statement-breakpoint
CREATE TABLE `shopify_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`shop_domain` varchar(255) NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`scope` text NOT NULL,
	`installed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`uninstalled_at` datetime,
	`last_webhook_at` datetime,
	CONSTRAINT `shopify_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `shopify_connections_shop_domain_unique` UNIQUE(`shop_domain`)
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`id` int AUTO_INCREMENT NOT NULL,
	`owner_id` int NOT NULL,
	`workspace_name` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`url` varchar(512) NOT NULL,
	`platform` varchar(64) NOT NULL,
	`industry` varchar(128) NOT NULL,
	`country` varchar(128) NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`currency` varchar(64) NOT NULL,
	`auto_analysis` boolean NOT NULL DEFAULT true,
	`analysis_frequency` varchar(32) NOT NULL DEFAULT 'Weekly',
	`crawl_scope` varchar(64) NOT NULL DEFAULT 'Entire store',
	`page_limit` int NOT NULL DEFAULT 2000,
	`include_blog` boolean NOT NULL DEFAULT true,
	`include_collections` boolean NOT NULL DEFAULT true,
	`respect_robots` boolean NOT NULL DEFAULT true,
	CONSTRAINT `stores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`full_name` varchar(255) NOT NULL,
	`email` varchar(320) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`email_verified_at` datetime,
	`refresh_token_hash` varchar(255),
	`refresh_token_expires_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`job_title` varchar(255),
	`role` varchar(64) NOT NULL DEFAULT 'Administrator',
	`notify_analysis_complete` boolean NOT NULL DEFAULT true,
	`notify_critical_issues` boolean NOT NULL DEFAULT true,
	`notify_score_changes` boolean NOT NULL DEFAULT true,
	`notify_weekly_summary` boolean NOT NULL DEFAULT true,
	`notify_integration_alerts` boolean NOT NULL DEFAULT true,
	`notify_product_updates` boolean NOT NULL DEFAULT false,
	`density` varchar(32) NOT NULL DEFAULT 'Comfortable',
	`reduce_motion` boolean NOT NULL DEFAULT false,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `audit_scores` ADD CONSTRAINT `audit_scores_audit_id_audits_id_fk` FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audits` ADD CONSTRAINT `audits_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `findings` ADD CONSTRAINT `findings_audit_id_audits_id_fk` FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_audit_id_audits_id_fk` FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `page_settings` ADD CONSTRAINT `page_settings_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD CONSTRAINT `shopify_connections_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stores` ADD CONSTRAINT `stores_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audits_store_run_idx` ON `audits` (`store_id`,`run_at`);--> statement-breakpoint
CREATE INDEX `findings_audit_idx` ON `findings` (`audit_id`);--> statement-breakpoint
CREATE INDEX `findings_status_idx` ON `findings` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_store_created_idx` ON `jobs` (`store_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_store_created_idx` ON `notifications` (`store_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_settings_store_updated_idx` ON `page_settings` (`store_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `shopify_connections_store_idx` ON `shopify_connections` (`store_id`);--> statement-breakpoint
CREATE INDEX `stores_owner_idx` ON `stores` (`owner_id`);