ALTER TABLE document_extractions
  ADD COLUMN IF NOT EXISTS artifact_object_id TEXT
    REFERENCES storage_objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS document_extractions_artifact_idx
  ON document_extractions(artifact_object_id)
  WHERE artifact_object_id IS NOT NULL;
