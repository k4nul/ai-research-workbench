ALTER TABLE mutation_receipts
  DROP CONSTRAINT IF EXISTS mutation_receipts_response_status_check;

ALTER TABLE mutation_receipts
  ADD CONSTRAINT mutation_receipts_response_status_check
  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 499);
