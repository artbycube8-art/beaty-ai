-- Beauty AI SaaS — Migration v5
-- Adds admins table for multi-admin support managed via the admin panel.
-- The primary admin (ADMIN_USER_ID env var) is always an admin regardless of this table.
--
-- Apply:
--   wrangler d1 execute beauty-ai-db --file=migration_v5.sql --remote

CREATE TABLE IF NOT EXISTS admins (
  user_id TEXT PRIMARY KEY,
  added_at TEXT DEFAULT (datetime('now'))
);
