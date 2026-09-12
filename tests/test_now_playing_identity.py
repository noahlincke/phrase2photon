from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from phrase2photon.now_playing.identity import audio_identity_slug, normalize_name
from phrase2photon.now_playing.models import PreparedAudioAsset, TrackObservation


def _observation(*, source_app: str, title: str, artist: str, duration_seconds: float) -> TrackObservation:
    return TrackObservation(
        source_app=source_app,
        title=title,
        artist=artist,
        duration_seconds=duration_seconds,
        observed_at=datetime(2026, 5, 15, 12, 0, tzinfo=UTC),
    )


def _asset(*, duration_seconds: float, sha: str) -> PreparedAudioAsset:
    return PreparedAudioAsset(
        local_path=Path("/tmp/test-track.wav"),
        measured_duration_seconds=duration_seconds,
        audio_sha256=sha,
        provider="test",
    )


def test_audio_identity_ignores_source_app_for_same_prepared_audio() -> None:
    spotify = _observation(
        source_app="spotify",
        title="My Song!!!",
        artist="The Artist",
        duration_seconds=215.1,
    )
    rekordbox = _observation(
        source_app="rekordbox",
        title="my song",
        artist="the artist",
        duration_seconds=215.1,
    )
    asset = _asset(duration_seconds=214.96, sha="a" * 64)

    assert audio_identity_slug(spotify, asset) == audio_identity_slug(rekordbox, asset)


def test_audio_identity_ignores_differing_or_missing_observation_metadata() -> None:
    complete_metadata = _observation(
        source_app="spotify",
        title="Festival Intro Edit",
        artist="DJ Example",
        duration_seconds=215.1,
    )
    missing_metadata = _observation(
        source_app="files",
        title="Unknown Track",
        artist="",
        duration_seconds=198.4,
    )
    asset = _asset(duration_seconds=214.96, sha="c" * 64)

    assert audio_identity_slug(complete_metadata, asset) == audio_identity_slug(missing_metadata, asset)


def test_audio_identity_ignores_asset_provider_for_same_prepared_audio() -> None:
    observation = _observation(
        source_app="spotify",
        title="Provider Test",
        artist="DJ Example",
        duration_seconds=200.0,
    )
    disk_asset = PreparedAudioAsset(
        local_path=Path("/tmp/test-track.wav"),
        measured_duration_seconds=214.96,
        audio_sha256="d" * 64,
        provider="disk",
    )
    spotdl_asset = PreparedAudioAsset(
        local_path=Path("/tmp/test-track.wav"),
        measured_duration_seconds=214.96,
        audio_sha256="d" * 64,
        provider="spotdl",
    )

    assert audio_identity_slug(observation, disk_asset) == audio_identity_slug(observation, spotdl_asset)


def test_audio_identity_keeps_distinct_edits_separate_by_duration() -> None:
    observation = _observation(
        source_app="spotify",
        title="Club Edit",
        artist="DJ Example",
        duration_seconds=240.0,
    )
    sha = "b" * 64
    radio_edit = _asset(duration_seconds=209.2, sha=sha)
    extended_edit = _asset(duration_seconds=241.8, sha=sha)

    assert audio_identity_slug(observation, radio_edit) != audio_identity_slug(observation, extended_edit)


def test_normalize_name_casefolds_and_strips_punctuation() -> None:
    assert normalize_name("  Bjork's  -- Army...  ") == "bjork s army"


def test_normalize_name_unicode_normalizes_equivalent_forms() -> None:
    assert normalize_name("Bjo\u0308rk") == normalize_name("Björk")
