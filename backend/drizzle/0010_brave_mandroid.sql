CREATE TABLE `google_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`google_email` varchar(320),
	`site_url` varchar(512),
	`access_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text,
	`access_token_expires_at` datetime,
	`scope` text NOT NULL,
	`last_error` varchar(500),
	`last_synced_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`disconnected_at` datetime,
	CONSTRAINT `google_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `google_connections_store_idx` UNIQUE(`store_id`)
);
--> statement-breakpoint
ALTER TABLE `google_connections` ADD CONSTRAINT `google_connections_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;