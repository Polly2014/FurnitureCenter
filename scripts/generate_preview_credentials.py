"""Create the authorized, local-only credentials for FurnitureCenter preview."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
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


def create_credential_file(output: Path) -> None:
    if not output.parent.is_dir():
        raise ValueError("credential output parent directory does not exist")

    credentials = {variable: generate_token() for variable in VARIABLES}
    content = "".join(f"{variable}={credentials[variable]}\n" for variable in VARIABLES)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(output, flags, 0o600)
    except FileExistsError as error:
        raise ValueError("credential output already exists; refusing to overwrite") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as credential_file:
            credential_file.write(content)
            credential_file.flush()
            os.fsync(credential_file.fileno())
        os.chmod(output, 0o600)
    except BaseException:
        # A partial credential file must not be reused. It contains only this run's
        # generated tokens and was created exclusively by this process.
        output.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    try:
        create_credential_file(arguments.output)
    except (OSError, ValueError) as error:
        print(f"Could not create preview credential file: {error}", file=sys.stderr)
        return 1
    print(f"Preview credential file written: {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
