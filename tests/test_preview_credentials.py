"""Contract tests for the authorized local preview-credential generator."""

from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_preview_credentials.py"
VARIABLES = (
    "FC_PREVIEW_VIEWER_TOKEN",
    "FC_PREVIEW_ADMIN_TOKEN",
    "FC_PREVIEW_MCP_TOKEN",
)


def parse_dotenv(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return dict(line.split("=", 1) for line in lines if line)


def test_generator_writes_three_private_high_entropy_credentials_without_echoing(tmp_path: Path):
    output = tmp_path / ".env.preview-credentials.local"

    completed = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == f"Preview credential file written: {output}"
    credentials = parse_dotenv(output)
    assert tuple(credentials) == VARIABLES
    assert len(set(credentials.values())) == 3
    for token in credentials.values():
        assert re.fullmatch(r"ms-fc-[A-Za-z0-9_-]+", token)
        encoded = token.removeprefix("ms-fc-")
        assert len(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))) >= 32
    assert os.stat(output).st_mode & 0o777 == 0o600


def test_generator_refuses_to_overwrite_existing_credentials(tmp_path: Path):
    output = tmp_path / ".env.preview-credentials.local"
    output.write_text("do-not-overwrite\n", encoding="utf-8")
    output.chmod(0o600)

    completed = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert output.read_text(encoding="utf-8") == "do-not-overwrite\n"
    assert "ms-fc-" not in completed.stdout
    assert "ms-fc-" not in completed.stderr
