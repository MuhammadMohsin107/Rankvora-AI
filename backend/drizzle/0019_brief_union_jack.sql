ALTER TABLE `prompt_checks` ADD `mention_position` decimal(5,4);--> statement-breakpoint
ALTER TABLE `prompt_checks` ADD `brand_rank` int;--> statement-breakpoint
ALTER TABLE `prompt_checks` ADD `brands_named` int;--> statement-breakpoint
ALTER TABLE `prompt_checks` ADD `competitors_named` json;