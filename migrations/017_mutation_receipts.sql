CREATE TABLE IF NOT EXISTS mutation_receipts (
  principal_scope TEXT NOT NULL,
  method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (principal_scope, method, request_path, idempotency_key),
  CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 299),
  CHECK (
    (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mutation_receipts_created_idx
  ON mutation_receipts(created_at);
