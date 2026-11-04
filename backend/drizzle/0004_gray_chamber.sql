CREATE TABLE `ai_fix_proposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`finding_id` int NOT NULL,
	`store_id` int NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` varchar(64) NOT NULL,
	`field` varchar(64) NOT NULL,
	`current_value` text NOT NULL,
	`proposed_value` text NOT NULL,
	`reason` text NOT NULL,
	`deterministic_value` text,
	`status` varchar(16) NOT NULL DEFAULT 'proposed',
	`status_detail` text,
	`ai_model` varchar(64),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`decided_at` datetime,
	`decided_by` int,
	CONSTRAINT `ai_fix_proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_fix_proposals_target_idx` UNIQUE(`finding_id`,`resource_type`,`resource_id`,`field`),
	CONSTRAINT `ai_fix_proposals_status_valid` CHECK(`ai_fix_proposals`.`status` IN ('proposed', 'approved', 'applied', 'rejected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE `ai_fix_proposals` ADD CONSTRAINT `ai_fix_proposals_finding_id_findings_id_fk` FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_fix_proposals` ADD CONSTRAINT `ai_fix_proposals_store_id_stores_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_fix_proposals` ADD CONSTRAINT `ai_fix_proposals_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ai_fix_proposals_finding_idx` ON `ai_fix_proposals` (`finding_id`);--> statement-breakpoint
CREATE INDEX `ai_fix_proposals_store_status_idx` ON `ai_fix_proposals` (`store_id`,`status`);