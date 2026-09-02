#!/usr/bin/env python3
"""Create a deterministic, offline SQLite-to-D1/R2 migration package.

The package is deliberately not an uploader.  It contains D1 import SQL, a redacted
manifest, and staged R2 object bytes for a separately authorized upload step.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import shutil
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

from migration_safety import MigrationSafetyError, require_new_migration_output, sqlite_read_only
from PIL import Image, UnidentifiedImageError

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
SOURCE_COLUMNS = {
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
    "furniture_images": ("id", "furniture_id", "url", "alt_text", "is_primary"),
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
TARGET_COLUMNS = {
    **{table: columns for table, columns in SOURCE_COLUMNS.items() if table != "furniture_images"},
    "furniture_images": (
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
    ),
}
ID_COLUMNS = {
    "categories": ("id",),
    "sites": ("id",),
    "furniture": ("id", "category_id"),
    "furniture_images": ("id", "furniture_id"),
    "inventory": ("id", "furniture_id", "site_id"),
    "transfer_records": (
        "id",
        "furniture_id",
        "source_inventory_id",
        "source_site_id",
        "destination_site_id",
        "actor_token_id",
    ),
    "inventory_adjustments": ("id", "inventory_id", "transfer_id"),
    "audit_events": ("id", "entity_id"),
}


class MigrationError(MigrationSafetyError):
    """Raised when source data cannot safely be represented by the target."""


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def safe_identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or any(ord(char) < 32 for char in value):
        raise MigrationError(f"unsafe {label}: must be a non-empty printable string")
    if "/" in value or "\\" in value or value in {".", ".."} or ".." in value.split("/"):
        raise MigrationError(f"unsafe {label}: path separators are not allowed")
    return value


def validate_value(value: object, label: str) -> None:
    if isinstance(value, str) and "\x00" in value:
        raise MigrationError(f"unsafe {label}: NUL bytes are not allowed")
    if isinstance(value, float) and not math.isfinite(value):
        raise MigrationError(f"unsafe {label}: non-finite number")


def image_metadata(payload: bytes) -> tuple[str, int, int, str]:
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            mime_type = Image.MIME.get(image.format or "")
            width, height = image.size
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError) as error:
        raise MigrationError("invalid or unsupported image bytes") from error
    if mime_type not in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
        raise MigrationError("unsupported image bytes; stage PNG, JPEG, GIF, or WebP")
    if width <= 0 or height <= 0:
        raise MigrationError("invalid image dimensions")
    return mime_type, width, height, hashlib.sha256(payload).hexdigest()


def jpeg_dimensions(payload: bytes) -> tuple[str, int, int]:
    index = 2
    while index + 9 < len(payload):
        if payload[index] != 0xFF:
            index += 1
            continue
        while index < len(payload) and payload[index] == 0xFF:
            index += 1
        marker = payload[index]
        index += 1
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
            continue
        if index + 2 > len(payload):
            break
        length = int.from_bytes(payload[index : index + 2], "big")
        if length < 2 or index + length > len(payload):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            return (
                "image/jpeg",
                int.from_bytes(payload[index + 5 : index + 7], "big"),
                int.from_bytes(payload[index + 3 : index + 5], "big"),
            )
        index += length
    raise MigrationError("invalid JPEG bytes")


def webp_dimensions(payload: bytes) -> tuple[str, int, int]:
    chunk = payload[12:16]
    if chunk == b"VP8X" and len(payload) >= 30:
        return (
            "image/webp",
            int.from_bytes(payload[24:27], "little") + 1,
            int.from_bytes(payload[27:30], "little") + 1,
        )
    if chunk == b"VP8 " and len(payload) >= 30 and payload[23:26] == b"\x9d\x01\x2a":
        return (
            "image/webp",
            int.from_bytes(payload[26:28], "little") & 0x3FFF,
            int.from_bytes(payload[28:30], "little") & 0x3FFF,
        )
    if chunk == b"VP8L" and len(payload) >= 25:
        bits = int.from_bytes(payload[21:25], "little")
        return "image/webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise MigrationError("invalid WebP bytes")


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise MigrationError("unsafe non-finite number")
        return format(value, ".17g")
    if isinstance(value, str):
        validate_value(value, "SQL text")
        return "'" + value.replace("'", "''") + "'"
    raise MigrationError(f"unsupported SQLite value type: {type(value).__name__}")


def quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def read_required_tables(connection: sqlite3.Connection) -> dict[str, list[dict[str, object]]]:
    available = {
        row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    missing = set(TABLES) - available
    if missing:
        raise MigrationError(f"source is missing required tables: {', '.join(sorted(missing))}")
    records: dict[str, list[dict[str, object]]] = {}
    for table in TABLES:
        existing_columns = {
            row[1] for row in connection.execute(f"PRAGMA table_info({quote_ident(table)})")
        }
        missing_columns = set(SOURCE_COLUMNS[table]) - existing_columns
        if missing_columns:
            raise MigrationError(
                f"source {table} is missing columns: {', '.join(sorted(missing_columns))}"
            )
        records[table] = [
            dict(row)
            for row in connection.execute(f"SELECT * FROM {quote_ident(table)} ORDER BY id")
        ]
    return records


def validate_records(records: dict[str, list[dict[str, object]]]) -> None:
    for table, rows in records.items():
        for row in rows:
            for column, value in row.items():
                validate_value(value, f"{table}.{column}")
            for column in ID_COLUMNS[table]:
                if row[column] is not None:
                    safe_identifier(row[column], f"{table}.{column}")
    for table, column in (("furniture", "source_metadata"), ("audit_events", "details_json")):
        for row in records[table]:
            try:
                json.loads(row[column])
            except (TypeError, json.JSONDecodeError) as error:
                raise MigrationError(
                    f"malformed JSON in {table}.{column} for {row['id']}"
                ) from error
    inventory_by_id = {row["id"] for row in records["inventory"]}
    furniture_by_id = {row["id"] for row in records["furniture"]}
    site_by_id = {row["id"] for row in records["sites"]}
    for row in records["transfer_records"]:
        if row["furniture_id"] not in furniture_by_id:
            raise MigrationError(f"invalid transfer furniture FK: {row['id']}")
        if row["source_inventory_id"] not in inventory_by_id:
            raise MigrationError(f"invalid transfer inventory FK: {row['id']}")
        if row["source_site_id"] not in site_by_id or row["destination_site_id"] not in site_by_id:
            raise MigrationError(f"invalid transfer site FK: {row['id']}")
        listed = row["listed_quantity_before"]
        transferred = row["transferred_quantity"]
        remainder = row["unlisted_remainder"]
        if not all(isinstance(value, int) for value in (listed, transferred, remainder)):
            raise MigrationError(f"invalid transfer quantities: {row['id']}")
        if (
            listed <= 0
            or transferred <= 0
            or transferred > listed
            or remainder != listed - transferred
        ):
            raise MigrationError(f"inconsistent transfer quantities: {row['id']}")
    for row in records["inventory_adjustments"]:
        if row["inventory_id"] not in inventory_by_id:
            raise MigrationError(f"invalid inventory adjustment FK: {row['id']}")
    primary_counts = Counter(
        row["furniture_id"] for row in records["furniture_images"] if row["is_primary"]
    )
    if any(count > 1 for count in primary_counts.values()):
        raise MigrationError("source has more than one primary image for a furniture record")


def load_staging_manifest(path: Path | None, staging_root: Path | None) -> dict[str, Path]:
    if path is None:
        return {}
    if staging_root is None:
        raise MigrationError("--staging-root is required with --staging-manifest")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MigrationError(f"cannot read staging manifest: {path}") from error
    if not isinstance(raw, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in raw.items()
    ):
        raise MigrationError(
            "staging manifest must be a JSON object mapping image IDs to relative paths"
        )
    root = staging_root.resolve()
    resolved: dict[str, Path] = {}
    for image_id, relative in raw.items():
        safe_identifier(image_id, "staging image id")
        candidate = (root / PurePosixPath(relative)).resolve()
        if root not in candidate.parents or not candidate.is_file():
            raise MigrationError(f"staged image for {image_id} is absent or escapes --staging-root")
        resolved[image_id] = candidate
    return resolved


def local_asset_path(url: str, asset_root: Path) -> Path | None:
    parsed = urlsplit(url)
    if parsed.scheme or parsed.netloc:
        return None
    if parsed.query or parsed.fragment or not parsed.path.startswith("/"):
        raise MigrationError(f"unsafe local image URL: {url}")
    root = asset_root.resolve()
    candidate = (root / PurePosixPath(unquote(parsed.path).lstrip("/"))).resolve()
    if root not in candidate.parents or not candidate.is_file():
        raise MigrationError(f"local image does not exist below --asset-root: {url}")
    return candidate


def build_images(
    rows: list[dict[str, object]], asset_root: Path, staged: dict[str, Path]
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    target_rows: list[dict[str, object]] = []
    manifest_images: list[dict[str, object]] = []
    sort_orders: defaultdict[str, int] = defaultdict(int)
    for row in sorted(rows, key=lambda item: (item["furniture_id"], item["id"])):
        image_id = safe_identifier(row["id"], "furniture_images.id")
        furniture_id = safe_identifier(row["furniture_id"], "furniture_images.furniture_id")
        url = row["url"]
        if not isinstance(url, str):
            raise MigrationError(f"unsafe furniture_images.url for {image_id}")
        source = local_asset_path(url, asset_root)
        if source is None:
            source = staged.get(image_id)
            if source is None:
                raise MigrationError(
                    f"external image URL for {image_id}; pre-stage image {image_id} "
                    "and map it in --staging-manifest"
                )
        payload = source.read_bytes()
        mime_type, width, height, digest = image_metadata(payload)
        extension = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
        }[mime_type]
        object_key = f"furniture/{furniture_id}/images/{image_id}.{extension}"
        sort_order = sort_orders[furniture_id]
        sort_orders[furniture_id] += 1
        target_rows.append(
            {
                "id": image_id,
                "furniture_id": furniture_id,
                "object_key": object_key,
                "mime_type": mime_type,
                "byte_size": len(payload),
                "width": width,
                "height": height,
                "sha256": digest,
                "alt_text": row["alt_text"],
                "sort_order": sort_order,
                "is_primary": int(bool(row["is_primary"])),
                "created_at": "1970-01-01T00:00:00Z",
            }
        )
        manifest_images.append(
            {
                "id": image_id,
                "furniture_id": furniture_id,
                "object_key": object_key,
                "mime_type": mime_type,
                "byte_size": len(payload),
                "width": width,
                "height": height,
                "sha256": digest,
                "alt_text": row["alt_text"],
                "sort_order": sort_order,
                "is_primary": int(bool(row["is_primary"])),
                "created_at": "1970-01-01T00:00:00Z",
                "staged_path": f"r2/{object_key}",
                "_payload": payload,
            }
        )
    return target_rows, manifest_images


def make_sql(
    records: dict[str, list[dict[str, object]]], image_rows: list[dict[str, object]]
) -> str:
    lines: list[str] = []
    target_records = {**records, "furniture_images": image_rows}
    for table in TABLES:
        columns = TARGET_COLUMNS[table]
        for row in target_records[table]:
            values = ", ".join(sql_literal(row[column]) for column in columns)
            quoted_columns = ", ".join(quote_ident(column) for column in columns)
            lines.append(f"INSERT INTO {quote_ident(table)} ({quoted_columns}) VALUES ({values});")
    return "\n".join(lines) + "\n"


def export(
    source: Path,
    output: Path,
    asset_root: Path,
    staging_manifest: Path | None,
    staging_root: Path | None,
) -> None:
    output = require_new_migration_output(
        output,
        "migration output",
        (source, asset_root, *(item for item in (staging_manifest, staging_root) if item)),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with sqlite_read_only(source) as connection:
        records = read_required_tables(connection)
    validate_records(records)
    staged = load_staging_manifest(staging_manifest, staging_root)
    image_rows, manifest_images = build_images(records["furniture_images"], asset_root, staged)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    try:
        atomic_write_bytes(
            temporary / "d1-import.sql", make_sql(records, image_rows).encode("utf-8")
        )
        manifest = {
            "format": 1,
            "row_counts": {table: len(records[table]) for table in TABLES},
            "images": [
                {key: value for key, value in image.items() if key != "_payload"}
                for image in manifest_images
            ],
        }
        atomic_write_bytes(
            temporary / "manifest.json",
            (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
                "utf-8"
            ),
        )
        for image in manifest_images:
            destination = temporary / image["staged_path"]
            atomic_write_bytes(destination, image["_payload"])
        os.replace(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, required=True, help="legacy SQLite database; opened read-only"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="new ignored migration directory"
    )
    parser.add_argument(
        "--asset-root", type=Path, required=True, help="root permitted for local /media URLs"
    )
    parser.add_argument(
        "--staging-manifest",
        type=Path,
        help="JSON map of external image ID to a staged relative path",
    )
    parser.add_argument(
        "--staging-root", type=Path, help="root containing files named by --staging-manifest"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        export(args.source, args.output, args.asset_root, args.staging_manifest, args.staging_root)
    except (MigrationSafetyError, OSError, sqlite3.Error) as error:
        print(f"migration export failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
