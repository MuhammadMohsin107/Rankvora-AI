ALTER TABLE `findings` ADD `ai_recommendation` json;--> statement-breakpoint
ALTER TABLE `findings` ADD `ai_model` varchar(64);--> statement-breakpoint
ALTER TABLE `findings` ADD `ai_generated_at` datetime;