CREATE TABLE `ai_discovery_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`index_now_key` varchar(128),
	`index_now_key_set_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `ai_discovery_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_discovery_settings_store_id_unique` UNIQUE(`store_id`)
);
--> statement-breakpoint
CREATE TABLE `prompt_checks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`query_id` int NOT NULL,
	`store_id` int NOT NULL,
	`model` varchar(64) NOT NULL,
	`mentioned` boolean NOT NULL,
	`mention_context` text,
	`checked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `prompt_checks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prompt_queries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`query` varchar(500) NOT NULL,
	`brand_term` varchar(255) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `prompt_queries_id` PRIMARY KEY(`id`),
	CONSTRAINT `prompt_queries_store_query_idx` UNIQUE(`store_id`,`query`)
);
--> statement-breakpoint
ALTER TABLE `ai_discovery_settings` ADD CONSTRAINT `ai_discovery_settings_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prompt_checks` ADD CONSTRAINT `prompt_checks_query_id_prompt_queries_id_fk` FOREIGN KEY (`query_id`) REFERENCES `prompt_queries`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prompt_checks` ADD CONSTRAINT `prompt_checks_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prompt_queries` ADD CONSTRAINT `prompt_queries_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `prompt_checks_query_idx` ON `prompt_checks` (`query_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `prompt_checks_store_idx` ON `prompt_checks` (`store_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `prompt_queries_store_idx` ON `prompt_queries` (`store_id`,`active`);