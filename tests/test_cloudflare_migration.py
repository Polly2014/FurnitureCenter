"""Black-box contracts for the SQLite-to-D1/R2 migration tools."""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
EXPORTER = PROJECT_ROOT / "scripts" / "export_sqlite_for_d1.py"
VERIFIER = PROJECT_ROOT / "scripts" / "verify_cloudflare_migration.py"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNg+M8AAAICAQB7CY1FAAAAAElFTkSuQmCC"
)


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=PROJECT_ROOT,
        text=True,
        capture_output=True,
        check=check,
    )


def create_source_db(path: Path, image_url: str = "/media/chair.png") -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE sites (
          id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, city TEXT NOT NULL,
          latitude REAL NOT NULL, longitude REAL NOT NULL
        );
        CREATE TABLE furniture (
          id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, name_en TEXT NOT NULL,
          main_category TEXT NOT NULL, description TEXT NOT NULL, condition TEXT NOT NULL,
          dimensions TEXT NOT NULL, color TEXT NOT NULL, material TEXT NOT NULL,
          brand TEXT NOT NULL, image_reference TEXT NOT NULL, source_workbook TEXT NOT NULL,
          source_sheet TEXT NOT NULL, source_row INTEGER, source_metadata TEXT NOT NULL,
          category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE furniture_images (
          id TEXT PRIMARY KEY, furniture_id TEXT NOT NULL, url TEXT NOT NULL,
          alt_text TEXT NOT NULL, is_primary INTEGER NOT NULL
        );
        CREATE TABLE inventory (
          id TEXT PRIMARY KEY, furniture_id TEXT NOT NULL, site_id TEXT NOT NULL,
          quantity_total INTEGER NOT NULL, quantity_available INTEGER NOT NULL,
          version INTEGER NOT NULL
        );
        CREATE TABLE inventory_adjustments (
          id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL, delta INTEGER NOT NULL,
          kind TEXT NOT NULL, delta_total INTEGER NOT NULL, delta_available INTEGER NOT NULL,
          quantity_total_before INTEGER NOT NULL, quantity_total_after INTEGER NOT NULL,
          quantity_available_before INTEGER NOT NULL, quantity_available_after INTEGER NOT NULL,
          transfer_id TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
          action TEXT NOT NULL, actor TEXT NOT NULL, details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE access_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, session_hash TEXT NOT NULL);
        """
    )
    connection.executescript(
        """
        INSERT INTO categories VALUES ('cat-1', 'Seating');
        INSERT INTO sites VALUES ('site-bj', 'BJ', 'Beijing', 'Beijing', 39.9, 116.4);
        INSERT INTO sites VALUES ('site-sh', 'SH', 'Shanghai', 'Shanghai', 31.2, 121.5);
        INSERT INTO furniture VALUES (
          'fur-1', 'SKU-1', 'O''Brien Chair', '', 'Seating', 'A ''quoted'' chair', 'good',
          '', '', '', '', '', 'workbook.xlsx', 'Sheet1', 7, '{}', 'cat-1',
          '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z'
        );
        INSERT INTO furniture_images VALUES ('img-1', 'fur-1', '/placeholder', 'Primary chair', 1);
        INSERT INTO inventory VALUES ('inv-bj', 'fur-1', 'site-bj', 18, 12, 3);
        INSERT INTO inventory VALUES ('inv-sh', 'fur-1', 'site-sh', 8, 4, 2);
        INSERT INTO inventory_adjustments VALUES (
          'adj-1', 'inv-bj', 0, 'correction', 2, 1, 16, 18, 11, 12, NULL,
          'initial import', 'migration', '2026-01-02T03:04:05Z'
        );
        INSERT INTO audit_events VALUES (
          'audit-1', 'inventory', 'inv-bj', 'adjusted', 'migration',
          '{"reason":"initial import"}', '2026-01-02T03:04:05Z'
        );
        INSERT INTO access_tokens VALUES ('token-1', 'must-not-export');
        INSERT INTO sessions VALUES ('session-1', 'must-not-export');
        """
    )
    connection.execute("UPDATE furniture_images SET url = ?", (image_url,))
    connection.commit()
    connection.close()


def apply_target_schema(path: Path) -> None:
    connection = sqlite3.connect(path)
    for migration in sorted((PROJECT_ROOT / "worker" / "migrations").glob("*.sql")):
        connection.executescript(migration.read_text())
    connection.close()


def export_fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    source = tmp_path / "source.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    (asset_root / "media").mkdir()
    (asset_root / "media" / "chair.png").write_bytes(PNG_BYTES)
    create_source_db(source)
    output = tmp_path / "migration-output"
    run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(output),
        "--asset-root",
        str(asset_root),
    )
    return source, output, asset_root


def test_export_is_deterministic_escaped_and_excludes_credentials(tmp_path: Path) -> None:
    """A wrongly ordered or unsafe exporter would change SQL or leak token rows."""
    source, output, asset_root = export_fixture(tmp_path)
    second_output = tmp_path / "migration-output-2"
    run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(second_output),
        "--asset-root",
        str(asset_root),
    )

    sql = (output / "d1-import.sql").read_text()
    manifest = json.loads((output / "manifest.json").read_text())
    assert (second_output / "d1-import.sql").read_bytes() == (output / "d1-import.sql").read_bytes()
    assert sql.index('INSERT INTO "categories"') < sql.index('INSERT INTO "furniture"')
    assert sql.index('INSERT INTO "furniture"') < sql.index('INSERT INTO "furniture_images"')
    assert sql.index('INSERT INTO "inventory"') < sql.index('INSERT INTO "inventory_adjustments"')
    assert "O''Brien Chair" in sql
    assert "must-not-export" not in sql
    assert "access_tokens" not in sql
    assert manifest["row_counts"] == {
        "audit_events": 1,
        "categories": 1,
        "furniture": 1,
        "furniture_images": 1,
        "inventory": 2,
        "inventory_adjustments": 1,
        "sites": 2,
    }
    image = manifest["images"][0]
    assert image["object_key"] == "furniture/fur-1/images/img-1.png"
    assert image["mime_type"] == "image/png"
    assert image["byte_size"] == len(PNG_BYTES)
    assert image["sha256"] == hashlib.sha256(PNG_BYTES).hexdigest()
    assert image["width"] == image["height"] == 1
    assert (output / "r2" / image["object_key"]).read_bytes() == PNG_BYTES


def test_export_requires_explicit_staging_for_external_image_urls(tmp_path: Path) -> None:
    """A network-fetch fallback would make a migration non-deterministic and unsafe."""
    source = tmp_path / "source.db"
    create_source_db(source, "https://images.example.test/chair.png")
    result = run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(tmp_path / "output"),
        "--asset-root",
        str(tmp_path / "assets"),
        check=False,
    )
    assert result.returncode != 0
    assert "pre-stage image img-1" in result.stderr


def test_export_uses_explicitly_staged_external_image_bytes(tmp_path: Path) -> None:
    """A staged external image must become the bytes and metadata in the package."""
    source = tmp_path / "source.db"
    create_source_db(source, "https://images.example.test/chair.png")
    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    staging_root = tmp_path / "staging"
    staging_root.mkdir()
    (staging_root / "chair.png").write_bytes(PNG_BYTES)
    staging_manifest = tmp_path / "staging.json"
    staging_manifest.write_text(json.dumps({"img-1": "chair.png"}))
    output = tmp_path / "output"

    run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(output),
        "--asset-root",
        str(asset_root),
        "--staging-root",
        str(staging_root),
        "--staging-manifest",
        str(staging_manifest),
    )

    image = json.loads((output / "manifest.json").read_text())["images"][0]
    assert (output / image["staged_path"]).read_bytes() == PNG_BYTES


def test_export_creates_the_requested_ignored_output_parent(tmp_path: Path) -> None:
    """A fresh dedicated output directory must not require a manual pre-creation step."""
    source = tmp_path / "source.db"
    asset_root = tmp_path / "assets"
    (asset_root / "media").mkdir(parents=True)
    (asset_root / "media" / "chair.png").write_bytes(PNG_BYTES)
    create_source_db(source)
    output = tmp_path / "ignored-migrations" / "one"

    run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(output),
        "--asset-root",
        str(asset_root),
    )

    assert (output / "d1-import.sql").is_file()


def test_verifier_reconciles_target_and_rejects_image_or_inventory_mismatches(
    tmp_path: Path,
) -> None:
    """A verifier that overlooks a changed object or position must fail the migration."""
    source, output, _ = export_fixture(tmp_path)
    target = tmp_path / "target.db"
    apply_target_schema(target)
    with sqlite3.connect(target) as connection:
        connection.executescript((output / "d1-import.sql").read_text())

    report = tmp_path / "reconciliation.json"
    success = run(
        str(VERIFIER),
        "--source",
        str(source),
        "--export",
        str(output),
        "--target",
        str(target),
        "--r2-dir",
        str(output / "r2"),
        "--report",
        str(report),
    )
    assert success.returncode == 0
    verified = json.loads(report.read_text())
    assert verified["ok"] is True
    assert verified["inventory_positions"] == 2
    assert verified["foreign_key_violations"] == []
    assert "must-not-export" not in report.read_text()

    (output / "r2" / "furniture" / "fur-1" / "images" / "img-1.png").write_bytes(b"changed")
    with sqlite3.connect(target) as connection:
        connection.execute("UPDATE inventory SET quantity_available = 11 WHERE id = 'inv-bj'")
        connection.commit()
    failed_report = tmp_path / "failed-reconciliation.json"
    failure = run(
        str(VERIFIER),
        "--source",
        str(source),
        "--export",
        str(output),
        "--target",
        str(target),
        "--r2-dir",
        str(output / "r2"),
        "--report",
        str(failed_report),
        check=False,
    )
    assert failure.returncode != 0
    failed = json.loads(failed_report.read_text())
    assert failed["ok"] is False
    assert any("inventory" in item for item in failed["mismatches"])
    assert any("image img-1" in item for item in failed["mismatches"])


@pytest.mark.parametrize("unsafe_value", ["bad\x00value", "../escape"])
def test_export_rejects_unsafe_identifiers(tmp_path: Path, unsafe_value: str) -> None:
    """Unsafe identifiers could escape a target object key or make invalid D1 data."""
    source = tmp_path / "source.db"
    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    (asset_root / "media").mkdir()
    (asset_root / "media" / "chair.png").write_bytes(PNG_BYTES)
    create_source_db(source)
    with sqlite3.connect(source) as connection:
        connection.execute("UPDATE furniture_images SET id = ?", (unsafe_value,))
        connection.commit()
    result = run(
        str(EXPORTER),
        "--source",
        str(source),
        "--output",
        str(tmp_path / "output"),
        "--asset-root",
        str(asset_root),
        check=False,
    )
    assert result.returncode != 0
    assert "unsafe" in result.stderr.lower()
