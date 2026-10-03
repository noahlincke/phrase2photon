"""Ahead-of-time show preparation for offline playback.

Now Playing compiles a show the first time Rekordbox plays a track. For a
wedding that is too late: every show has to be built and validated before the
gig, so playback only has to find them in the cache. `ensure_show_for_audio_file`
drives the exact same identity, cache layout and compile as the live service,
and `prepare_show_entry` wraps it with the pre-flight checks the wedding needs.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping

from phrase2photon.contracts.beat_grid import (
    BeatGrid,
    bar_beat_for_seconds,
    beats_for_bar_beat,
    beats_per_bar_from_signature,
    beats_to_seconds,
)
from phrase2photon.contracts.show_package import ShowPackage, TempoMapSegment
from phrase2photon.extraction.models import LiveSetExtraction, LocatorSnapshot, PhraseSnapshot
from phrase2photon.now_playing.identity import audio_identity_slug
from phrase2photon.now_playing.models import PreparedAudioAsset, ResolvedNowPlayingTrack, TrackObservation
from phrase2photon.now_playing.providers import measured_duration_seconds
from phrase2photon.now_playing.server import (
    FALLBACK_ANALYSIS_MARKER,
    FALLBACK_TEMPO,
    audio_sha256_file,
    ensure_compiled_show,
    show_dir_for_identity,
)
from phrase2photon.now_playing.server import _ensure_cached_audio
from phrase2photon.now_playing.track_analysis import analyze_track
from phrase2photon.now_playing.wav_analysis import _build_semantics, analyze_audio_sections

SF_DATALESS = 0x40000000
PHRASE_GAP_TOLERANCE_SECONDS = 0.01
MIN_TEMPO = 60.0
MAX_TEMPO = 200.0


def _macos_file_flags(path: Path) -> int:
    return path.stat().st_flags


def _resolve_disk_track(
    audio_path: Path,
    *,
    title: str | None = None,
    artist: str | None = None,
) -> ResolvedNowPlayingTrack:
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
    return ResolvedNowPlayingTrack(
        observation=observation,
        asset=asset,
        audio_identity=audio_identity_slug(observation, asset),
    )


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
    resolved = _resolve_disk_track(audio_path, title=title, artist=artist)
    ensure_compiled_show(resolved, cache_root=cache_root, force=force)
    return resolved


def ensure_show_for_recording(
    audio_path: Path,
    *,
    segments: list[Mapping[str, object]],
    title: str | None = None,
    artist: str | None = None,
    cache_root: Path | None = None,
    force: bool = False,
) -> ResolvedNowPlayingTrack:
    """Builds one show for a prerecorded multi-track file, e.g. an automix.

    The cue sheet names each track with its fade-in start and the moment the
    previous track is gone. Each track is analysed on its own and the results
    are assembled into a single show whose tempo map carries the per-track
    tempos, so the runtime stays on beat across the whole file. Identity and
    cache layout match single-track shows: the identity hashes the whole
    recording, so the live service finds this show by playing the file.
    """
    resolved = _resolve_disk_track(audio_path, title=title, artist=artist)
    show_dir = show_dir_for_identity(resolved.audio_identity, cache_root=cache_root)
    cache_dir = show_dir.parent
    if force:
        shutil.rmtree(cache_dir, ignore_errors=True)
    if (show_dir / "show.json").exists():
        resolved.show_dir = show_dir
        return resolved

    ranges = _owned_ranges(segments, resolved.asset.measured_duration_seconds)
    with tempfile.TemporaryDirectory(prefix="p2p-recording-") as temp:
        extraction, used_fallback = _recording_extraction(
            audio_path,
            ranges,
            title=resolved.observation.title,
            artist=artist,
            temp_dir=Path(temp),
        )
    _ensure_cached_audio(resolved, cache_root=cache_root)

    cache_dir.mkdir(parents=True, exist_ok=True)
    if used_fallback:
        (cache_dir / FALLBACK_ANALYSIS_MARKER).write_text(
            "recording tracks analysed without the analyser\n", encoding="utf-8"
        )
    extraction_path = cache_dir / "wav-analysis.extraction.json"
    extraction_path.write_text(extraction.model_dump_json(indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "phrase2photon.cli",
            "compile",
            "--extraction-in",
            str(extraction_path),
            "--outdir",
            str(show_dir),
        ],
        check=True,
    )
    resolved.show_dir = show_dir
    return resolved


def _owned_ranges(
    segments: list[Mapping[str, object]],
    duration_seconds: float,
) -> list[tuple[float, float, Mapping[str, object]]]:
    """The time range each track owns: from the crossfade midpoint after the
    previous track to the midpoint before the next one."""
    starts = [0.0]
    for segment in segments[1:]:
        starts.append((float(segment["start_seconds"]) + float(segment["full_seconds"])) / 2)
    return [
        (starts[index], starts[index + 1] if index + 1 < len(segments) else duration_seconds, segment)
        for index, segment in enumerate(segments)
    ]


def _cut_audio(audio_path: Path, start_seconds: float, end_seconds: float, out_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{start_seconds:.3f}",
            "-i",
            str(audio_path),
            "-t",
            f"{end_seconds - start_seconds:.3f}",
            "-ac",
            "1",
            "-ar",
            "44100",
            str(out_path),
        ],
        check=True,
        capture_output=True,
    )


def _recording_extraction(
    audio_path: Path,
    ranges: list[tuple[float, float, Mapping[str, object]]],
    *,
    title: str,
    artist: str | None,
    temp_dir: Path,
) -> tuple[LiveSetExtraction, bool]:
    """Analyses each owned range and assembles one extraction for the recording."""
    tempo_segments: list[TempoMapSegment] = []
    track_sections: list[list[dict[str, float | str]]] = []
    used_fallback = False

    for index, (start, end, segment) in enumerate(ranges):
        cut = temp_dir / f"track-{index}.wav"
        _cut_audio(audio_path, start, end, cut)
        analysis = analyze_track(cut)
        if analysis is not None:
            bpm = analysis.tempo
            downbeat = start + analysis.first_downbeat_seconds
            sections = _clipped_sections(analysis.sections, offset=start, end_seconds=end)
        else:
            used_fallback = True
            declared = segment.get("bpm")
            bpm = float(declared) if declared else FALLBACK_TEMPO
            downbeat = start
            sections = _clipped_sections(
                analyze_audio_sections(cut, duration_seconds=end - start, tempo=bpm),
                offset=start,
                end_seconds=end,
            )
        tempo_segments.append(TempoMapSegment(start_seconds=start, bpm=bpm, downbeat_seconds=downbeat))
        track_sections.append(sections)

    grid = BeatGrid(segments=tempo_segments, beats_per_bar=4)
    total_phrases = sum(len(sections) for sections in track_sections)
    locators: list[LocatorSnapshot] = []
    phrases: list[PhraseSnapshot] = []
    phrase_index = 0
    for sections in track_sections:
        for local_index, section in enumerate(sections):
            locator = LocatorSnapshot(
                locator_id=f"wav_locator_{phrase_index}",
                name=str(section["label"]).title(),
                time=bar_beat_for_seconds(grid, float(section["start_seconds"])),
                order_index=phrase_index,
            )
            locators.append(locator)
            phrases.append(
                PhraseSnapshot(
                    phrase_id=f"wav_phrase_{phrase_index}",
                    name=str(section["label"]).title(),
                    start_bar_beat=locator.time,
                    end_bar_beat=bar_beat_for_seconds(grid, float(section["end_seconds"])),
                    locator_id=locator.locator_id,
                    next_locator_id=(
                        f"wav_locator_{phrase_index + 1}"
                        if phrase_index + 1 < total_phrases
                        else None
                    ),
                    semantics=_build_semantics(
                        label=str(section["label"]),
                        energy_level=str(section["energy"]),
                        phrase_index=local_index,
                        total_phrases=len(sections),
                        artist=artist,
                        audio_path=audio_path,
                    ),
                )
            )
            phrase_index += 1

    extraction = LiveSetExtraction(
        source_name=title,
        tempo=tempo_segments[0].bpm,
        time_signature="4/4",
        first_downbeat_seconds=tempo_segments[0].downbeat_seconds,
        tempo_map=tempo_segments,
        locators=locators,
        tracks=[],
        phrases=phrases,
        warnings=[],
    )
    return extraction, used_fallback


def _clipped_sections(
    sections: list[Mapping[str, object]],
    *,
    offset: float,
    end_seconds: float,
) -> list[dict[str, float | str]]:
    """Shifts one track's sections into recording time, clipped to the range
    the track owns; the first and last stretch to cover it exactly."""
    clipped: list[dict[str, float | str]] = []
    for section in sections:
        start = max(offset, offset + float(section["start_seconds"]))
        end = min(end_seconds, offset + float(section["end_seconds"]))
        if end <= start + PHRASE_GAP_TOLERANCE_SECONDS and clipped:
            clipped[-1]["end_seconds"] = end
            continue
        if end <= start:
            continue
        clipped.append(
            {
                "label": section["label"],
                "energy": section["energy"],
                "start_seconds": start,
                "end_seconds": end,
            }
        )
    if clipped:
        clipped[0]["start_seconds"] = offset
        clipped[-1]["end_seconds"] = end_seconds
    return clipped


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
        segments = list(entry.get("segments") or [])
        if segments:
            resolved = ensure_show_for_recording(
                path,
                segments=segments,
                title=title,
                artist=str(entry["artist"]) if entry.get("artist") else None,
                cache_root=cache_root,
                force=force,
            )
        else:
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
    row["track_count"] = len(entry.get("segments") or []) or None
    problems: list[str] = []
    if (show_json.parent.parent / FALLBACK_ANALYSIS_MARKER).exists():
        problems.append("compiled with the fallback tempo heuristic instead of the analyser")
    if not MIN_TEMPO <= package.song.tempo <= MAX_TEMPO:
        problems.append(f"tempo {package.song.tempo} is outside {MIN_TEMPO:.0f}-{MAX_TEMPO:.0f}")
    segments = list(entry.get("segments") or [])
    if segments:
        problems.extend(_recording_problems(package, segments, duration_seconds=duration_seconds))
    else:
        problems.extend(_phrase_coverage_problems(package, duration_seconds=duration_seconds))
    row["problems"] = problems
    row["status"] = "ok" if not problems else "failed"
    return row


def _recording_problems(
    package: ShowPackage,
    segments: list[Mapping[str, object]],
    *,
    duration_seconds: float,
) -> list[str]:
    """Validates an assembled recording show against its cue sheet.

    Unlike single tracks, recordings are assembled from per-track analyses, so
    the phrase map has to tile the whole file: every track exactly covered, no
    gaps or overlaps anywhere, and every tempo change present in the map.
    """
    tempo_map = package.song.tempo_map or []
    if len(tempo_map) != len(segments):
        return [f"tempo map has {len(tempo_map)} segments for {len(segments)} cue sheet tracks"]

    problems = [
        f"track {index} tempo {segment.bpm:g} is outside {MIN_TEMPO:.0f}-{MAX_TEMPO:.0f}"
        for index, segment in enumerate(tempo_map)
        if not MIN_TEMPO <= segment.bpm <= MAX_TEMPO
    ]

    grid = BeatGrid(
        segments=tempo_map,
        beats_per_bar=beats_per_bar_from_signature(package.song.time_signature),
    )
    spans = [
        (
            beats_to_seconds(grid, beats_for_bar_beat(phrase.range.start_bar_beat, grid.beats_per_bar)),
            beats_to_seconds(grid, beats_for_bar_beat(phrase.range.end_bar_beat, grid.beats_per_bar)),
        )
        for phrase in package.phrases
    ]
    if not spans:
        return problems + ["show has no phrases"]
    # bar|beat cannot express the lead-in before the first downbeat ("1|1" is
    # the downbeat itself), so full coverage means the first phrase starts
    # exactly there and the runtime plays the lead-in inside the first phrase.
    first_downbeat = beats_to_seconds(grid, 0)
    if spans[0][0] > first_downbeat + PHRASE_GAP_TOLERANCE_SECONDS:
        problems.append(f"first phrase starts at {spans[0][0]:.3f}s, after the first downbeat at {first_downbeat:.3f}s")
    for (_, previous_end), (start, _) in zip(spans, spans[1:]):
        gap = start - previous_end
        if gap > PHRASE_GAP_TOLERANCE_SECONDS:
            problems.append(f"phrases leave a {gap:.3f}s gap at {previous_end:.3f}s")
        elif gap < -PHRASE_GAP_TOLERANCE_SECONDS:
            problems.append(f"phrases overlap by {-gap:.3f}s at {start:.3f}s")
    if spans[-1][1] < duration_seconds - PHRASE_GAP_TOLERANCE_SECONDS:
        problems.append(f"phrases end at {spans[-1][1]:.3f}s but the recording runs {duration_seconds:.3f}s")

    for index, (start, end, _segment) in enumerate(_owned_ranges(segments, duration_seconds)):
        count = sum(
            1
            for phrase_start, _ in spans
            if start - PHRASE_GAP_TOLERANCE_SECONDS <= phrase_start < end
        )
        if end - start >= 30.0 and count < 2:
            problems.append(f"track {index} has {count} phrases for a {end - start:.0f}s range")
    return problems


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