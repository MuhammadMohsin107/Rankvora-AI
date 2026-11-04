CREATE TABLE `user_recovery_codes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`used_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_recovery_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `security_events` DROP CONSTRAINT `security_events_type_valid`;--> statement-breakpoint
ALTER TABLE `user_recovery_codes` ADD CONSTRAINT `user_recovery_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_recovery_codes_lookup_idx` ON `user_recovery_codes` (`user_id`,`code_hash`);--> statement-breakpoint
CREATE INDEX `user_recovery_codes_user_idx` ON `user_recovery_codes` (`user_id`,`used_at`);--> statement-breakpoint
ALTER TABLE `security_events` ADD CONSTRAINT `security_events_type_valid` CHECK (`security_events`.`type` IN ('login_success', 'login_failed', 'logout', 'password_changed', 'password_reset', 'email_verified', 'session_revoked', 'sessions_revoked', 'two_factor_enabled', 'two_factor_disabled', 'two_factor_admin_disabled', 'two_factor_challenges_revoked', 'two_factor_recovery_used', 'recovery_codes_generated'));