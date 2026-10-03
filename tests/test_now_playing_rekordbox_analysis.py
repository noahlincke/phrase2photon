import json
import os
import sys
import types
import wave
from pathlib import Path

import pytest

import phrase2photon.now_playing.rekordbox_analysis as rekordbox_analysis
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


def test_snap_sections_to_bar_grid_drops_sections_collapsed_onto_one_bar() -> None:
    analysis = _analysis(Path("/unused.DAT"), with_phrases=False)
    sections = [
        {"label": "intro", "energy": "low", "start_seconds": 0.0, "end_seconds": 8.3},
        {"label": "blip", "energy": "mid", "start_seconds": 8.3, "end_seconds": 8.7},
        {"label": "groove", "energy": "mid", "start_seconds": 8.7, "end_seconds": 33.0},
    ]

    snapped = snap_sections_to_bar_grid(sections, analysis)

    # 8.3 and 8.7 both snap to the 8.5 bar, which would hand the compiler a
    # zero-length phrase; it is dropped and the map still tiles the track.
    assert [section["label"] for section in snapped] == ["intro", "groove"]
    assert [section["start_seconds"] for section in snapped] == [0.5, 8.5]
    assert [section["end_seconds"] for section in snapped] == [8.5, 32.5]


def test_load_rekordbox_analysis_caches_until_files_change(tmp_path, monkeypatch) -> None:
    db = tmp_path / "master.db"
    db.write_bytes(b"db")
    anlz = tmp_path / "ANLZ0000.DAT"
    anlz.write_bytes(b"anlz")
    analysis = _analysis(anlz, with_phrases=True)
    monkeypatch.setattr(rekordbox_analysis, "_ANALYSIS_CACHE", {})
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_db_path", lambda: db)
    calls: list[Path] = []

    def fake_with_content(audio_path, use_content):
        calls.append(Path(audio_path))
        return analysis.tempo_map, analysis.phrases, analysis.bar_times, analysis.anlz_files

    monkeypatch.setattr(rekordbox_analysis, "_with_rekordbox_content", fake_with_content)

    track = tmp_path / "Track.wav"
    first = rekordbox_analysis.load_rekordbox_analysis(track)
    assert rekordbox_analysis.load_rekordbox_analysis(track) is first
    assert calls == [track]  # the second call skips the database entirely

    rekordbox_analysis.load_rekordbox_analysis(tmp_path / "Other.wav")
    assert len(calls) == 2  # other files still get their own lookup

    future = anlz.stat().st_mtime + 100.0
    os.utime(anlz, (future, future))
    rekordbox_analysis.load_rekordbox_analysis(track)
    assert len(calls) == 3  # Noah re-gridded the ANLZ: re-query

    db_future = db.stat().st_mtime + 100.0
    os.utime(db, (db_future, db_future))
    rekordbox_analysis.load_rekordbox_analysis(track)
    assert len(calls) == 4  # master.db changed: re-query


def test_load_rekordbox_analysis_caches_collection_misses(tmp_path, monkeypatch) -> None:
    db = tmp_path / "master.db"
    db.write_bytes(b"db")
    monkeypatch.setattr(rekordbox_analysis, "_ANALYSIS_CACHE", {})
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_db_path", lambda: db)
    calls: list[Path] = []

    def fake_with_content(audio_path, use_content):
        calls.append(Path(audio_path))
        return None

    monkeypatch.setattr(rekordbox_analysis, "_with_rekordbox_content", fake_with_content)

    track = tmp_path / "Provider Track.wav"
    assert rekordbox_analysis.load_rekordbox_analysis(track) is None
    assert rekordbox_analysis.load_rekordbox_analysis(track) is None
    assert len(calls) == 1  # a track the collection can never match is not re-copied


class _FakeQuery:
    def __init__(self, content: object) -> None:
        self._content = content

    def filter(self, *_args: object) -> "_FakeQuery":
        return self

    def first(self) -> object:
        return self._content


class _FakeSession:
    def __init__(self, content: object) -> None:
        self._content = content
        self.closed = False

    def query(self, *_args: object) -> _FakeQuery:
        return _FakeQuery(self._content)

    def close(self) -> None:
        self.closed = True


class _FakeRekordboxDatabase:
    """Stands in for Rekordbox6Database; the first `fail_opens` opens raise."""

    opens = 0
    fail_opens = 0
    content: object = None

    def __init__(self, *, path, db_dir, unlock) -> None:
        _FakeRekordboxDatabase.opens += 1
        if _FakeRekordboxDatabase.opens <= _FakeRekordboxDatabase.fail_opens:
            raise RuntimeError("file is not a database")
        self.session = _FakeSession(_FakeRekordboxDatabase.content)


def _install_fake_pyrekordbox(monkeypatch, *, fail_opens: int) -> None:
    module = types.ModuleType("pyrekordbox")
    module.Rekordbox6Database = _FakeRekordboxDatabase
    tables = types.ModuleType("pyrekordbox.db6.tables")
    tables.DjmdContent = types.SimpleNamespace(FolderPath="FolderPath")
    monkeypatch.setitem(sys.modules, "pyrekordbox", module)
    monkeypatch.setitem(sys.modules, "pyrekordbox.db6", types.ModuleType("pyrekordbox.db6"))
    monkeypatch.setitem(sys.modules, "pyrekordbox.db6.tables", tables)


def test_rekordbox_db_copy_is_retried_once_when_it_fails_to_open(
    tmp_path, monkeypatch
) -> None:
    db_path = tmp_path / "master.db"
    db_path.write_bytes(b"db")
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_db_path", lambda: db_path)
    _FakeRekordboxDatabase.opens = 0
    _FakeRekordboxDatabase.fail_opens = 1
    _FakeRekordboxDatabase.content = types.SimpleNamespace(AnalysisDataPath="/grid/ANLZ0000.DAT")
    _install_fake_pyrekordbox(monkeypatch, fail_opens=1)

    result = rekordbox_analysis._with_rekordbox_content(
        Path("/music/Track.wav"), lambda content, database: ("parsed", content)
    )

    assert result == ("parsed", _FakeRekordboxDatabase.content)
    assert _FakeRekordboxDatabase.opens == 2  # one torn copy, then a clean one


def test_rekordbox_db_copy_failure_surfaces_after_the_retry(
    tmp_path, monkeypatch
) -> None:
    db_path = tmp_path / "master.db"
    db_path.write_bytes(b"db")
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_db_path", lambda: db_path)
    _FakeRekordboxDatabase.opens = 0
    _FakeRekordboxDatabase.fail_opens = 2
    _install_fake_pyrekordbox(monkeypatch, fail_opens=2)

    with pytest.raises(RuntimeError):
        rekordbox_analysis._with_rekordbox_content(
            Path("/music/Track.wav"), lambda content, database: content
        )
    assert _FakeRekordboxDatabase.opens == 2


