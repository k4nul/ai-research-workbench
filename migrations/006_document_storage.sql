CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('LOCAL', 'S3')),
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_filename TEXT,
  sanitized_filename TEXT,
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  integrity_status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (integrity_status IN ('PENDING_VERIFICATION', 'VERIFIED', 'MISMATCH', 'MISSING')),
  upload_status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (upload_status IN ('UPLOADING', 'AVAILABLE', 'FAILED', 'DELETED')),
  scan_status TEXT NOT NULL DEFAULT 'UNSCANNED'
    CHECK (scan_status IN ('UNSCANNED', 'CLEAN', 'INFECTED', 'ERROR', 'TIMEOUT')),
  extraction_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
    CHECK (extraction_status IN (
      'NOT_REQUESTED', 'PENDING', 'READY', 'FAILED', 'OCR_REQUIRED_UNSUPPORTED'
    )),
  retention_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (retention_status IN ('ACTIVE', 'PENDING_DELETE', 'DELETED', 'LEGAL_HOLD')),
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_by TEXT,
  legacy_storage_path TEXT,
  delete_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delete_attempts >= 0),
  cleanup_lease_owner TEXT,
  cleanup_lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, bucket, object_key),
  CHECK (integrity_status <> 'VERIFIED' OR (sha256 IS NOT NULL AND byte_size IS NOT NULL))
);

ALTER TABLE storage_objects
  ADD COLUMN IF NOT EXISTS cleanup_lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS cleanup_lease_expires_at TIMESTAMPTZ;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS storage_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL;

ALTER TABLE project_exports
  ADD COLUMN IF NOT EXISTS storage_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  raw_object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'UPLOADING'
    CHECK (status IN (
      'UPLOADING', 'QUARANTINED', 'SCANNING', 'REJECTED', 'CLEAN', 'EXTRACTING',
      'READY', 'EXTRACTION_FAILED', 'OCR_REQUIRED_UNSUPPORTED',
      'BLOCKED_SCANNER_UNAVAILABLE', 'DELETED'
    )),
  state_reason TEXT,
  scan_bypassed BOOLEAN NOT NULL DEFAULT FALSE,
  current_extraction_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (source_id)
);

