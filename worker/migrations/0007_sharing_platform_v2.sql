ALTER TABLE sites ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1
  CHECK (is_active IN (0, 1));
ALTER TABLE sites ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  CHECK (version >= 1);
ALTER TABLE sites ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE sites ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE sites
SET created_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE inventory ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'allocated', 'withdrawn'));
ALTER TABLE inventory ADD COLUMN closed_at TEXT;
ALTER TABLE inventory ADD COLUMN closed_reason TEXT;

UPDATE inventory
SET status = CASE WHEN quantity_available > 0 THEN 'active' ELSE 'withdrawn' END,
    closed_at = CASE WHEN quantity_available > 0 THEN NULL ELSE CURRENT_TIMESTAMP END,
    closed_reason = CASE WHEN quantity_available > 0 THEN NULL ELSE 'migration' END;

CREATE TABLE transfer_records (
  id TEXT PRIMARY KEY,
  furniture_id TEXT NOT NULL REFERENCES furniture(id) ON DELETE RESTRICT,
  source_inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
  source_site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  source_site_code_snapshot TEXT NOT NULL,
  source_site_name_snapshot TEXT NOT NULL,
  destination_site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  destination_site_code_snapshot TEXT NOT NULL,
  destination_site_name_snapshot TEXT NOT NULL,
  listed_quantity_before INTEGER NOT NULL CHECK (listed_quantity_before > 0),
  transferred_quantity INTEGER NOT NULL CHECK (
    transferred_quantity > 0 AND transferred_quantity <= listed_quantity_before
  ),
  unlisted_remainder INTEGER NOT NULL CHECK (
    unlisted_remainder = listed_quantity_before - transferred_quantity
  ),
  reason TEXT NOT NULL,
  actor_token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE RESTRICT,
  actor_label_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_public_listing
  ON inventory(status, quantity_available, furniture_id, site_id);
CREATE INDEX idx_sites_active_name
  ON sites(is_active, name, id);
CREATE INDEX idx_transfers_created
  ON transfer_records(created_at DESC, id DESC);
CREATE INDEX idx_transfers_furniture_created
  ON transfer_records(furniture_id, created_at DESC, id DESC);
CREATE INDEX idx_transfers_source_site_created
  ON transfer_records(source_site_id, created_at DESC, id DESC);
CREATE INDEX idx_transfers_destination_site_created
  ON transfer_records(destination_site_id, created_at DESC, id DESC);

CREATE TRIGGER transfer_records_immutable_update
BEFORE UPDATE ON transfer_records
BEGIN
  SELECT RAISE(ABORT, 'transfer records are immutable');
END;

CREATE TRIGGER transfer_records_immutable_delete
BEFORE DELETE ON transfer_records
BEGIN
  SELECT RAISE(ABORT, 'transfer records are immutable');
END;
