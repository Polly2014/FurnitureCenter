"""Create the authorized, local-only credentials for FurnitureCenter preview."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

VARIABLES = (
    "FC_PREVIEW_VIEWER_TOKEN",
    "FC_PREVIEW_ADMIN_TOKEN",
    "FC_PREVIEW_MCP_TOKEN",
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / ".env.preview-credentials.local"


def generate_token() -> str:
    """Return a URL-safe, 256-bit credential without exposing it to stdout."""
    return f"ms-fc-{secrets.token_urlsafe(32)}"


def _create_credential_file(
    output: Path, *, token_factory: Callable[[], str] = generate_token
) -> None:
    if not output.parent.is_dir():
        raise ValueError("credential output parent directory does not exist")

    values: list[str] = []
    while len(values) < len(VARIABLES):
        token = token_factory()
        if token not in values:
            values.append(token)
    credentials = dict(zip(VARIABLES, values, strict=True))
    content = "".join(f"{variable}={credentials[variable]}\n" for variable in VARIABLES)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=f".{output.name}.", dir=output.parent, text=True
    )
    temporary_output = Path(temporary_path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as credential_file:
            credential_file.write(content)
            credential_file.flush()
            os.fsync(credential_file.fileno())
        os.chmod(temporary_output, 0o600)
        try:
            os.link(temporary_output, output)
        except FileExistsError as error:
            raise ValueError("credential output already exists; refusing to overwrite") from error
    except BaseException:
        # A partial temporary file contains only this run's generated tokens and
        # must never become a reusable credential file.
        temporary_output.unlink(missing_ok=True)
        raise
    temporary_output.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        _create_credential_file(DEFAULT_OUTPUT)
    except (OSError, ValueError) as error:
        print(f"Could not create preview credential file: {error}", file=sys.stderr)
        return 1
    print(f"Preview credential file written: {DEFAULT_OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