CREATE TABLE IF NOT EXISTS document_scan_results (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
  object_sha256 TEXT NOT NULL CHECK (object_sha256 ~ '^[0-9a-f]{64}$'),
  scanner TEXT NOT NULL,
  scanner_version TEXT,
  signature_database_version TEXT,
  result TEXT NOT NULL CHECK (result IN ('CLEAN', 'INFECTED', 'ERROR', 'TIMEOUT', 'UNSCANNED')),
  detected_name TEXT,
  sanitized_error TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  extractor_name TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED', 'OCR_REQUIRED_UNSUPPORTED')),
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  language TEXT,
  page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  extraction_confidence TEXT NOT NULL DEFAULT 'HIGH'
    CHECK (extraction_confidence IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sanitized_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'documents_current_extraction_fk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_current_extraction_fk
      FOREIGN KEY (current_extraction_id) REFERENCES document_extractions(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS document_blocks (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  block_kind TEXT NOT NULL CHECK (block_kind IN ('HEADING', 'PARAGRAPH', 'TABLE', 'FOOTNOTE', 'PAGE')),
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  section_path TEXT,
  paragraph_index INTEGER CHECK (paragraph_index IS NULL OR paragraph_index >= 0),
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  stable_anchor TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  extraction_confidence TEXT NOT NULL DEFAULT 'HIGH'
    CHECK (extraction_confidence IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (extraction_id, ordinal),
  UNIQUE (extraction_id, stable_anchor)
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  stable_chunk_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  start_block_id TEXT REFERENCES document_blocks(id) ON DELETE SET NULL,
  end_block_id TEXT REFERENCES document_blocks(id) ON DELETE SET NULL,
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  section_path TEXT,
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  chunker_version TEXT NOT NULL,
  prompt_injection_flag BOOLEAN NOT NULL DEFAULT FALSE,
  security_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (extraction_id, ordinal),
  UNIQUE (extraction_id, stable_chunk_id)
);

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS stable_chunk_id TEXT;

UPDATE document_chunks
SET stable_chunk_id = id
WHERE stable_chunk_id IS NULL;

ALTER TABLE document_chunks
  ALTER COLUMN stable_chunk_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_extraction_stable_idx
  ON document_chunks(extraction_id, stable_chunk_id);

CREATE TABLE IF NOT EXISTS citation_anchors (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_id TEXT NOT NULL REFERENCES document_extractions(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  section_path TEXT,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'CURRENT' CHECK (status IN ('CURRENT', 'STALE', 'NEEDS_REVIEW')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, extraction_id, chunk_id, start_offset, end_offset)
);

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chunk_id TEXT REFERENCES document_chunks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS citation_anchor_id TEXT REFERENCES citation_anchors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS citation_status TEXT NOT NULL DEFAULT 'LEGACY'
    CHECK (citation_status IN ('LEGACY', 'CURRENT', 'STALE', 'NEEDS_REVIEW'));

CREATE INDEX IF NOT EXISTS storage_objects_project_idx
  ON storage_objects(project_id, retention_status, created_at);
CREATE INDEX IF NOT EXISTS storage_objects_cleanup_idx
  ON storage_objects(retention_status, updated_at) WHERE retention_status = 'PENDING_DELETE';
CREATE INDEX IF NOT EXISTS documents_project_status_idx
  ON documents(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS document_scans_document_idx
  ON document_scan_results(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_extractions_document_idx
  ON document_extractions(document_id, version DESC);
CREATE INDEX IF NOT EXISTS document_blocks_extraction_idx
  ON document_blocks(extraction_id, ordinal);
CREATE INDEX IF NOT EXISTS document_chunks_extraction_idx
  ON document_chunks(extraction_id, ordinal);
CREATE INDEX IF NOT EXISTS citation_anchors_source_status_idx
  ON citation_anchors(source_id, status);

INSERT INTO storage_objects (
  id, provider, bucket, object_key, content_type, original_filename, sanitized_filename,
  byte_size, integrity_status, upload_status, project_id, source_id, created_by,
  legacy_storage_path, uploaded_at, created_at, updated_at
)
SELECT
  'legacy-source-' || s.id,
  'LOCAL',
  'private',
  'legacy/uploads/' || s.id,
  COALESCE(NULLIF(s.mime_type, ''), 'application/octet-stream'),
  NULLIF(s.fetch_metadata ->> 'originalFilename', ''),
  NULLIF(s.fetch_metadata ->> 'safeFilename', ''),
  CASE
    WHEN COALESCE(s.fetch_metadata ->> 'size', '') ~ '^[0-9]+$'
      THEN (s.fetch_metadata ->> 'size')::BIGINT
    ELSE NULL
  END,
  'PENDING_VERIFICATION',
  'AVAILABLE',
  s.project_id,
  s.id,
  'migration:006_document_storage',
  s.fetch_metadata ->> 'storagePath',
  s.created_at,
  s.created_at,
  NOW()
FROM sources s
WHERE NULLIF(s.fetch_metadata ->> 'storagePath', '') IS NOT NULL
ON CONFLICT (id) DO NOTHING;

UPDATE sources s
SET storage_object_id = o.id
FROM storage_objects o
WHERE o.id = 'legacy-source-' || s.id
  AND s.storage_object_id IS NULL;

INSERT INTO storage_objects (
  id, provider, bucket, object_key, content_type, original_filename, sanitized_filename,
  byte_size, sha256, integrity_status, upload_status, project_id, created_by,
  legacy_storage_path, uploaded_at, created_at, updated_at
)
SELECT
  'legacy-export-' || e.id,
  'LOCAL',
  'private',
  'legacy/exports/' || e.id,
  CASE e.format
    WHEN 'MARKDOWN' THEN 'text/markdown; charset=utf-8'
    WHEN 'HTML' THEN 'text/html; charset=utf-8'
    WHEN 'PDF' THEN 'application/pdf'
    WHEN 'DOCX' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    WHEN 'CSV' THEN 'text/csv; charset=utf-8'
    WHEN 'ZIP' THEN 'application/zip'
  END,
  'legacy-' || lower(e.format),
  'legacy-' || lower(e.format),
  CASE WHEN e.byte_size >= 0 THEN e.byte_size ELSE NULL END,
  CASE WHEN lower(e.sha256) ~ '^[0-9a-f]{64}$' THEN lower(e.sha256) ELSE NULL END,
  CASE
    WHEN e.byte_size >= 0 AND lower(e.sha256) ~ '^[0-9a-f]{64}$' THEN 'VERIFIED'
    ELSE 'PENDING_VERIFICATION'
  END,
  'AVAILABLE',
  e.project_id,
  'migration:006_document_storage',
  e.storage_path,
  e.created_at,
  e.created_at,
  NOW()
FROM project_exports e
ON CONFLICT (id) DO NOTHING;

UPDATE project_exports e
SET storage_object_id = o.id
FROM storage_objects o
WHERE o.id = 'legacy-export-' || e.id
  AND e.storage_object_id IS NULL;
