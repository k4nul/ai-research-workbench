-- Migration 006 catalogued v0.1 export metadata but could not read legacy files to
-- prove that their bytes matched the recorded size and digest. Require a real
-- storage read before those catalog entries can be treated as verified.
UPDATE storage_objects
SET integrity_status = 'PENDING_VERIFICATION',
    last_error = 'Legacy export metadata requires byte-level integrity verification.',
    updated_at = NOW()
WHERE created_by = 'migration:006_document_storage'
  AND id LIKE 'legacy-export-%'
  AND legacy_storage_path IS NOT NULL
  AND integrity_status = 'VERIFIED';
