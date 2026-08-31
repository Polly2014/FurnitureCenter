CREATE TABLE image_derivatives (
  image_id TEXT NOT NULL REFERENCES furniture_images(id) ON DELETE CASCADE,
  variant TEXT NOT NULL CHECK (variant IN ('thumbnail')),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (image_id, variant)
);

ALTER TABLE image_cleanup_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'completed'));
ALTER TABLE image_cleanup_jobs ADD COLUMN last_attempt_at TEXT;
ALTER TABLE image_cleanup_jobs ADD COLUMN completed_at TEXT;

CREATE INDEX idx_image_derivatives_image ON image_derivatives(image_id);
CREATE INDEX idx_image_cleanup_jobs_pending ON image_cleanup_jobs(status, created_at);
