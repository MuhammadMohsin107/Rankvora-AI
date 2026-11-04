-- Sign-in is Shopify only: nothing in the app holds a password or a platform-admin flag any more.
-- Both columns are dropped. users.password_hash held a hash of random bytes for every account the
-- app created from a shop, and a real password hash for any account from the old email sign-in;
-- is_platform_admin guarded an admin API that no longer exists. Nothing else in the table changes.
ALTER TABLE `users` DROP COLUMN `password_hash`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `is_platform_admin`;