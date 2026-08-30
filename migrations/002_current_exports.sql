ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN;

UPDATE project_exports
SET is_current = FALSE
WHERE is_current IS NULL;

ALTER TABLE project_exports
  ALTER COLUMN is_current SET DEFAULT TRUE,
  ALTER COLUMN is_current SET NOT NULL;

CREATE INDEX IF NOT EXISTS project_exports_current_idx
  ON project_exports(project_id, format, is_current, created_at DESC);
