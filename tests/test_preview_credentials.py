"""Contract tests for the authorized local preview-credential generator."""

from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import generate_preview_credentials as credential_generator

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


def test_cli_rejects_an_output_override(tmp_path: Path):
    output = tmp_path / ".env.preview-credentials.local"

    completed = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert not output.exists()
    assert "unrecognized arguments: --output" in completed.stderr
    assert "ms-fc-" not in completed.stdout
    assert "ms-fc-" not in completed.stderr


def test_private_generator_writes_three_private_high_entropy_credentials_without_echoing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    output = tmp_path / ".env.preview-credentials.local"

    credential_generator._create_credential_file(output)

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


def test_private_generator_regenerates_until_all_three_credentials_are_unique(tmp_path: Path):
    output = tmp_path / ".env.preview-credentials.local"
    generated = iter(("duplicate", "duplicate", "viewer", "admin"))
    attempts = 0

    def token_factory() -> str:
        nonlocal attempts
        attempts += 1
        return next(generated)

    credential_generator._create_credential_file(output, token_factory=token_factory)

    credentials = parse_dotenv(output)
    assert len(credentials) == 3
    assert len(set(credentials.values())) == 3
    assert set(credentials.values()) == {"duplicate", "viewer", "admin"}
    assert attempts == 4


def test_private_generator_refuses_to_replace_existing_credentials(tmp_path: Path):
    output = tmp_path / ".env.preview-credentials.local"
    output.write_text("do-not-overwrite\n", encoding="utf-8")
    output.chmod(0o600)

    with pytest.raises(ValueError, match="already exists"):
        credential_generator._create_credential_file(output)

    assert output.read_text(encoding="utf-8") == "do-not-overwrite\n"
    assert list(tmp_path.iterdir()) == [output]


def test_private_generator_cleans_up_if_fsync_fails_before_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    output = tmp_path / ".env.preview-credentials.local"

    def fail_fsync(_descriptor: int) -> None:
        raise OSError("simulated pre-publication write failure")

    monkeypatch.setattr(credential_generator.os, "fsync", fail_fsync)

    with pytest.raises(OSError, match="pre-publication write failure"):
        credential_generator._create_credential_file(output)

    assert not output.exists()
    assert list(tmp_path.iterdir()) == []
