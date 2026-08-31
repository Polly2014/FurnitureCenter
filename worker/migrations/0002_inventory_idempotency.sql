CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token_id, operation, key_hash)
);

CREATE INDEX idx_idempotency_created_at ON idempotency_records(created_at);
