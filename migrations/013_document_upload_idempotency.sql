ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS upload_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS upload_input_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_upload_input_hash_check'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_upload_input_hash_check
      CHECK (upload_input_hash IS NULL OR upload_input_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_upload_idempotency_pair_check'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_upload_idempotency_pair_check
      CHECK (
        (upload_idempotency_key IS NULL AND upload_input_hash IS NULL)
        OR (upload_idempotency_key IS NOT NULL AND upload_input_hash IS NOT NULL)
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS documents_upload_idempotency_idx
  ON documents(project_id, upload_idempotency_key)
  WHERE upload_idempotency_key IS NOT NULL;
