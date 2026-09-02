"""Deployment safety contracts for the Cloudflare Worker configuration."""

from __future__ import annotations

import json
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_wrangler_config() -> dict[str, object]:
    """Load the repository's JSONC config, whose comments occupy whole lines."""
    source = (PROJECT_ROOT / "worker" / "wrangler.jsonc").read_text()
    without_comments = re.sub(r"^\s*//.*$", "", source, flags=re.MULTILINE)
    return json.loads(without_comments)


def test_production_exposes_only_the_fc_custom_domain() -> None:
    """Production must expose only fc.polly.wang after the domain cutover."""
    config = load_wrangler_config()
    production = config["env"]["production"]

    assert production["workers_dev"] is False
    assert production["preview_urls"] is False
    assert production["routes"] == [
        {"pattern": "fc.polly.wang", "custom_domain": True},
    ]
    assert production["triggers"]["crons"] == []


def test_production_observability_preserves_query_privacy() -> None:
    """Persist sampled errors without request URLs, query strings, or D1 trace text."""
    config = load_wrangler_config()
    production = config["env"]["production"]

    assert production["observability"] == {
        "logs": {
            "enabled": True,
            "head_sampling_rate": 0.05,
            "invocation_logs": False,
            "persist": True,
        },
        "traces": {
            "enabled": False,
            "persist": False,
        },
    }
