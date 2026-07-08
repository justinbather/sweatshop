-- Two-stage publish tracking:
--   delivered_at    when Postiz dropped the post in the TikTok inbox
--   videos_baseline the account's Videos count at delivery — when the live count
--                   exceeds it, delivered posts are promoted to published in order
ALTER TABLE posts ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS videos_baseline numeric;
