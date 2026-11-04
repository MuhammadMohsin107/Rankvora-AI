ALTER TABLE `onboarding_state` ADD `industries` json;--> statement-breakpoint
ALTER TABLE `onboarding_state` ADD `business_models` json;--> statement-breakpoint
-- Carry every existing answer forward as a one-element list, so a merchant who already chose an
-- industry keeps it instead of finding step 2 blank. NULL stays NULL: never answered is not the
-- same fact as answered-with-nothing, and step completeness is decided on the difference.
UPDATE `onboarding_state` SET `industries` = JSON_ARRAY(`industry`) WHERE `industry` IS NOT NULL;--> statement-breakpoint
UPDATE `onboarding_state` SET `business_models` = JSON_ARRAY(`business_model`) WHERE `business_model` IS NOT NULL;
--> statement-breakpoint
-- Dropped only after the copy above, and in the same migration so there is never a deployed state
-- where both spellings exist and code has to guess which one is current.
ALTER TABLE `onboarding_state` DROP COLUMN `industry`;--> statement-breakpoint
ALTER TABLE `onboarding_state` DROP COLUMN `business_model`;
