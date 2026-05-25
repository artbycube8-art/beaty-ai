-- Beauty AI SaaS — D1 Schema
-- Apply with: wrangler d1 execute beauty-ai-db --file=schema.sql

-- ─── SALONS ──────────────────────────────────────────────────────────────────
-- One row per Telegram bot / salon registration
CREATE TABLE IF NOT EXISTS salons (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  bot_token       TEXT     UNIQUE NOT NULL,
  salon_name      TEXT     NOT NULL,
  -- 'barber' | 'makeup' | 'nails'
  salon_type      TEXT     NOT NULL CHECK(salon_type IN ('barber', 'makeup', 'nails')),
  whatsapp_phone  TEXT     NOT NULL,   -- digits only, e.g. 77001234567
  admin_chat_id   TEXT     NOT NULL,   -- Telegram chat/user ID for admin notifications
  max_images      INTEGER  NOT NULL DEFAULT 3,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── USERS ───────────────────────────────────────────────────────────────────
-- One row per (Telegram user, bot) pair — tracks contact info and AI usage limit
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT     NOT NULL,   -- Telegram user_id (string)
  bot_token    TEXT     NOT NULL,
  phone        TEXT,
  name         TEXT,
  image_count  INTEGER  NOT NULL DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, bot_token)
);

-- ─── USER STATES ─────────────────────────────────────────────────────────────
-- Conversation state machine per (user, bot).
-- temp_data holds intermediate uploads as JSON, e.g. {"selfie_url":"https://..."}
CREATE TABLE IF NOT EXISTS user_states (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT     NOT NULL,
  bot_token   TEXT     NOT NULL,
  state       TEXT     NOT NULL DEFAULT 'start',
  temp_data   TEXT     NOT NULL DEFAULT '{}',
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, bot_token)
);

-- ─── PENDING APPLICATIONS ────────────────────────────────────────────────────
-- Salon owner applications waiting for admin approval
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

-- ─── EXAMPLE SALON INSERT ─────────────────────────────────────────────────────
-- Uncomment and edit to seed your first salon:
/*
INSERT OR IGNORE INTO salons (bot_token, salon_name, salon_type, whatsapp_phone, admin_chat_id, max_images)
VALUES
  ('123456789:AABBCCDDEEFFaabbccddeeff', 'Barber Shop Almaty',  'barber', '77001112233', '987654321', 3),
  ('987654321:ZZYYXXWWVVUUzzyyxxwwvvuu', 'Beauty Studio Astana', 'makeup', '77779998877', '111222333', 3),
  ('111222333:QQWWEERRTTYYqqwweerrttyy', 'Nail Bar Shymkent',   'nails',  '77055554433', '444555666', 3);
*/
