import json
import os
import wave
from pathlib import Path

import pytest

from phrase2photon.contracts.show_package import ShowPackage, TempoMapSegment
from phrase2photon.now_playing.rekordbox_analysis import (
    RekordboxAnalysis,
    RekordboxPhrase,
    _phrase_label,
    _tempo_map,
    snap_sections_to_bar_grid,
)
from phrase2photon.now_playing.server import ensure_compiled_show
from phrase2photon.now_playing.track_analysis import TrackAnalysis


def _write_wav(path: Path, *, seconds: float, sample_rate: int = 8000) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * int(seconds * sample_rate))


def _analysis(anlz_file: Path, *, with_phrases: bool) -> RekordboxAnalysis:
    # 120 BPM: one bar is 2 s, first downbeat at 0.5 s, 16 bars total.
    phrases = (
        [
            RekordboxPhrase(0.5, 8.5, "Intro", "low"),
            RekordboxPhrase(8.5, 16.5, "Drop", "peak"),
            RekordboxPhrase(16.5, 24.5, "Build", "high"),
            RekordboxPhrase(24.5, 32.5, "Outro", "low"),
        ]
        if with_phrases
        else []
    )
    return RekordboxAnalysis(
        tempo_map=[TempoMapSegment(start_seconds=0.0, bpm=120.0, downbeat_seconds=0.5)],
        phrases=phrases,
        bar_times=tuple(0.5 + 2.0 * bar for bar in range(17)),
        anlz_files=(anlz_file,),
    )


def _patch_rekordbox(monkeypatch, analysis: RekordboxAnalysis | None) -> list[Path]:
    seen: list[Path] = []

    def loader(audio_path: Path) -> RekordboxAnalysis | None:
        seen.append(audio_path)
        return analysis

    monkeypatch.setattr("phrase2photon.now_playing.server.load_rekordbox_analysis", loader)
    return seen


def _patch_analyzer(monkeypatch, duration_seconds: float | None) -> None:
    if duration_seconds is None:
        analysis = None
    else:
        analysis = TrackAnalysis(
            tempo=98.0,
            duration_seconds=duration_seconds,
            first_downbeat_seconds=1.25,
            tempo_confidence=1.0,
            downbeat_confidence=1.0,
            sections=[
                {"start_seconds": 0.0, "end_seconds": 9.3, "label": "intro", "energy": "low"},
                {"start_seconds": 9.3, "end_seconds": duration_seconds, "label": "groove", "energy": "mid"},
            ],
        )
    monkeypatch.setattr("phrase2photon.now_playing.server.analyze_track", lambda _path, **_: analysis)


def _resolved_show(tmp_path: Path) -> tuple[Path, Path]:
    audio_path = tmp_path / "Test Track.wav"
    _write_wav(audio_path, seconds=33.0)
    return audio_path, tmp_path / "cache"


def _resolved(audio_path: Path):
    from datetime import UTC, datetime

    from phrase2photon.now_playing.identity import audio_identity_slug
    from phrase2photon.now_playing.models import PreparedAudioAsset, ResolvedNowPlayingTrack, TrackObservation
    from phrase2photon.now_playing.server import audio_sha256_file

    observation = TrackObservation(
        source_app="Disk",
        title=audio_path.stem,
        artist=None,
        duration_seconds=33.0,
        observed_at=datetime.now(UTC),
    )
    asset = PreparedAudioAsset(
        local_path=audio_path,
        measured_duration_seconds=33.0,
        audio_sha256=audio_sha256_file(audio_path),
        provider="disk",
    )
    return ResolvedNowPlayingTrack(
        observation=observation,
        asset=asset,
        audio_identity=audio_identity_slug(observation, asset),
    )


def _package(cache_root: Path, identity: str) -> ShowPackage:
    show_json = cache_root / identity / "show" / "show.json"
    return ShowPackage.model_validate(json.loads(show_json.read_text(encoding="utf-8")))


def test_rekordbox_grid_and_phrases_win(tmp_path: Path, monkeypatch) -> None:
    audio_path, cache_root = _resolved_show(tmp_path)
    anlz = tmp_path / "ANLZ0000.DAT"
    anlz.write_bytes(b"anlz")
    seen = _patch_rekordbox(monkeypatch, _analysis(anlz, with_phrases=True))
    _patch_analyzer(monkeypatch, 33.0)

    resolved = _resolved(audio_path)
    ensure_compiled_show(resolved, cache_root=cache_root)
    package = _package(cache_root, resolved.audio_identity)

    assert package.song.tempo == 120.0
    assert [phrase.name for phrase in package.phrases] == ["Intro", "Drop", "Build", "Outro"]
    assert [phrase.range.start_bar_beat for phrase in package.phrases] == ["1|1", "5|1", "9|1", "13|1"]
    assert seen == [audio_path]
    sidecar = json.loads((cache_root / resolved.audio_identity / "show" / "analysis-source.json").read_text())
    assert sidecar["analysis_source"] == "rekordbox-anlz"
    assert sidecar["anlz_mtimes"] == {str(anlz): anlz.stat().st_mtime}


