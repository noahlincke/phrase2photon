"""Bridge to the runtime's audio analyser.

Now Playing has to decide a tempo and a phrase map for whatever a DJ
application happens to be playing. Doing that with a second, Python-side
implementation is how the two analyses drift apart, and the Python one had
drifted all the way to assuming every track was 124 BPM.

So this shells out to the same analyser the runtime uses, exactly as the
service already shells out to ffmpeg. Build it with:

    cd runtime && npm run build:analyzer

If the bundle is missing or the analysis fails, callers fall back to the legacy
heuristic; `describe_analyzer_state` explains which is in use so the UI can say
so rather than quietly producing a show at the wrong tempo.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

Runner = Callable[..., subprocess.CompletedProcess[str]]

ANALYZER_BUNDLE = (
    Path(__file__).resolve().parents[3] / "runtime" / "dist-analyzer" / "analyze.mjs"
)
ANALYZER_TIMEOUT_SECONDS = 180
BUILD_HINT = "cd runtime && npm run build:analyzer"


@dataclass(frozen=True)
class TrackAnalysis:
    """Tempo and phrase map for one track, from the runtime analyser."""

    tempo: float
    duration_seconds: float
    first_downbeat_seconds: float
    tempo_confidence: float
    downbeat_confidence: float
    sections: list[dict[str, Any]]


def analyzer_bundle_path() -> Path:
    return ANALYZER_BUNDLE


def analyzer_available() -> bool:
    return ANALYZER_BUNDLE.is_file() and shutil.which("node") is not None


def describe_analyzer_state() -> str:
    """One line on whether real analysis is available, for status surfaces."""
    if shutil.which("node") is None:
        return "node not found; Now Playing is estimating tempo instead of measuring it."
    if not ANALYZER_BUNDLE.is_file():
        return f"analyser not built; run `{BUILD_HINT}` for measured tempo."
    return "analyser ready."


def analyze_track(
    audio_path: Path,
    *,
    sample_rate: int = 44100,
    runner: Runner = subprocess.run,
) -> TrackAnalysis | None:
    """Analyses one file, or returns None if that is not possible right now.

    Returning None rather than raising is deliberate: a missing analyser should
    degrade Now Playing, not break it mid-set.
    """
    if not analyzer_available():
        return None
    try:
        completed = runner(
            ["node", str(ANALYZER_BUNDLE), str(audio_path), "--sample-rate", str(sample_rate)],
            capture_output=True,
            text=True,
            timeout=ANALYZER_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None

    tempo = payload.get("tempo")
    sections = payload.get("sections")
    if not isinstance(tempo, (int, float)) or not isinstance(sections, list) or not sections:
        return None
    # A tempo outside this range means the estimate failed rather than found
    # something unusual; the compiler would build a nonsense bar grid from it.
    if not 40.0 <= float(tempo) <= 260.0:
        return None

    normalized: list[dict[str, Any]] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        try:
            start = float(section["start_seconds"])
            end = float(section["end_seconds"])
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        normalized.append(
            {
                "start_seconds": start,
                "end_seconds": end,
                "label": str(section.get("label") or "groove"),
                "energy": str(section.get("energy") or "mid"),
            }
        )
    if not normalized:
        return None

    return TrackAnalysis(
        tempo=float(tempo),
        duration_seconds=float(payload.get("duration_seconds") or 0.0),
        first_downbeat_seconds=float(payload.get("first_downbeat_seconds") or 0.0),
        tempo_confidence=float(payload.get("tempo_confidence") or 0.0),
        downbeat_confidence=float(payload.get("downbeat_confidence") or 0.0),
        sections=normalized,
    )
