"""Tests for the bridge to the runtime audio analyser."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from phrase2photon.now_playing import track_analysis
from phrase2photon.now_playing.track_analysis import analyze_track

GOOD_PAYLOAD = {
    "version": 1,
    "tempo": 128.013,
    "duration_seconds": 361.2,
    "first_downbeat_seconds": 0.487,
    "tempo_confidence": 0.94,
    "downbeat_confidence": 0.71,
    "sections": [
        {"start_seconds": 0.0, "end_seconds": 30.0, "label": "intro", "energy": "low"},
        {"start_seconds": 30.0, "end_seconds": 60.0, "label": "drop", "energy": "peak"},
    ],
}


def _runner(stdout: str, returncode: int = 0):
    def run(args, **kwargs):
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    return run


@pytest.fixture
def available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(track_analysis, "analyzer_available", lambda: True)


def test_parses_analyzer_output(available: None) -> None:
    result = analyze_track(Path("track.wav"), runner=_runner(json.dumps(GOOD_PAYLOAD)))
    assert result is not None
    assert result.tempo == pytest.approx(128.013)
    assert result.first_downbeat_seconds == pytest.approx(0.487)
    assert [section["label"] for section in result.sections] == ["intro", "drop"]
    assert result.sections[1]["energy"] == "peak"


def test_returns_none_when_analyzer_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(track_analysis, "analyzer_available", lambda: False)
    assert analyze_track(Path("track.wav")) is None


@pytest.mark.parametrize(
    "stdout,returncode",
    [
        ("", 0),
        ("not json", 0),
        (json.dumps(GOOD_PAYLOAD), 1),
        (json.dumps({**GOOD_PAYLOAD, "sections": []}), 0),
        (json.dumps({**GOOD_PAYLOAD, "tempo": 4.0}), 0),
        (json.dumps({**GOOD_PAYLOAD, "tempo": None}), 0),
    ],
)
def test_rejects_unusable_output(available: None, stdout: str, returncode: int) -> None:
    assert analyze_track(Path("track.wav"), runner=_runner(stdout, returncode)) is None


def test_survives_a_crashing_analyzer(available: None) -> None:
    def run(args, **kwargs):
        raise subprocess.TimeoutExpired(args, 1)

    assert analyze_track(Path("track.wav"), runner=run) is None


def test_drops_malformed_sections_but_keeps_good_ones(available: None) -> None:
    payload = {
        **GOOD_PAYLOAD,
        "sections": [
            {"start_seconds": 0.0, "end_seconds": 30.0, "label": "intro", "energy": "low"},
            {"start_seconds": 60.0, "end_seconds": 30.0, "label": "drop"},
            "nonsense",
            {"start_seconds": 60.0, "end_seconds": 90.0},
        ],
    }
    result = analyze_track(Path("track.wav"), runner=_runner(json.dumps(payload)))
    assert result is not None
    assert [section["label"] for section in result.sections] == ["intro", "groove"]
    assert result.sections[1]["energy"] == "mid"


def test_describe_analyzer_state_mentions_the_build_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(track_analysis.shutil, "which", lambda name: "/usr/bin/node")
    monkeypatch.setattr(track_analysis, "ANALYZER_BUNDLE", tmp_path / "missing.mjs")
    assert "npm run build:analyzer" in track_analysis.describe_analyzer_state()
