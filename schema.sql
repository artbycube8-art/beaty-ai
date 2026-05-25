-- Beauty AI SaaS — D1 Schema v2
-- ─────────────────────────────────────────────────────────────────────────────
-- Two execution modes:
--   Fresh DB  → run this file directly:
--               wrangler d1 execute beauty-ai-db --file=schema.sql
--   Existing DB → run only the ALTER TABLE block at the bottom (migration.sql)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── SALONS ──────────────────────────────────────────────────────────────────
-- One row per salon.
--
-- Routing logic:
--   Standard tier  — shared MAIN_BOT_TOKEN, salon identified by `slug`
--                    passed as /start deep-link param (e.g. /start barber_h486)
--   Premium tier   — salon owns its own bot; `bot_token` is unique per salon,
--                    webhook registered at /webhook/:bot_token
--
-- status values:
--   'trial'            — free trial, no paid subscription yet
--   'standard_active'  — Standard plan active (shared bot)
--   'premium_active'   — Premium plan active (own bot)
--   'expired'          — subscription lapsed; bot shows "temporarily unavailable"
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS salons (
  id                        INTEGER  PRIMARY KEY AUTOINCREMENT,

  -- ── Identity ──────────────────────────────────────────────────────────────
  slug                      TEXT     UNIQUE,          -- Standard routing key, e.g. 'barber_h486'
  bot_token                 TEXT     UNIQUE NOT NULL, -- shared main bot OR own premium bot token
  status                    TEXT     NOT NULL DEFAULT 'trial'
                                     CHECK(status IN ('trial','standard_active','premium_active','expired')),

  -- ── Profile ───────────────────────────────────────────────────────────────
  name                      TEXT     NOT NULL,        -- display name shown to clients
  salon_type                TEXT     NOT NULL DEFAULT 'barber'
                                     CHECK(salon_type IN ('barber','makeup','nails')),
  photo_file_id             TEXT,                     -- Telegram file_id of welcome logo
  whatsapp_phone            TEXT     NOT NULL,        -- digits only, e.g. 77001234567
  admin_chat_id             TEXT     NOT NULL,        -- salon owner's Telegram chat ID

  -- ── Subscription ──────────────────────────────────────────────────────────
  paid_until                TEXT,                     -- ISO date YYYY-MM-DD; NULL = trial/expired
  monthly_generations_count INTEGER  NOT NULL DEFAULT 0,  -- resets on 1st of each month
  max_allowed_generations   INTEGER  NOT NULL DEFAULT 150, -- 150 / 300 / 600 / 99999

  -- ── Per-client free-try limit ──────────────────────────────────────────────
  max_images                INTEGER  NOT NULL DEFAULT 3,   -- free AI tries per end-client
  discount                  INTEGER,                       -- % discount shown in CTA (nullable)

  -- ── Legacy plan fields (kept for backward compat with existing code) ───────
  -- These will be removed in v3 once the Worker is fully migrated.
  plan_name                 TEXT,
  plan_limit                INTEGER,
  plan_used                 INTEGER  NOT NULL DEFAULT 0,
  plan_reset_at             TEXT,

  -- ── Timestamps ────────────────────────────────────────────────────────────
  created_at                DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Explicit unique indexes (SQLite auto-creates for UNIQUE columns,
-- but naming them makes wrangler migrations explicit and reversible).
CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_slug
  ON salons(slug) WHERE slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_salons_bot_token
  ON salons(bot_token);

-- Filtering active salons by expiry date (used in the monthly reset cron)
CREATE INDEX IF NOT EXISTS idx_salons_paid_until
  ON salons(paid_until) WHERE paid_until IS NOT NULL;

-- Status-based filtering (e.g. "find all expired subscriptions")
CREATE INDEX IF NOT EXISTS idx_salons_status
  ON salons(status);


-- ─── USERS ───────────────────────────────────────────────────────────────────
-- One row per (Telegram user, bot_token) pair.
-- For Standard tier all users share the same bot_token; salon is identified
-- via the salon_id FK so analytics stay clean per-salon.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT     NOT NULL,   -- Telegram user_id (string)
  bot_token     TEXT     NOT NULL,
  salon_id      INTEGER  REFERENCES salons(id) ON DELETE SET NULL, -- explicit FK for Standard tier
  phone         TEXT,
  name          TEXT,
  image_count   INTEGER  NOT NULL DEFAULT 0,
  source_track  TEXT,                -- B2B attribution tag, e.g. 'b2b_almaty', 'b2b_instagram'
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, bot_token)
);

-- Fast lookup by bot_token (used in every message handler)
CREATE INDEX IF NOT EXISTS idx_users_bot_token
  ON users(bot_token);

-- Needed for analytics / push-broadcast queries ("all users of salon X")
CREATE INDEX IF NOT EXISTS idx_users_salon_id
  ON users(salon_id) WHERE salon_id IS NOT NULL;

-- source_track analytics
CREATE INDEX IF NOT EXISTS idx_users_source_track
  ON users(source_track) WHERE source_track IS NOT NULL;


-- ─── USER STATES ─────────────────────────────────────────────────────────────
-- Conversation state machine per (user, bot).
-- temp_data: JSON blob holding in-flight data, e.g. {"selfie_url":"https://..."}
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_states (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT     NOT NULL,
  bot_token   TEXT     NOT NULL,
  state       TEXT     NOT NULL DEFAULT 'start',
  temp_data   TEXT     NOT NULL DEFAULT '{}',
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, bot_token)
);

-- The UNIQUE constraint already forces an index; name it for clarity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_states_lookup
  ON user_states(user_id, bot_token);


-- ─── PENDING JOBS ────────────────────────────────────────────────────────────
-- fal.ai async generation jobs waiting for a callback / cron poll.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_jobs (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT     UNIQUE NOT NULL,
  user_id     TEXT     NOT NULL,
  bot_token   TEXT     NOT NULL,
  chat_id     TEXT     NOT NULL,
  status_url  TEXT,
  response_url TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_bot_token
  ON pending_jobs(bot_token);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_created_at
  ON pending_jobs(created_at);


-- ─── PENDING APPLICATIONS ────────────────────────────────────────────────────
-- Salon owner sign-up requests waiting for admin approval.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_applications (
  id                INTEGER  PRIMARY KEY AUTOINCREMENT,
  applicant_chat_id TEXT     NOT NULL,
  bot_token         TEXT     NOT NULL,
  salon_name        TEXT     NOT NULL,
  salon_type        TEXT     NOT NULL,
  whatsapp_phone    TEXT     NOT NULL,
  max_images        INTEGER  NOT NULL DEFAULT 3,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
