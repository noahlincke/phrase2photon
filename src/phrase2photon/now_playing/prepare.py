"""Ahead-of-time show preparation for offline playback.

Now Playing compiles a show the first time Rekordbox plays a track. For a
wedding that is too late: every show has to be built and validated before the
gig, so playback only has to find them in the cache. `ensure_show_for_audio_file`
drives the exact same identity, cache layout and compile as the live service,
and `prepare_show_entry` wraps it with the pre-flight checks the wedding needs.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping

from phrase2photon.contracts.show_package import ShowPackage
from phrase2photon.now_playing.identity import audio_identity_slug
from phrase2photon.now_playing.models import PreparedAudioAsset, ResolvedNowPlayingTrack, TrackObservation
from phrase2photon.now_playing.providers import measured_duration_seconds
from phrase2photon.now_playing.server import (
    FALLBACK_ANALYSIS_MARKER,
    audio_sha256_file,
    ensure_compiled_show,
)

SF_DATALESS = 0x40000000
PHRASE_GAP_TOLERANCE_SECONDS = 0.01
MIN_TEMPO = 60.0
MAX_TEMPO = 200.0


def _macos_file_flags(path: Path) -> int:
    return path.stat().st_flags


def ensure_show_for_audio_file(
    audio_path: Path,
    *,
    title: str | None = None,
    artist: str | None = None,
    cache_root: Path | None = None,
    force: bool = False,
) -> ResolvedNowPlayingTrack:
    """Builds the show Now Playing would build when Rekordbox plays this file.

    The identity is derived the same way the service derives it at resolve
    time, and the compile itself is `ensure_compiled_show`, so a show prepared
    here is the show the live service picks up.
    """
    duration_seconds = measured_duration_seconds(audio_path)
    observation = TrackObservation(
        source_app="Disk",
        title=title or audio_path.stem,
        artist=artist,
        duration_seconds=duration_seconds,
        observed_at=datetime.now(UTC),
    )
    asset = PreparedAudioAsset(
        local_path=audio_path,
        measured_duration_seconds=duration_seconds,
        audio_sha256=audio_sha256_file(audio_path),
        provider="disk",
    )
    resolved = ResolvedNowPlayingTrack(
        observation=observation,
        asset=asset,
        audio_identity=audio_identity_slug(observation, asset),
    )
    ensure_compiled_show(resolved, cache_root=cache_root, force=force)
    return resolved


def prepare_show_entry(
    entry: Mapping[str, object],
    *,
    force: bool = False,
    cache_root: Path | None = None,
) -> dict[str, object]:
    path = Path(str(entry["path"]))
    title = str(entry.get("title") or path.stem)
    row: dict[str, object] = {
        "label": str(entry.get("label") or title),
        "path": str(path),
        "version": entry.get("version"),
        "identity": None,
        "show_dir": None,
        "status": "failed",
        "tempo": None,
        "phrase_count": None,
        "duration": None,
        "problems": [],
    }

    try:
        flags = _macos_file_flags(path)
    except OSError:
        row["problems"] = ["file not found"]
        return row
    if flags & SF_DATALESS:
        row["problems"] = ["file is a dataless iCloud placeholder"]
        return row

    try:
        resolved = ensure_show_for_audio_file(
            path,
            title=title,
            artist=str(entry["artist"]) if entry.get("artist") else None,
            cache_root=cache_root,
            force=force,
        )
    except Exception as error:
        row["problems"] = [f"show preparation failed: {error}"]
        return row

    duration_seconds = resolved.asset.measured_duration_seconds
    row["identity"] = resolved.audio_identity
    row["show_dir"] = str(resolved.show_dir)
    row["duration"] = duration_seconds

    show_json = resolved.show_dir / "show.json"
    try:
        package = ShowPackage.model_validate(json.loads(show_json.read_text(encoding="utf-8")))
    except (OSError, ValueError) as error:
        row["problems"] = [f"show.json failed validation: {error}"]
        return row

    row["tempo"] = package.song.tempo
    row["phrase_count"] = len(package.phrases)
    problems: list[str] = []
    if (show_json.parent.parent / FALLBACK_ANALYSIS_MARKER).exists():
        problems.append("compiled with the fallback tempo heuristic instead of the analyser")
    if not MIN_TEMPO <= package.song.tempo <= MAX_TEMPO:
        problems.append(f"tempo {package.song.tempo} is outside {MIN_TEMPO:.0f}-{MAX_TEMPO:.0f}")
    problems.extend(_phrase_coverage_problems(package, duration_seconds=duration_seconds))
    row["problems"] = problems
    row["status"] = "ok" if not problems else "failed"
    return row


def _phrase_coverage_problems(package: ShowPackage, *, duration_seconds: float) -> list[str]:
    if not package.phrases:
        return ["show has no phrases"]

    tempo = package.song.tempo
    bar_seconds = 240.0 / tempo
    spans = [
        (
            _bar_beat_seconds(phrase.range.start_bar_beat, tempo),
            _bar_beat_seconds(phrase.range.end_bar_beat, tempo),
        )
        for phrase in package.phrases
    ]
    problems: list[str] = []
    if spans[0][0] > bar_seconds:
        problems.append(f"first phrase starts at {spans[0][0]:.3f}s, after the track begins")
    for (_, previous_end), (start, _) in zip(spans, spans[1:]):
        gap = start - previous_end
        if gap > PHRASE_GAP_TOLERANCE_SECONDS:
            problems.append(f"phrases leave a {gap:.3f}s gap at {previous_end:.3f}s")
        elif gap < -PHRASE_GAP_TOLERANCE_SECONDS:
            problems.append(f"phrases overlap by {-gap:.3f}s at {start:.3f}s")
    # Phrase boundaries sit on the analyser's bar grid, which is anchored to
    # the first downbeat rather than to second zero, so the uncovered lead-in
    # and tail are bounded by bars, not zero.
    if spans[-1][1] < duration_seconds - 2 * bar_seconds:
        problems.append(f"phrases end at {spans[-1][1]:.3f}s but the track runs {duration_seconds:.3f}s")
    if duration_seconds > 120.0 and len(package.phrases) < 4:
        problems.append(f"only {len(package.phrases)} phrases for a {duration_seconds:.0f}s track")
    return problems


def _bar_beat_seconds(bar_beat: str, tempo: float) -> float:
    bar_text, beat_text = bar_beat.split("|")
    beats = (int(bar_text) - 1) * 4 + (float(beat_text) - 1)
    return beats * 60.0 / tempo