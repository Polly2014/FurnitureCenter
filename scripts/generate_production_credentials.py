"""Create local-only credentials for FurnitureCenter Production."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

VARIABLES = (
    "FC_PRODUCTION_VIEWER_TOKEN",
    "FC_PRODUCTION_ADMIN_TOKEN",
    "FC_PRODUCTION_MCP_TOKEN",
)
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / ".env.production-credentials.local"
TEMPORARY_FILE_PREFIX = ".env.production-credentials.local.tmp-"


def generate_token() -> str:
    """Return a URL-safe, 256-bit credential without exposing it to stdout."""
    return f"ms-fc-{secrets.token_urlsafe(32)}"


def _create_credential_file(*, token_factory: Callable[[], str] = generate_token) -> None:
    output = DEFAULT_OUTPUT
    if not output.parent.is_dir():
        raise ValueError("credential output parent directory does not exist")

    values: list[str] = []
    while len(values) < len(VARIABLES):
        token = token_factory()
        if token not in values:
            values.append(token)
    credentials = dict(zip(VARIABLES, values, strict=True))
    content = "".join(f"{variable}={credentials[variable]}\n" for variable in VARIABLES)
    temporary_output: Path | None = None
    try:
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=TEMPORARY_FILE_PREFIX, dir=output.parent, text=True
        )
        temporary_output = Path(temporary_path)
        os.chmod(temporary_output, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as credential_file:
            credential_file.write(content)
            credential_file.flush()
            os.fsync(credential_file.fileno())
        try:
            os.link(temporary_output, output)
        except FileExistsError as error:
            raise ValueError("credential output already exists; refusing to overwrite") from error
    finally:
        if temporary_output is not None:
            temporary_output.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        _create_credential_file()
    except (OSError, ValueError) as error:
        print(f"Could not create Production credential file: {error}", file=sys.stderr)
        return 1
    print(f"Production credential file written: {DEFAULT_OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
