"""Contracts for the fixed-path Production credential generator."""

from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

try:
    from scripts import generate_production_credentials as credential_generator
except ImportError:
    credential_generator = None

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_production_credentials.py"
VARIABLES = (
    "FC_PRODUCTION_VIEWER_TOKEN",
    "FC_PRODUCTION_ADMIN_TOKEN",
    "FC_PRODUCTION_MCP_TOKEN",
)


def parse_dotenv(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    )


def test_generator_writes_three_unique_private_high_entropy_credentials(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    assert credential_generator is not None, "Production credential generator is missing"
    output = tmp_path / ".env.production-credentials.local"
    monkeypatch.setattr(credential_generator, "DEFAULT_OUTPUT", output)

    credential_generator._create_credential_file()

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    credentials = parse_dotenv(output)
    assert tuple(credentials) == VARIABLES
    assert len(set(credentials.values())) == 3
    for token in credentials.values():
        assert re.fullmatch(r"ms-fc-[A-Za-z0-9_-]+", token)
        encoded = token.removeprefix("ms-fc-")
        assert len(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))) >= 32
    assert os.stat(output).st_mode & 0o777 == 0o600


def test_generator_refuses_to_replace_existing_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert credential_generator is not None, "Production credential generator is missing"
    output = tmp_path / ".env.production-credentials.local"
    output.write_text("do-not-overwrite\n", encoding="utf-8")
    output.chmod(0o600)
    monkeypatch.setattr(credential_generator, "DEFAULT_OUTPUT", output)

    with pytest.raises(ValueError, match="already exists"):
        credential_generator._create_credential_file()

    assert output.read_text(encoding="utf-8") == "do-not-overwrite\n"


def test_cli_rejects_an_output_override(tmp_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(tmp_path / "credentials")],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "unrecognized arguments: --output" in completed.stderr
    assert "ms-fc-" not in completed.stdout
    assert "ms-fc-" not in completed.stderr
