CREATE TABLE `ai_discovery_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`index_now_key` text(128),
	`index_now_key_set_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_discovery_settings_store_id_unique` ON `ai_discovery_settings` (`store_id`);--> statement-breakpoint
CREATE TABLE `ai_fix_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`store_id` integer NOT NULL,
	`resource_type` text(32) NOT NULL,
	`resource_id` text(64) NOT NULL,
	`field` text(64) NOT NULL,
	`current_value` text NOT NULL,
	`proposed_value` text NOT NULL,
	`reason` text NOT NULL,
	`deterministic_value` text,
	`status` text(16) DEFAULT 'proposed' NOT NULL,
	`status_detail` text,
	`ai_model` text(64),
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decided_at` integer,
	`decided_by` integer,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_fix_proposals_status_valid" CHECK("ai_fix_proposals"."status" IN ('proposed', 'approved', 'applied', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ai_fix_proposals_finding_idx` ON `ai_fix_proposals` (`finding_id`);--> statement-breakpoint
CREATE INDEX `ai_fix_proposals_store_status_idx` ON `ai_fix_proposals` (`store_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fix_proposals_target_idx` ON `ai_fix_proposals` (`finding_id`,`resource_type`,`resource_id`,`field`);--> statement-breakpoint
CREATE TABLE `audit_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`audit_id` integer NOT NULL,
	`pillar` text(32) NOT NULL,
	`sub_pillar` text(120),
	`score` integer NOT NULL,
	`checks_total` integer,
	`checks_passed` integer,
	`analyzed_count` integer,
	`healthy_count` integer,
	`details` text,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audit_scores_score_range" CHECK("audit_scores"."score" BETWEEN 0 AND 100),
	CONSTRAINT "audit_scores_pillar_valid" CHECK("audit_scores"."pillar" IN ('seo', 'content', 'speed', 'cro', 'ai-discovery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_scores_unique_idx` ON `audit_scores` (`audit_id`,`pillar`,`sub_pillar`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_scores_pillar_unique_idx` ON `audit_scores` (`audit_id`,`pillar`) WHERE "audit_scores"."sub_pillar" IS NULL;--> statement-breakpoint
CREATE TABLE `audits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`overall_score` integer NOT NULL,
	`run_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`source` text(16) DEFAULT 'engine' NOT NULL,
	`metadata` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "audits_score_range" CHECK("audits"."overall_score" BETWEEN 0 AND 100),
	CONSTRAINT "audits_source_valid" CHECK("audits"."source" IN ('engine', 'seed'))
);
--> statement-breakpoint
CREATE INDEX `audits_store_run_idx` ON `audits` (`store_id`,`run_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`audit_id` integer NOT NULL,
	`pillar` text(32) NOT NULL,
	`sub_pillar` text(120) NOT NULL,
	`title` text(512) NOT NULL,
	`severity` text(16) NOT NULL,
	`status` text(16) DEFAULT 'open' NOT NULL,
	`resolution_type` text(32),
	`affected_count` integer NOT NULL,
	`affected_label` text(255) NOT NULL,
	`impact` text(32),
	`score_lift` integer DEFAULT 0 NOT NULL,
	`problem` text,
	`why` text NOT NULL,
	`recommendation` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`evidence_rows` text,
	`ai_recommendation` text,
	`ai_model` text(64),
	`ai_generated_at` integer,
	`details` text,
	`status_changed_at` integer,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "findings_severity_valid" CHECK("findings"."severity" IN ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "findings_status_valid" CHECK("findings"."status" IN ('open', 'reviewed', 'resolved', 'ignored')),
	CONSTRAINT "findings_pillar_valid" CHECK("findings"."pillar" IN ('seo', 'content', 'speed', 'cro', 'ai-discovery'))
);
--> statement-breakpoint
CREATE INDEX `findings_audit_idx` ON `findings` (`audit_id`);--> statement-breakpoint
CREATE INDEX `findings_status_idx` ON `findings` (`status`);--> statement-breakpoint
CREATE TABLE `google_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`google_email` text(320),
	`site_url` text(512),
	`ga4_property_id` text(32),
	`access_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text,
	`access_token_expires_at` integer,
	`scope` text NOT NULL,
	`last_error` text(500),
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`disconnected_at` integer,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_connections_store_idx` ON `google_connections` (`store_id`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`provider` text(64) NOT NULL,
	`status` text(32) DEFAULT 'not_connected' NOT NULL,
	`account_detail` text(255),
	`last_synced_at` integer,
	`notice` text,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "integrations_status_valid" CHECK("integrations"."status" IN ('connected', 'needs_attention', 'not_connected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_store_provider_idx` ON `integrations` (`store_id`,`provider`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`type` text(32) DEFAULT 'audit_run' NOT NULL,
	`status` text(16) DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`stage` text(191),
	`error` text,
	`audit_id` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "jobs_status_valid" CHECK("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "jobs_progress_range" CHECK("jobs"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE INDEX `jobs_store_created_idx` ON `jobs` (`store_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_store_active_unique_idx` ON `jobs` (`store_id`) WHERE "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`type` text(64) NOT NULL,
	`title` text(255) NOT NULL,
	`message` text NOT NULL,
	`tone` text(16) DEFAULT 'info' NOT NULL,
	`link` text(512),
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notifications_tone_valid" CHECK("notifications"."tone" IN ('neutral', 'success', 'warning', 'critical', 'info'))
);
--> statement-breakpoint
CREATE INDEX `notifications_store_created_idx` ON `notifications` (`store_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `onboarding_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`current_step` integer DEFAULT 1 NOT NULL,
	`organization_name` text(255),
	`brand_name` text(255),
	`primary_domain` text(512),
	`industries` text,
	`sells_description` text,
	`business_models` text,
	`catalog_shape` text(64),
	`target_countries` text,
	`target_languages` text,
	`primary_market` text(128),
	`target_keywords` text,
	`branded_terms` text,
	`competitor_domains` text,
	`primary_goal` text(64),
	`priority_pillars` text,
	`automation_consent` text(32),
	`alert_frequency` text(32),
	`skipped_steps` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deferred_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "onboarding_state_step_range" CHECK("onboarding_state"."current_step" BETWEEN 1 AND 5),
	CONSTRAINT "onboarding_state_consent_valid" CHECK("onboarding_state"."automation_consent" IS NULL OR "onboarding_state"."automation_consent" IN ('none', 'ask', 'low_risk'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_state_store_id_unique` ON `onboarding_state` (`store_id`);--> statement-breakpoint
CREATE TABLE `page_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`slug` text(190) NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_settings_store_slug_idx` ON `page_settings` (`store_id`,`slug`);--> statement-breakpoint
CREATE INDEX `page_settings_store_updated_idx` ON `page_settings` (`store_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `pagespeed_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`requested_url` text(1024) NOT NULL,
	`final_url` text(1024),
	`strategy` text(16) NOT NULL,
	`performance_score` integer,
	`lab` text,
	`field` text,
	`opportunities` text,
	`lighthouse_version` text(32),
	`analyzed_at` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pagespeed_reports_strategy_valid" CHECK("pagespeed_reports"."strategy" IN ('mobile', 'desktop'))
);
--> statement-breakpoint
CREATE INDEX `pagespeed_reports_latest_idx` ON `pagespeed_reports` (`store_id`,`strategy`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `prompt_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query_id` integer NOT NULL,
	`store_id` integer NOT NULL,
	`model` text(64) NOT NULL,
	`mentioned` integer NOT NULL,
	`mention_context` text,
	`mention_position` numeric,
	`brand_rank` integer,
	`brands_named` integer,
	`competitors_named` text,
	`checked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`query_id`) REFERENCES `prompt_queries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_checks_query_idx` ON `prompt_checks` (`query_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `prompt_checks_store_idx` ON `prompt_checks` (`store_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `prompt_queries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`query` text(500) NOT NULL,
	`brand_term` text(255) NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_queries_store_idx` ON `prompt_queries` (`store_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_queries_store_query_idx` ON `prompt_queries` (`store_id`,`query`);--> statement-breakpoint
CREATE TABLE `schema_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`schema_type` text(64) NOT NULL,
	`context` text(16) NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schema_templates_store_type_context_idx` ON `schema_templates` (`store_id`,`schema_type`,`context`);--> statement-breakpoint
CREATE INDEX `schema_templates_store_enabled_idx` ON `schema_templates` (`store_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`type` text(32) NOT NULL,
	`ip_address` text(45),
	`user_agent` text(512),
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "security_events_type_valid" CHECK("security_events"."type" IN ('login_success', 'login_failed', 'logout', 'password_changed', 'password_reset', 'email_verified', 'session_revoked', 'sessions_revoked'))
);
--> statement-breakpoint
CREATE INDEX `security_events_user_created_idx` ON `security_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `shopify_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`shop_domain` text(255) NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`scope` text NOT NULL,
	`refresh_token_encrypted` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`shop_gid` text(64),
	`last_sync_summary` text,
	`last_sync_error` text,
	`installed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`uninstalled_at` integer,
	`last_webhook_at` integer,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shopify_connections_shop_domain_unique` ON `shopify_connections` (`shop_domain`);--> statement-breakpoint
CREATE INDEX `shopify_connections_store_idx` ON `shopify_connections` (`store_id`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`workspace_name` text(255) NOT NULL,
	`name` text(255) NOT NULL,
	`url` text(512) NOT NULL,
	`platform` text(64) NOT NULL,
	`industry` text(128) NOT NULL,
	`country` text(128) NOT NULL,
	`timezone` text(64) NOT NULL,
	`currency` text(64) NOT NULL,
	`auto_analysis` integer DEFAULT true NOT NULL,
	`analysis_frequency` text(32) DEFAULT 'Weekly' NOT NULL,
	`crawl_scope` text(64) DEFAULT 'Entire store' NOT NULL,
	`page_limit` integer DEFAULT 2000 NOT NULL,
	`include_blog` integer DEFAULT true NOT NULL,
	`include_collections` integer DEFAULT true NOT NULL,
	`respect_robots` integer DEFAULT true NOT NULL,
	`shopify_profile` text,
	`weekly_summary_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stores_owner_idx` ON `stores` (`owner_id`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text(64) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`ip_address` text(45),
	`user_agent` text(512),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_sessions_token_hash_idx` ON `user_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `user_sessions_user_idx` ON `user_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text(255) NOT NULL,
	`email` text(320) NOT NULL,
	`password_hash` text(255) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`job_title` text(255),
	`role` text(64) DEFAULT 'Administrator' NOT NULL,
	`is_platform_admin` integer DEFAULT false NOT NULL,
	`notify_analysis_complete` integer DEFAULT true NOT NULL,
	`notify_critical_issues` integer DEFAULT true NOT NULL,
	`notify_score_changes` integer DEFAULT true NOT NULL,
	`notify_weekly_summary` integer DEFAULT true NOT NULL,
	`notify_integration_alerts` integer DEFAULT true NOT NULL,
	`notify_product_updates` integer DEFAULT false NOT NULL,
	`density` text(32) DEFAULT 'Comfortable' NOT NULL,
	`reduce_motion` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);