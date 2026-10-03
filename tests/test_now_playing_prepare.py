import json
import wave
from datetime import UTC, datetime
from pathlib import Path

import pytest

from phrase2photon.contracts.show_package import (
    EnergyFeatures,
    Phrase,
    PhraseRange,
    ShowPackage,
    SongMeta,
    TempoMapSegment,
    VisualLook,
)
from phrase2photon.now_playing.identity import audio_identity_slug
from phrase2photon.now_playing.models import PreparedAudioAsset, ResolvedNowPlayingTrack, TrackObservation
from phrase2photon.now_playing.prepare import (
    _phrase_coverage_problems,
    ensure_show_for_audio_file,
    prepare_show_entry,
)
from phrase2photon.now_playing.providers import measured_duration_seconds
from phrase2photon.now_playing.server import audio_sha256_file, ensure_compiled_show
from phrase2photon.now_playing.track_analysis import TrackAnalysis


@pytest.fixture(autouse=True)
def _no_rekordbox(monkeypatch) -> None:
    # Test files are not in the Rekordbox collection; keep show preparation from
    # opening the real database while it proves that.
    monkeypatch.setattr(
        "phrase2photon.now_playing.server.load_rekordbox_analysis", lambda _path: None
    )


def _write_wav(path: Path, *, seconds: float, sample_rate: int = 8000) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * int(seconds * sample_rate))


def _fake_analysis(duration_seconds: float) -> TrackAnalysis:
    half = duration_seconds / 2
    return TrackAnalysis(
        tempo=120.0,
        duration_seconds=duration_seconds,
        first_downbeat_seconds=0.0,
        tempo_confidence=1.0,
        downbeat_confidence=1.0,
        sections=[
            {"start_seconds": 0.0, "end_seconds": half, "label": "intro", "energy": "low"},
            {"start_seconds": half, "end_seconds": duration_seconds, "label": "groove", "energy": "mid"},
        ],
    )


def _patch_analyzer(monkeypatch, duration_seconds: float | None) -> None:
    analysis = None if duration_seconds is None else _fake_analysis(duration_seconds)
    monkeypatch.setattr("phrase2photon.now_playing.server.analyze_track", lambda _path, **_: analysis)


