CREATE TABLE `security_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`type` varchar(32) NOT NULL,
	`ip_address` varchar(45),
	`user_agent` varchar(512),
	`metadata` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `security_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `security_events_type_valid` CHECK(`security_events`.`type` IN ('login_success', 'login_failed', 'logout', 'password_changed', 'password_reset', 'email_verified', 'session_revoked', 'sessions_revoked'))
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_used_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	`revoked_at` datetime,
	`ip_address` varchar(45),
	`user_agent` varchar(512),
	CONSTRAINT `user_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_sessions_token_hash_idx` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `password_changed_at` datetime;--> statement-breakpoint
ALTER TABLE `security_events` ADD CONSTRAINT `security_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `security_events_user_created_idx` ON `security_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_sessions_user_idx` ON `user_sessions` (`user_id`,`revoked_at`);