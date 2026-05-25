-- Beauty AI SaaS — Migration v2
-- Run against an EXISTING production D1 database (schema v1 → v2).
--
-- Apply:
--   wrangler d1 execute beauty-ai-db --file=migration_v2.sql --remote
--
-- SQLite ADD COLUMN rules:
--   • Cannot add NOT NULL without a DEFAULT unless the column is nullable.
--   • Cannot add UNIQUE via ALTER TABLE — create the index separately instead.
--   • Cannot drop or rename columns in older SQLite versions (D1 is fine, but
--     we avoid it here to keep the migration safely additive / reversible).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── salons: new columns ───────────────────────────────────────────────────────

-- Standard-tier routing key (nullable; NULL = Premium tier or not yet set)
ALTER TABLE salons ADD COLUMN slug TEXT;

-- New status field; default to 'trial' for existing rows until migrated
ALTER TABLE salons ADD COLUMN status TEXT NOT NULL DEFAULT 'trial';

-- Rename semantic: `salon_name` stays for backward compat; `name` is the v2 field.
-- After Worker code is updated to read `name`, run:
--   UPDATE salons SET name = salon_name WHERE name IS NULL;
ALTER TABLE salons ADD COLUMN name TEXT;

-- Welcome logo Telegram file_id (Premium feature)
ALTER TABLE salons ADD COLUMN photo_file_id TEXT;

-- Subscription expiry
ALTER TABLE salons ADD COLUMN paid_until TEXT;

-- Monthly generation counter (replaces plan_used in v3)
ALTER TABLE salons ADD COLUMN monthly_generations_count INTEGER NOT NULL DEFAULT 0;

-- Generation cap per plan (replaces plan_limit in v3)
ALTER TABLE salons ADD COLUMN max_allowed_generations INTEGER NOT NULL DEFAULT 150;

-- Seed max_allowed_generations from existing plan_limit where available
UPDATE salons
SET max_allowed_generations = plan_limit
WHERE plan_limit IS NOT NULL AND plan_limit > 0;

-- Seed monthly_generations_count from existing plan_used
UPDATE salons
SET monthly_generations_count = plan_used
WHERE plan_used IS NOT NULL AND plan_used > 0;

-- Backfill status from existing plan_name:
--   has active plan  → 'standard_active' (we don't yet know if premium)
--   no plan          → 'trial'
UPDATE salons
SET status = CASE
  WHEN plan_name IS NOT NULL THEN 'standard_active'
  ELSE 'trial'
END;

-- ── salons: indexes ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_slug
  ON salons(slug) WHERE slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_bot_token
  ON salons(bot_token);

CREATE INDEX IF NOT EXISTS idx_salons_paid_until
  ON salons(paid_until) WHERE paid_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_salons_status
  ON salons(status);

-- ── users: new columns ────────────────────────────────────────────────────────

-- B2B attribution tag
ALTER TABLE users ADD COLUMN source_track TEXT;

-- Explicit FK to salons (important for Standard tier multi-salon shared bot)
ALTER TABLE users ADD COLUMN salon_id INTEGER REFERENCES salons(id) ON DELETE SET NULL;

-- Backfill salon_id from bot_token for existing users
UPDATE users
SET salon_id = (
  SELECT id FROM salons WHERE salons.bot_token = users.bot_token LIMIT 1
)
WHERE salon_id IS NULL;

-- ── users: indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_bot_token
  ON users(bot_token);

CREATE INDEX IF NOT EXISTS idx_users_salon_id
  ON users(salon_id) WHERE salon_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_source_track
  ON users(source_track) WHERE source_track IS NOT NULL;

-- ── user_states: name the existing implicit index explicitly ──────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_states_lookup
  ON user_states(user_id, bot_token);

-- ── pending_jobs: indexes (table may not exist in very old deployments) ───────
CREATE TABLE IF NOT EXISTS pending_jobs (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  request_id   TEXT     UNIQUE NOT NULL,
  user_id      TEXT     NOT NULL,
  bot_token    TEXT     NOT NULL,
  chat_id      TEXT     NOT NULL,
  status_url   TEXT,
  response_url TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_bot_token
  ON pending_jobs(bot_token);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_created_at
  ON pending_jobs(created_at);
