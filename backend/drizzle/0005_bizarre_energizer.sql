CREATE TABLE `auth_challenges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`code_hash` varchar(255) NOT NULL,
	`expires_at` datetime NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 5,
	`consumed_at` datetime,
	`sent_at` datetime,
	`delivery_attempts` int NOT NULL DEFAULT 0,
	`last_delivery_error` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `auth_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_challenges_purpose_valid` CHECK(`auth_challenges`.`purpose` IN ('email_verification', 'password_reset', 'password_reset_ticket'))
);
--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD CONSTRAINT `auth_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `auth_challenges_lookup_idx` ON `auth_challenges` (`user_id`,`purpose`,`consumed_at`);