def test_rekordbox_grid_snaps_analyser_sections_without_phrases(tmp_path: Path, monkeypatch) -> None:
    audio_path, cache_root = _resolved_show(tmp_path)
    anlz = tmp_path / "ANLZ0000.DAT"
    anlz.write_bytes(b"anlz")
    _patch_rekordbox(monkeypatch, _analysis(anlz, with_phrases=False))
    _patch_analyzer(monkeypatch, 33.0)

    resolved = _resolved(audio_path)
    ensure_compiled_show(resolved, cache_root=cache_root)
    package = _package(cache_root, resolved.audio_identity)

    # The analyser's 9.3 s boundary lands on the nearest rekordbox bar (8.5 s),
    # and the rekordbox grid supplies tempo and downbeat, not the analyser.
    assert package.song.tempo == 120.0
    assert [phrase.range.start_bar_beat for phrase in package.phrases] == ["1|1", "5|1"]
    assert package.song.tempo_map[0].downbeat_seconds == 0.5


def test_analyser_fallback_when_not_in_rekordbox(tmp_path: Path, monkeypatch) -> None:
    audio_path, cache_root = _resolved_show(tmp_path)
    _patch_rekordbox(monkeypatch, None)
    _patch_analyzer(monkeypatch, 33.0)

    resolved = _resolved(audio_path)
    ensure_compiled_show(resolved, cache_root=cache_root)
    package = _package(cache_root, resolved.audio_identity)

    assert package.song.tempo == 98.0
    sidecar = json.loads((cache_root / resolved.audio_identity / "show" / "analysis-source.json").read_text())
    assert sidecar == {"analysis_source": "analyser", "anlz_mtimes": {}}


def test_regridded_anlz_rebuilds_the_cached_show(tmp_path: Path, monkeypatch) -> None:
    audio_path, cache_root = _resolved_show(tmp_path)
    anlz = tmp_path / "ANLZ0000.DAT"
    anlz.write_bytes(b"anlz")
    seen = _patch_rekordbox(monkeypatch, _analysis(anlz, with_phrases=True))
    _patch_analyzer(monkeypatch, 33.0)
    resolved = _resolved(audio_path)

    ensure_compiled_show(resolved, cache_root=cache_root)
    assert len(seen) == 1
    ensure_compiled_show(resolved, cache_root=cache_root)
    assert len(seen) == 1  # mtimes unchanged: the cached show is reused

    future = anlz.stat().st_mtime + 100.0
    os.utime(anlz, (future, future))
    ensure_compiled_show(resolved, cache_root=cache_root)
    assert len(seen) == 2  # Noah re-gridded the track: the show rebuilds
    sidecar = json.loads((cache_root / resolved.audio_identity / "show" / "analysis-source.json").read_text())
    assert sidecar["anlz_mtimes"] == {str(anlz): future}


def test_phrase_kind_mapping_follows_the_mood() -> None:
    assert _phrase_label(mood=1, kind=1) == ("Intro", "low")
    assert _phrase_label(mood=1, kind=2) == ("Build", "high")
    assert _phrase_label(mood=1, kind=3) == ("Breakdown", "low")
    assert _phrase_label(mood=1, kind=5) == ("Drop", "peak")
    assert _phrase_label(mood=1, kind=6) == ("Outro", "low")
    # Mid/low moods label kinds 2..8 as verses or a bridge; none of those has a
    # counterpart in our phrase kinds, so they stay the neutral groove.
    assert _phrase_label(mood=2, kind=5) == ("Groove", "mid")
    assert _phrase_label(mood=2, kind=8) == ("Groove", "mid")
    assert _phrase_label(mood=3, kind=9) == ("Drop", "peak")
    assert _phrase_label(mood=3, kind=10) == ("Outro", "low")


def test_tempo_map_segments_per_constant_tempo() -> None:
    beats = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]
    times = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0]

    segments = _tempo_map(beats, times, [120.0] * 4 + [130.0] * 8)
    assert [(s.start_seconds, s.bpm, s.downbeat_seconds) for s in segments] == [
        (0.0, 120.0, 0.0),
        (4.0, 130.0, 4.0),
    ]

    # A tempo change mid-bar anchors the new segment to the bar that contains it.
    segments = _tempo_map(beats, times, [120.0] * 6 + [130.0] * 6)
    assert [(s.start_seconds, s.bpm, s.downbeat_seconds) for s in segments] == [
        (0.0, 120.0, 0.0),
        (6.0, 130.0, 4.0),
    ]


def test_snap_sections_to_bar_grid_keeps_the_map_tiling() -> None:
    analysis = _analysis(Path("/unused.DAT"), with_phrases=False)
    sections = [
        {"label": "intro", "energy": "low", "start_seconds": 0.0, "end_seconds": 9.3},
        {"label": "groove", "energy": "mid", "start_seconds": 9.3, "end_seconds": 33.0},
    ]

    snapped = snap_sections_to_bar_grid(sections, analysis)

    assert [section["start_seconds"] for section in snapped] == [0.5, 8.5]
    assert [section["end_seconds"] for section in snapped] == [8.5, 32.5]
    assert sections[0]["end_seconds"] == 9.3  # the input is not mutated


