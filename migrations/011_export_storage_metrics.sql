ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS input_hash TEXT,
  ADD COLUMN IF NOT EXISTS persistence_status TEXT,
  ADD COLUMN IF NOT EXISTS sanitized_error TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

UPDATE project_exports
SET persistence_status = 'AVAILABLE'
WHERE persistence_status IS NULL;

ALTER TABLE project_exports
  ALTER COLUMN persistence_status SET DEFAULT 'AVAILABLE',
  ALTER COLUMN persistence_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_exports_input_hash_check'
      AND conrelid = 'project_exports'::regclass
  ) THEN
    ALTER TABLE project_exports
      ADD CONSTRAINT project_exports_input_hash_check
      CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_exports_persistence_status_check'
      AND conrelid = 'project_exports'::regclass
  ) THEN
    ALTER TABLE project_exports
      ADD CONSTRAINT project_exports_persistence_status_check
      CHECK (persistence_status IN ('UPLOADING', 'AVAILABLE', 'FAILED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_exports_duration_ms_check'
      AND conrelid = 'project_exports'::regclass
  ) THEN
    ALTER TABLE project_exports
      ADD CONSTRAINT project_exports_duration_ms_check
      CHECK (duration_ms IS NULL OR duration_ms >= 0);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_exports_input_once_idx
  ON project_exports(project_id, format, input_hash)
  WHERE input_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_exports_persistence_idx
  ON project_exports(persistence_status, created_at);
