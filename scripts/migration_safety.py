"""Shared filesystem and SQLite boundaries for offline migration tools."""

from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path


class MigrationSafetyError(ValueError):
    """Raised when a migration tool would cross its approved filesystem boundary."""


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
APPROVED_OUTPUT_ROOTS = (
    REPOSITORY_ROOT / ".migration",
    REPOSITORY_ROOT / "migration-output",
)


def sqlite_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise MigrationSafetyError(f"SQLite database does not exist: {path}")
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def path_overlaps(first: Path, second: Path) -> bool:
    first_resolved = first.resolve(strict=False)
    second_resolved = second.resolve(strict=False)
    if first.exists() and second.exists() and os.path.samefile(first, second):
        return True
    return (
        first_resolved == second_resolved
        or first_resolved in second_resolved.parents
        or second_resolved in first_resolved.parents
    )


def reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.absolute().parts[1:]:
        current /= part
        if not current.exists() and not current.is_symlink():
            break
        if current.is_symlink():
            raise MigrationSafetyError(f"migration path contains a symlink: {current}")


def is_git_ignored(path: Path) -> bool:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(REPOSITORY_ROOT),
            "check-ignore",
            "--quiet",
            "--no-index",
            "--",
            str(path),
        ],
        check=False,
        capture_output=True,
    )
    return result.returncode == 0


def is_git_tracked(path: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(REPOSITORY_ROOT), "ls-files", "--error-unmatch", "--", str(path)],
        check=False,
        capture_output=True,
    )
    return result.returncode == 0


def require_new_migration_output(path: Path, label: str, inputs: tuple[Path, ...] = ()) -> Path:
    requested = path.absolute()
    allowed_root = next(
        (root for root in APPROVED_OUTPUT_ROOTS if requested.is_relative_to(root.absolute())), None
    )
    if allowed_root is None or not is_git_ignored(requested):
        raise MigrationSafetyError(f"{label} must be inside a Git-ignored migration output root")
    reject_symlink_components(allowed_root)
    reject_symlink_components(requested)
    if not requested.resolve(strict=False).is_relative_to(allowed_root.resolve(strict=False)):
        raise MigrationSafetyError(f"{label} escapes its approved migration output root")
    if is_git_tracked(requested):
        raise MigrationSafetyError(
            f"{label} is a tracked path and will not be replaced: {requested}"
        )
    if requested.exists() or requested.is_symlink():
        raise MigrationSafetyError(f"{label} already exists and will not be replaced: {requested}")
    for input_path in inputs:
        if path_overlaps(requested, input_path):
            raise MigrationSafetyError(f"{label} collides with an input: {input_path}")
    return requested
