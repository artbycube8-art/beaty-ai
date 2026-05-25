-- Beauty AI SaaS — Migration v4
-- Adds source_track to salons for B2B attribution tracking.
--
-- Apply:
--   wrangler d1 execute beauty-ai-db --file=migration_v4.sql --remote

ALTER TABLE salons ADD COLUMN source_track TEXT;

CREATE INDEX IF NOT EXISTS idx_salons_source_track
  ON salons(source_track) WHERE source_track IS NOT NULL;
