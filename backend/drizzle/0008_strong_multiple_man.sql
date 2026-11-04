CREATE TABLE `admin_security_actions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actor_user_id` int NOT NULL,
	`target_user_id` int NOT NULL,
	`action` varchar(48) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`ip_address` varchar(45),
	`user_agent` varchar(512),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `admin_security_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_security_actions_action_valid` CHECK(`admin_security_actions`.`action` IN ('two_factor_disabled', 'two_factor_challenges_revoked'))
);
--> statement-breakpoint
ALTER TABLE `security_events` DROP CONSTRAINT `security_events_type_valid`;--> statement-breakpoint
ALTER TABLE `users` ADD `is_platform_admin` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `admin_security_actions` ADD CONSTRAINT `admin_security_actions_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `admin_security_actions` ADD CONSTRAINT `admin_security_actions_target_user_id_users_id_fk` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `admin_security_actions_target_idx` ON `admin_security_actions` (`target_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_security_actions_actor_idx` ON `admin_security_actions` (`actor_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `security_events` ADD CONSTRAINT `security_events_type_valid` CHECK (`security_events`.`type` IN ('login_success', 'login_failed', 'logout', 'password_changed', 'password_reset', 'email_verified', 'session_revoked', 'sessions_revoked', 'two_factor_enabled', 'two_factor_disabled', 'two_factor_admin_disabled', 'two_factor_challenges_revoked'));