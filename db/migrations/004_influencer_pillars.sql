-- Content pillars live on the account: each influencer rotates through their own
-- example hooks (a "random" entry = explore slot).
ALTER TABLE influencers ADD COLUMN IF NOT EXISTS pillars text[] NOT NULL DEFAULT '{}';
