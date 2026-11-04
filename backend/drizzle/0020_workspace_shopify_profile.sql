ALTER TABLE `stores` ADD `shopify_profile` json;--> statement-breakpoint
-- Signup used to write stand-in values into a new store before any shop was connected: "My store",
-- https://example.com, a UTC timezone and US dollars. Settings showed them as though they were the
-- merchant's real details. They are cleared to the honest "not known" state; connecting a shop, a
-- sync or an audit then fills them from Shopify (services/store-profile.service.ts).
UPDATE `stores` SET `name` = '' WHERE `name` = 'My store' AND `url` = 'https://example.com';--> statement-breakpoint
UPDATE `stores` SET `url` = '' WHERE `url` = 'https://example.com';--> statement-breakpoint
-- '(UTC+00:00) UTC' was only ever written by signup: it is not an entry of the old Settings list.
UPDATE `stores` SET `timezone` = 'Unspecified' WHERE `timezone` = '(UTC+00:00) UTC';--> statement-breakpoint
-- The signup currency, on a store that has never been connected, is the stand-in and not a choice.
-- (The single-character wildcard matches the em dash without depending on the file's encoding.)
UPDATE `stores` SET `currency` = 'Unspecified' WHERE `platform` = 'Not connected' AND `currency` LIKE 'USD _ US Dollar';
