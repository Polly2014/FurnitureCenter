PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL
);

CREATE TABLE furniture (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT NOT NULL DEFAULT '',
  main_category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL,
  dimensions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  material TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  image_reference TEXT NOT NULL DEFAULT '',
  source_workbook TEXT NOT NULL DEFAULT '',
  source_sheet TEXT NOT NULL DEFAULT '',
  source_row INTEGER,
  source_metadata TEXT NOT NULL DEFAULT '{}',
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE furniture_images (
  id TEXT PRIMARY KEY,
  furniture_id TEXT NOT NULL REFERENCES furniture(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sha256 TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inventory (
  id TEXT PRIMARY KEY,
  furniture_id TEXT NOT NULL REFERENCES furniture(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  quantity_total INTEGER NOT NULL CHECK (quantity_total >= 0),
  quantity_available INTEGER NOT NULL CHECK (quantity_available >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (quantity_available <= quantity_total),
  UNIQUE (furniture_id, site_id)
);

CREATE TABLE inventory_adjustments (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  delta_total INTEGER NOT NULL,
  delta_available INTEGER NOT NULL,
  quantity_total_before INTEGER NOT NULL CHECK (quantity_total_before >= 0),
  quantity_total_after INTEGER NOT NULL CHECK (quantity_total_after >= 0),
  quantity_available_before INTEGER NOT NULL CHECK (quantity_available_before >= 0),
  quantity_available_after INTEGER NOT NULL CHECK (quantity_available_after >= 0),
  transfer_id TEXT,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (quantity_available_before <= quantity_total_before),
  CHECK (quantity_available_after <= quantity_total_after)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL,
  daily_quota INTEGER CHECK (daily_quota IS NULL OR daily_quota > 0),
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_categories_name ON categories(name);
CREATE UNIQUE INDEX idx_sites_code ON sites(code);
CREATE INDEX idx_furniture_name ON furniture(name);
CREATE INDEX idx_furniture_category_id ON furniture(category_id);
CREATE INDEX idx_furniture_main_category ON furniture(main_category);
CREATE INDEX idx_images_furniture_order ON furniture_images(furniture_id, sort_order, id);
CREATE UNIQUE INDEX idx_images_one_primary
  ON furniture_images(furniture_id) WHERE is_primary = 1;
CREATE INDEX idx_inventory_furniture_id ON inventory(furniture_id);
CREATE INDEX idx_inventory_site_id ON inventory(site_id);
CREATE INDEX idx_adjustments_inventory_created
  ON inventory_adjustments(inventory_id, created_at DESC);
CREATE INDEX idx_adjustments_transfer_id ON inventory_adjustments(transfer_id);
CREATE INDEX idx_audit_entity_created
  ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_access_tokens_active ON access_tokens(role, revoked_at, expires_at);
CREATE INDEX idx_sessions_token_id ON sessions(token_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
