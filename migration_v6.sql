-- Beauty AI SaaS — Migration v6
-- Adds settings table for global key-value config (e.g. welcome photos).
--
-- Apply:
--   wrangler d1 execute beauty-ai-db --file=migration_v6.sql --remote

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
