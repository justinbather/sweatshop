-- Sweatshop v2 — system of record (ROADMAP.md data model).
-- Linear stays the human routing/approval surface; Postgres is truth for
-- hooks, posts, images, metrics, config. Applied by server/src/migrate.ts.

CREATE TABLE IF NOT EXISTS influencers (
  id                     text PRIMARY KEY,
  name                   text NOT NULL,
  postiz_integration_id  text NOT NULL DEFAULT '',
  timeslots              text[] NOT NULL DEFAULT '{}',
  enabled                boolean NOT NULL DEFAULT true,
  profile                text NOT NULL DEFAULT 'ugc' CHECK (profile IN ('ugc','graphic')),
  design                 jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hooks (
  id          text PRIMARY KEY,                -- h_xxxxxx
  text        text NOT NULL,
  angle       text NOT NULL DEFAULT '',
  rationale   text,
  ticket      text,                            -- autopilot ticket (e.g. CON-73)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id             text PRIMARY KEY,             -- postiz post id
  ticket         text NOT NULL,                -- Linear post ticket (e.g. CON-77)
  concept_id     text,                         -- Linear concept ticket (e.g. CON-66)
  hook_id        text REFERENCES hooks(id),
  influencer_id  text REFERENCES influencers(id),
  status         text NOT NULL DEFAULT 'scheduled',
  scheduled_at   timestamptz,
  test_id        text,                         -- A/B group (tests.id), nullable
  variant_label  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_influencer_sched ON posts (influencer_id, scheduled_at);
CREATE INDEX IF NOT EXISTS posts_hook ON posts (hook_id);

CREATE TABLE IF NOT EXISTS images (
  id             text PRIMARY KEY,
  s3_key         text NOT NULL,                -- object key / path under DATA_DIR for now
  influencer_id  text REFERENCES influencers(id),
  gen_ai         boolean NOT NULL DEFAULT true,
  type           text NOT NULL DEFAULT 'ugc',  -- ugc | graphic | pinterest | influencer
  tags           text[] NOT NULL DEFAULT '{}',
  last_used_at   timestamptz,
  use_count      int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS post_images (
  post_id   text NOT NULL REFERENCES posts(id),
  image_id  text NOT NULL REFERENCES images(id),
  position  int NOT NULL,                      -- cover = 1
  PRIMARY KEY (post_id, image_id)
);

CREATE TABLE IF NOT EXISTS tests (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  hypothesis  text,
  variable    text NOT NULL CHECK (variable IN ('hook','cover','content')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- channel-level daily samples (Postiz analytics) — one row per influencer+label+day
CREATE TABLE IF NOT EXISTS account_metrics (
  id             bigserial PRIMARY KEY,
  influencer_id  text NOT NULL REFERENCES influencers(id),
  label          text NOT NULL,
  value          numeric NOT NULL,
  date           date NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (influencer_id, label, date)
);

-- per-post metrics (reserved until a per-post source exists)
CREATE TABLE IF NOT EXISTS post_metrics (
  id           bigserial PRIMARY KEY,
  post_id      text NOT NULL REFERENCES posts(id),
  label        text NOT NULL,
  value        numeric NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

-- app-level business metrics (RevenueCat / PostHog collectors — docs/ATTRIBUTION.md)
CREATE TABLE IF NOT EXISTS app_metrics (
  id           bigserial PRIMARY KEY,
  label        text NOT NULL,                  -- e.g. 'mrr', 'signups:tiktok_sadie'
  value        numeric NOT NULL,
  date         date NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label, date)
);

-- small config/state KV: 'brief', 'config', 'secrets', 'agents', 'state:*'
CREATE TABLE IF NOT EXISTS app_config (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
