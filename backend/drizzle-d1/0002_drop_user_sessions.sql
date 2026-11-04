-- The app issues no session of its own any more: Shopify ID tokens prove who is calling, and nothing
-- is stored. The table of signed-in devices (SHA-256 hashes of refresh tokens) has no reader or writer.
DROP TABLE `user_sessions`;