from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from phrase2photon.now_playing.models import ProviderCandidate, TrackObservation
from phrase2photon.now_playing.providers import (
    DurationGate,
    _parse_provider_candidates,
    resolve_audio_asset,
    scan_audio_candidates,
)


def _observation(*, duration_seconds: float = 212.0) -> TrackObservation:
    return TrackObservation(
        source_app="spotify",
        title="Test Song",
        artist="Test Artist",
        duration_seconds=duration_seconds,
        observed_at=datetime(2026, 5, 15, 12, 0, tzinfo=UTC),
    )


def _candidate(
    provider: str,
    *,
    local_path: Path | None = None,
    reported_duration_seconds: float | None,
) -> ProviderCandidate:
    return ProviderCandidate(
        provider=provider,
        title="Test Song",
        artist="Test Artist",
        reported_duration_seconds=reported_duration_seconds,
        local_path=local_path,
        metadata_confidence=0.9,
    )


def test_resolve_audio_asset_prefers_disk_candidates_before_remote_providers(tmp_path: Path) -> None:
    observation = _observation()
    disk_path = tmp_path / "disk.wav"
    remote_path = tmp_path / "remote.wav"
    prepare_calls: list[str] = []

    def remote_provider(_observation: TrackObservation) -> list[ProviderCandidate]:
        return [_candidate("spotdl", reported_duration_seconds=212.0)]

    def prepare_audio(candidate: ProviderCandidate) -> Path:
        prepare_calls.append(candidate.provider)
        return disk_path if candidate.provider == "disk" else remote_path

    resolved = resolve_audio_asset(
        observation,
        providers=[remote_provider],
        disk_candidates=[
            _candidate("disk", local_path=disk_path, reported_duration_seconds=None),
        ],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=prepare_audio,
        audio_sha256=lambda _path: "a" * 64,
        measure_duration=lambda _path: 212.0,
    )

    assert resolved is not None
    assert resolved.asset.provider == "disk"
    assert resolved.asset.local_path == disk_path
    assert prepare_calls == ["disk"]


def test_resolve_audio_asset_rejects_remote_candidates_before_download_when_reported_duration_mismatches() -> None:
    observation = _observation(duration_seconds=212.0)
    prepare_calls: list[str] = []

    def mismatched_remote(_observation: TrackObservation) -> list[ProviderCandidate]:
        return [_candidate("scdl", reported_duration_seconds=198.0)]

    resolved = resolve_audio_asset(
        observation,
        providers=[mismatched_remote],
        disk_candidates=[],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda candidate: prepare_calls.append(candidate.provider) or Path("/tmp/never.wav"),
        audio_sha256=lambda _path: "b" * 64,
        measure_duration=lambda _path: 212.0,
    )

    assert resolved is None
    assert prepare_calls == []


def test_resolve_audio_asset_rejects_remote_candidate_after_prepare_when_measured_duration_mismatches(tmp_path: Path) -> None:
    observation = _observation(duration_seconds=212.0)
    prepared_path = tmp_path / "prepared.wav"
    prepare_calls: list[str] = []

    def remote_provider(_observation: TrackObservation) -> list[ProviderCandidate]:
        return [_candidate("spotdl", reported_duration_seconds=212.3)]

    resolved = resolve_audio_asset(
        observation,
        providers=[remote_provider],
        disk_candidates=[],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda candidate: prepare_calls.append(candidate.provider) or prepared_path,
        audio_sha256=lambda _path: "c" * 64,
        measure_duration=lambda _path: 219.5,
    )

    assert resolved is None
    assert prepare_calls == ["spotdl"]


def test_resolve_audio_asset_allows_remote_candidate_without_reported_duration_and_uses_measured_duration_gate(
    tmp_path: Path,
) -> None:
    observation = _observation(duration_seconds=212.0)
    prepared_path = tmp_path / "prepared.flac"
    prepare_calls: list[str] = []

    def remote_provider(_observation: TrackObservation) -> list[ProviderCandidate]:
        return [_candidate("spotdl", reported_duration_seconds=None)]

    resolved = resolve_audio_asset(
        observation,
        providers=[remote_provider],
        disk_candidates=[],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda candidate: prepare_calls.append(candidate.provider) or prepared_path,
        audio_sha256=lambda _path: "d" * 64,
        measure_duration=lambda _path: 212.4,
    )

    assert resolved is not None
    assert resolved.asset.provider == "spotdl"
    assert resolved.asset.local_path == prepared_path
    assert prepare_calls == ["spotdl"]


