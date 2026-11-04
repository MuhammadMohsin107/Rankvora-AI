CREATE TABLE `pagespeed_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`store_id` int NOT NULL,
	`requested_url` varchar(1024) NOT NULL,
	`final_url` varchar(1024),
	`strategy` varchar(16) NOT NULL,
	`performance_score` int,
	`lab` json,
	`field` json,
	`opportunities` json,
	`lighthouse_version` varchar(32),
	`analyzed_at` datetime,
	`fetched_at` datetime NOT NULL,
	CONSTRAINT `pagespeed_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `pagespeed_reports_strategy_valid` CHECK(`pagespeed_reports`.`strategy` IN ('mobile', 'desktop'))
);
--> statement-breakpoint
ALTER TABLE `pagespeed_reports` ADD CONSTRAINT `pagespeed_reports_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pagespeed_reports_latest_idx` ON `pagespeed_reports` (`store_id`,`strategy`,`fetched_at`);