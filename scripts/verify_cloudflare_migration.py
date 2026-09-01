#!/usr/bin/env python3
"""Reconcile a redacted migration package with a local D1/R2 emulation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path, PurePosixPath

from migration_safety import MigrationSafetyError, require_new_migration_output, sqlite_read_only

TABLES = (
    "categories",
    "sites",
    "furniture",
    "furniture_images",
    "inventory",
    "transfer_records",
    "inventory_adjustments",
    "audit_events",
)


def atomic_write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, encoding="utf-8", delete=False
    ) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def row_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
        for table in TABLES
    }


def positions(connection: sqlite3.Connection) -> list[tuple[object, ...]]:
    return [
        tuple(row)
        for row in connection.execute(
            "SELECT furniture_id, site_id, quantity_total, quantity_available, version "
            "FROM inventory ORDER BY furniture_id, site_id"
        )
    ]


def canonical_rows(
    connection: sqlite3.Connection, table: str, columns: tuple[str, ...]
) -> list[dict[str, object]]:
    quoted_columns = ", ".join(f'"{column}"' for column in columns)
    return [
        dict(row)
        for row in connection.execute(f'SELECT {quoted_columns} FROM "{table}" ORDER BY "id"')
    ]


def safe_object_path(root: Path, object_key: str) -> Path | None:
    key = PurePosixPath(object_key)
    if key.is_absolute() or ".." in key.parts:
        return None
    candidate = (root / key).resolve()
    resolved_root = root.resolve()
    return candidate if resolved_root in candidate.parents else None


def verify(source: Path, export_dir: Path, target: Path, r2_dir: Path) -> dict[str, object]:
    report: dict[str, object] = {
        "format": 1,
        "ok": False,
        "row_counts": {},
        "inventory_positions": 0,
        "foreign_key_violations": [],
        "image_checks": [],
        "mismatches": [],
    }
    mismatches: list[str] = report["mismatches"]  # type: ignore[assignment]
    try:
        manifest = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("format") != 1:
            raise ValueError("unsupported or malformed migration manifest")
        with sqlite_read_only(source) as source_db, sqlite_read_only(target) as target_db:
            source_counts = row_counts(source_db)
            target_counts = row_counts(target_db)
            expected_counts = manifest.get("row_counts")
            report["row_counts"] = {
                "source": source_counts,
                "export": expected_counts,
                "target": target_counts,
            }
            if source_counts != expected_counts:
                mismatches.append("source row counts do not match exported manifest")
            if target_counts != expected_counts:
                mismatches.append("target row counts do not match exported manifest")
            source_columns = {
                "categories": ("id", "name"),
                "sites": (
                    "id",
                    "code",
                    "name",
                    "city",
                    "latitude",
                    "longitude",
                    "is_active",
                    "version",
                    "created_at",
                    "updated_at",
                ),
                "furniture": (
                    "id",
                    "sku",
                    "name",
                    "name_en",
                    "main_category",
                    "description",
                    "condition",
                    "dimensions",
                    "color",
                    "material",
                    "brand",
                    "image_reference",
                    "source_workbook",
                    "source_sheet",
                    "source_row",
                    "source_metadata",
                    "category_id",
                    "created_at",
                    "updated_at",
                ),
                "inventory": (
                    "id",
                    "furniture_id",
                    "site_id",
                    "quantity_total",
                    "quantity_available",
                    "version",
                    "status",
                    "closed_at",
                    "closed_reason",
                ),
                "transfer_records": (
                    "id",
                    "furniture_id",
                    "source_inventory_id",
                    "source_site_id",
                    "source_site_code_snapshot",
                    "source_site_name_snapshot",
                    "destination_site_id",
                    "destination_site_code_snapshot",
                    "destination_site_name_snapshot",
                    "listed_quantity_before",
                    "transferred_quantity",
                    "unlisted_remainder",
                    "reason",
                    "actor_token_id",
                    "actor_label_snapshot",
                    "created_at",
                ),
                "inventory_adjustments": (
                    "id",
                    "inventory_id",
                    "kind",
                    "delta_total",
                    "delta_available",
                    "quantity_total_before",
                    "quantity_total_after",
                    "quantity_available_before",
                    "quantity_available_after",
                    "transfer_id",
                    "reason",
                    "actor",
                    "created_at",
                ),
                "audit_events": (
                    "id",
                    "entity_type",
                    "entity_id",
                    "action",
                    "actor",
                    "details_json",
                    "created_at",
                ),
            }
            for table, columns in source_columns.items():
                if canonical_rows(source_db, table, columns) != canonical_rows(
                    target_db, table, columns
                ):
                    mismatches.append(table)
            source_positions = positions(source_db)
            target_positions = positions(target_db)
            report["inventory_positions"] = len(source_positions)
            if source_positions != target_positions:
                mismatches.append(
                    "inventory positions differ: furniture/site total/available/version mismatch"
                )
            foreign_keys = [list(row) for row in target_db.execute("PRAGMA foreign_key_check")]
            report["foreign_key_violations"] = foreign_keys
            if foreign_keys:
                mismatches.append("target foreign key violations found")
            target_images = {
                row["id"]: dict(row)
                for row in target_db.execute(
                    "SELECT id, furniture_id, object_key, mime_type, byte_size, width, height, "
                    "sha256, "
                    "alt_text, sort_order, is_primary, created_at "
                    "FROM furniture_images"
                )
            }
        images = manifest.get("images")
        if not isinstance(images, list):
            raise ValueError("manifest images must be a list")
        for image in images:
            if not isinstance(image, dict):
                raise ValueError("manifest image must be an object")
            image_id = image.get("id")
            object_key = image.get("object_key")
            if not isinstance(image_id, str) or not isinstance(object_key, str):
                raise ValueError("manifest image ID/object key is invalid")
            target_image = target_images.pop(image_id, None)
            check: dict[str, object] = {"id": image_id, "ok": True}
            image_columns = (
                "id",
                "furniture_id",
                "object_key",
                "mime_type",
                "byte_size",
                "width",
                "height",
                "sha256",
                "alt_text",
                "sort_order",
                "is_primary",
                "created_at",
            )
            if target_image is None or any(
                target_image.get(key) != image.get(key) for key in image_columns
            ):
                check["ok"] = False
                mismatches.append(f"image {image_id} target metadata mismatch")
            path = safe_object_path(r2_dir, object_key)
            if path is None or not path.is_file():
                check["ok"] = False
                mismatches.append(f"image {image_id} R2 object is missing")
            else:
                payload = path.read_bytes()
                check["byte_size"] = len(payload)
                check["sha256"] = hashlib.sha256(payload).hexdigest()
                if check["byte_size"] != image.get("byte_size") or check["sha256"] != image.get(
                    "sha256"
                ):
                    check["ok"] = False
                    mismatches.append(f"image {image_id} byte count or SHA-256 mismatch")
            report["image_checks"].append(check)  # type: ignore[union-attr]
        if target_images:
            mismatches.append("target contains images absent from exported manifest")
    except (OSError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
        mismatches.append(f"verification input error: {error}")
    report["ok"] = not mismatches
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--export", dest="export_dir", type=Path, required=True)
    parser.add_argument(
        "--target", type=Path, required=True, help="read-only local D1 SQLite emulation"
    )
    parser.add_argument("--r2-dir", type=Path, required=True, help="local staged R2 object root")
    parser.add_argument("--report", type=Path, required=True, help="redacted JSON result")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        args.report = require_new_migration_output(
            args.report,
            "reconciliation report",
            (args.source, args.export_dir, args.target, args.r2_dir),
        )
        report = verify(args.source, args.export_dir, args.target, args.r2_dir)
        atomic_write_json(args.report, report)
    except (MigrationSafetyError, OSError) as error:
        print(f"migration verification failed: {error}", file=sys.stderr)
        return 1
    if not report["ok"]:
        print("migration verification failed; see the redacted report", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
