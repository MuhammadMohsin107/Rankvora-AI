ALTER TABLE `shopify_connections` ADD `refresh_token_encrypted` text;--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD `access_token_expires_at` datetime;--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD `refresh_token_expires_at` datetime;--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD `shop_gid` varchar(64);--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD `last_sync_summary` json;--> statement-breakpoint
ALTER TABLE `shopify_connections` ADD `last_sync_error` text;