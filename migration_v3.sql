-- Beauty AI SaaS — Migration v3
-- Adds salon_id to pending_jobs for correct multi-salon delivery via Standard bot.
--
-- Apply:
--   wrangler d1 execute beauty-ai-db --file=migration_v3.sql --remote

ALTER TABLE pending_jobs ADD COLUMN salon_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_pending_jobs_salon_id
  ON pending_jobs(salon_id) WHERE salon_id IS NOT NULL;
