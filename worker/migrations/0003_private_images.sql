CREATE TABLE image_uploads (
  id TEXT PRIMARY KEY,
  furniture_id TEXT NOT NULL REFERENCES furniture(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  idempotency_key_hash TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token_id, furniture_id, idempotency_key_hash)
);

CREATE TABLE image_cleanup_jobs (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_image_uploads_expiry ON image_uploads(expires_at);
CREATE INDEX idx_image_cleanup_jobs_created ON image_cleanup_jobs(created_at);