def test_scan_audio_candidates_includes_non_wav_local_audio_files(tmp_path: Path) -> None:
    artist_dir = tmp_path / "Test Artist"
    artist_dir.mkdir()
    expected_path = artist_dir / "Test Song.mp3"
    expected_path.write_bytes(b"")
    (artist_dir / "Different Song.wav").write_bytes(b"")

    candidates = scan_audio_candidates([tmp_path], _observation())

    assert [candidate.local_path for candidate in candidates] == [expected_path]


def test_scan_audio_candidates_ignores_appledouble_sidecars(tmp_path: Path) -> None:
    artist_dir = tmp_path / "Test Artist"
    artist_dir.mkdir()
    expected_path = artist_dir / "Test Song.mp3"
    expected_path.write_bytes(b"")
    (artist_dir / "._Test Song.mp3").write_bytes(b"appledouble")

    candidates = scan_audio_candidates([tmp_path], _observation())

    assert [candidate.local_path for candidate in candidates] == [expected_path]


def test_scan_audio_candidates_returns_empty_for_empty_title(tmp_path: Path) -> None:
    track_path = tmp_path / "Anything.mp3"
    track_path.write_bytes(b"")

    observation = _observation()
    observation.title = ""

    assert scan_audio_candidates([tmp_path], observation) == []


def test_scan_audio_candidates_returns_empty_for_punctuation_only_title(tmp_path: Path) -> None:
    track_path = tmp_path / "Anything.mp3"
    track_path.write_bytes(b"")

    observation = _observation()
    observation.title = " -- ... !!! "

    assert scan_audio_candidates([tmp_path], observation) == []


def test_parse_provider_candidates_skips_rows_with_invalid_duration_or_artist_payload() -> None:
    candidates = _parse_provider_candidates(
        "spotdl",
        """
        [
          {"title": "Zero Duration", "artist": "Artist", "duration_seconds": 0},
          {"title": "Negative Duration", "artist": "Artist", "duration_seconds": -5},
          {"title": "Bad Artist", "artist": ["not", "a", "string"], "duration_seconds": 212.0},
          {"title": "Good Row", "artist": "Artist", "duration_seconds": 212.0}
        ]
        """,
    )

    assert [candidate.title for candidate in candidates] == ["Good Row"]


def test_resolve_audio_asset_continues_when_first_provider_raises(tmp_path: Path) -> None:
    observation = _observation(duration_seconds=212.0)
    prepared_path = tmp_path / "prepared.mp3"

    def broken_provider(_observation: TrackObservation) -> list[ProviderCandidate]:
        raise RuntimeError("temporary provider failure")

    def working_provider(_observation: TrackObservation) -> list[ProviderCandidate]:
        return [_candidate("spotdl", reported_duration_seconds=212.0)]

    resolved = resolve_audio_asset(
        observation,
        providers=[broken_provider, working_provider],
        disk_candidates=[],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda _candidate: prepared_path,
        audio_sha256=lambda _path: "e" * 64,
        measure_duration=lambda _path: 212.0,
    )

    assert resolved is not None
    assert resolved.asset.provider == "spotdl"


def test_resolve_audio_asset_accepts_exact_hinted_disk_path_despite_duration_mismatch(tmp_path: Path) -> None:
    hinted_path = tmp_path / "Franky Rizardo - Baile De Fantome.mp3"
    cached_path = tmp_path / "cache" / hinted_path.name
    observation = _observation(duration_seconds=427.0)
    observation.title = "Baile De Fantome"
    observation.artist = "Franky Rizardo"
    observation.source_hint_path = hinted_path

    resolved = resolve_audio_asset(
        observation,
        providers=[],
        disk_candidates=[
            ProviderCandidate(
                provider="disk",
                title=hinted_path.stem,
                artist="Franky Rizardo",
                reported_duration_seconds=None,
                local_path=hinted_path,
                metadata_confidence=1.0,
            )
        ],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda _candidate: cached_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 435.6997,
    )

    assert resolved is not None
    assert resolved.asset.provider == "disk"
    assert resolved.asset.local_path == cached_path
    assert resolved.asset.measured_duration_seconds == 435.6997