def test_prepare_show_entry_ok(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "Test Track.wav"
    _write_wav(audio_path, seconds=24.0)
    _patch_analyzer(monkeypatch, duration_seconds=24.0)

    row = prepare_show_entry(
        {
            "path": str(audio_path),
            "title": "Test Track",
            "artist": "Test Artist",
            "version": "wedding",
            "label": "opener",
        },
        cache_root=tmp_path / "cache",
    )

    assert row["status"] == "ok"
    assert row["problems"] == []
    assert row["tempo"] == 120.0
    assert row["phrase_count"] == 2
    assert row["duration"] == 24.0
    assert row["version"] == "wedding"
    assert row["label"] == "opener"
    show_dir = Path(str(row["show_dir"]))
    assert show_dir == tmp_path / "cache" / str(row["identity"]) / "show"
    package = ShowPackage.model_validate(json.loads((show_dir / "show.json").read_text(encoding="utf-8")))
    assert package.song.tempo == 120.0


def test_prepare_show_entry_fails_for_missing_file(tmp_path: Path) -> None:
    row = prepare_show_entry({"path": str(tmp_path / "missing.wav")}, cache_root=tmp_path / "cache")

    assert row["status"] == "failed"
    assert row["problems"] == ["file not found"]


def test_prepare_show_entry_fails_for_dataless_file(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "Cloud Track.wav"
    _write_wav(audio_path, seconds=1.0)
    monkeypatch.setattr("phrase2photon.now_playing.prepare._macos_file_flags", lambda _path: 0x40000000)

    row = prepare_show_entry({"path": str(audio_path)}, cache_root=tmp_path / "cache")

    assert row["status"] == "failed"
    assert row["problems"] == ["file is a dataless iCloud placeholder"]


def test_prepare_show_entry_fails_on_fallback_analyser(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "Fallback Track.wav"
    _write_wav(audio_path, seconds=3.0)
    _patch_analyzer(monkeypatch, duration_seconds=None)

    row = prepare_show_entry({"path": str(audio_path)}, cache_root=tmp_path / "cache")

    assert row["status"] == "failed"
    assert row["tempo"] == 124.0
    assert row["problems"] == ["compiled with the fallback tempo heuristic instead of the analyser"]


def test_prepare_path_matches_service_path_for_same_file(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "Shared Track.wav"
    _write_wav(audio_path, seconds=3.0)
    _patch_analyzer(monkeypatch, duration_seconds=3.0)

    measured = measured_duration_seconds(audio_path)
    observation = TrackObservation(
        source_app="Rekordbox",
        title="Shared Track",
        duration_seconds=measured,
        observed_at=datetime(2026, 10, 2, tzinfo=UTC),
    )
    asset = PreparedAudioAsset(
        local_path=audio_path,
        measured_duration_seconds=measured,
        audio_sha256=audio_sha256_file(audio_path),
        provider="disk",
    )
    identity = audio_identity_slug(observation, asset)
    resolved = ResolvedNowPlayingTrack(observation=observation, asset=asset, audio_identity=identity)
    service_show_dir = ensure_compiled_show(resolved, cache_root=tmp_path / "service")

    prepared = ensure_show_for_audio_file(audio_path, cache_root=tmp_path / "prepared")

    assert prepared.audio_identity == identity
    assert prepared.show_dir == tmp_path / "prepared" / identity / "show"
    assert (service_show_dir / "show.json").exists()
    assert (prepared.show_dir / "show.json").exists()






def _phrase(start_bar_beat: str, end_bar_beat: str, index: int) -> Phrase:
    return Phrase(
        phrase_id=f"phrase_{index}",
        name=f"Phrase {index}",
        range=PhraseRange(start_bar_beat=start_bar_beat, end_bar_beat=end_bar_beat),
        energy=EnergyFeatures(level="low", dynamics=0.2, tension=0.1),
        visual_look=VisualLook(
            palette="smoke-cool", motion_style="slow_drift", composition="sparse", notes=[]
        ),
    )


def _show_with_tempo_map(tempo_map: list[TempoMapSegment], phrases: list[Phrase]) -> ShowPackage:
    return ShowPackage(
        version="0.1.0",
        song=SongMeta(
            song_id="song",
            title="Song",
            tempo=tempo_map[0].bpm,
            time_signature="4/4",
            tempo_map=tempo_map,
        ),
        phrases=phrases,
        lighting_cues=[],
        dmx_laser_cues=[],
    )


def test_phrase_coverage_validates_through_the_tempo_map() -> None:
    # Bars 1-15 at 120 BPM (2 s per bar), then 60 BPM (4 s per bar). The two
    # phrases tile the track exactly; constant-tempo math places the last
    # boundary at 50 s and reports a tail that does not exist.
    tempo_map = [
        TempoMapSegment(start_seconds=0.0, bpm=120.0, downbeat_seconds=0.0),
        TempoMapSegment(start_seconds=30.0, bpm=60.0, downbeat_seconds=30.0),
    ]
    package = _show_with_tempo_map(
        tempo_map, [_phrase("1|1", "16|1", 0), _phrase("16|1", "26|1", 1)]
    )

    assert _phrase_coverage_problems(package, duration_seconds=70.0) == []


def test_phrase_coverage_still_reports_real_gaps() -> None:
    tempo_map = [TempoMapSegment(start_seconds=0.0, bpm=120.0, downbeat_seconds=0.0)]
    package = _show_with_tempo_map(
        tempo_map, [_phrase("1|1", "5|1", 0), _phrase("7|1", "9|1", 1)]
    )

    problems = _phrase_coverage_problems(package, duration_seconds=100.0)
    assert any("gap" in problem for problem in problems)
