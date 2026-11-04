CREATE TABLE `schema_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`schema_type` varchar(64) NOT NULL,
	`context` varchar(16) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`properties` json NOT NULL DEFAULT ('{}'),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `schema_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `schema_templates_store_type_context_idx` UNIQUE(`store_id`,`schema_type`,`context`)
);
--> statement-breakpoint
ALTER TABLE `schema_templates` ADD CONSTRAINT `schema_templates_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `schema_templates_store_enabled_idx` ON `schema_templates` (`store_id`,`enabled`);