-- Publish tracking: filled by the server's tracker when Postiz reports a post's
-- state (PUBLISHED = delivered/released by Postiz; ERROR = delivery failed).
ALTER TABLE posts ADD COLUMN IF NOT EXISTS posted_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS release_url text;
