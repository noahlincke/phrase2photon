import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from phrase2photon.cli import _load_extraction
from phrase2photon.now_playing.models import PreparedAudioAsset, ProviderCandidate, ResolvedNowPlayingTrack, TrackObservation
from phrase2photon.now_playing.source_polling import poll_osascript_app
from phrase2photon.now_playing.server import (
    NowPlayingService,
    _preserve_playback_if_needed,
    build_status_payload,
    current_status_payload,
    ensure_compiled_show,
    poll_now_playing_source,
    route_request,
)


@pytest.fixture(autouse=True)
def _no_rekordbox(monkeypatch) -> None:
    # Test files are not in the Rekordbox collection; keep show preparation from
    # opening the real database while it proves that.
    monkeypatch.setattr(
        "phrase2photon.now_playing.server.load_rekordbox_analysis", lambda _path: None
    )


def _observation(*, observed_at: datetime | None = None) -> TrackObservation:
    return TrackObservation(
        source_app="Music",
        title="Example Set",
        artist="DJ Example",
        duration_seconds=1200.0,
        observed_at=observed_at or datetime(2026, 5, 15, 22, 30, tzinfo=UTC),
    )


def _await_status(
    service: NowPlayingService,
    predicate,
    *,
    attempts: int = 40,
    delay_seconds: float = 0.01,
):
    last_payload = service.status_payload()
    for _ in range(attempts):
        if predicate(last_payload):
            return last_payload
        time.sleep(delay_seconds)
        last_payload = service.status_payload()
    return last_payload


def _sequence_poll_source(observations: list[TrackObservation | None]):
    queue = list(observations)

    def poll():
        if len(queue) > 1:
            return queue.pop(0)
        return queue[0]

    return poll


def test_poll_now_playing_source_prefers_freshest_observation(monkeypatch) -> None:
    stale_rekordbox = TrackObservation(
        source_app="Rekordbox",
        title="ID4 (from GuduMix 070: Jordan Peak) [Mixed]",
        artist="ID",
        duration_seconds=263.0,
        observed_at=datetime(2026, 4, 4, 17, 32, 43, 954000, tzinfo=UTC),
    )
    fresh_music = TrackObservation(
        source_app="Music",
        title="Extract",
        artist="Across Boundaries, Chris Stussy & Locklead",
        duration_seconds=453.709,
        observed_at=datetime(2026, 5, 16, 21, 48, 39, 275856, tzinfo=UTC),
    )
    monkeypatch.setattr("phrase2photon.now_playing.server.poll_rekordbox", lambda: stale_rekordbox)
    monkeypatch.setattr("phrase2photon.now_playing.server.poll_virtualdj", lambda: None)
    monkeypatch.setattr("phrase2photon.now_playing.server.poll_system_now_playing", lambda: fresh_music)

    observation = poll_now_playing_source()

    assert observation == fresh_music


def test_build_status_payload_exposes_reactive_fallback_and_ready_show_urls() -> None:
    observation = _observation().model_copy(
        update={
            "playback_position_seconds": 142.5,
            "is_playing": True,
        }
    )
    asset = PreparedAudioAsset(
        local_path=Path("/Users/nlincke/Phrase2PhotonShows/now-playing/tracks/example/prepared-audio.wav"),
        measured_duration_seconds=1200.0,
        audio_sha256="abc123",
        provider="disk",
    )

    payload = build_status_payload(
        observation=observation,
        mode_state="reactive_fallback",
        active_show_id=None,
        armed_show_id="example-show",
        prepared_asset=asset,
        show_dir=Path("/Users/nlincke/Phrase2PhotonShows/now-playing/tracks/example/show"),
        provider_attempts=[{"provider": "disk", "status": "hit", "message": "local cache"}],
        preparing=None,
    )

    assert payload["modeState"] == "reactive_fallback"
    assert payload["armedShow"] == {
        "id": "example-show",
        "showUrl": "/api/now-playing/show/example-show",
    }
    assert payload["preparedAudio"] == {
        "path": str(asset.local_path),
        "audioUrl": "/api/now-playing/audio/example-show",
        "durationSeconds": 1200.0,
        "provider": "disk",
    }
    assert payload["observation"]["playback_position_seconds"] == 142.5
    assert payload["observation"]["is_playing"] is True
    assert payload["preparing"] is None
    assert payload["providerAttempts"] == [{"provider": "disk", "status": "hit", "message": "local cache"}]


def test_build_status_payload_exposes_preparation_progress() -> None:
    payload = build_status_payload(
        observation=_observation(),
        mode_state="reactive_fallback",
        active_show_id=None,
        armed_show_id=None,
        prepared_asset=None,
        show_dir=None,
        provider_attempts=[],
        preparing={
            "showId": "track-a",
            "stage": "compiling_show",
            "message": "Compiling show from cached audio.",
        },
    )

    assert payload["preparing"] == {
        "showId": "track-a",
        "stage": "compiling_show",
        "message": "Compiling show from cached audio.",
    }


def test_build_status_payload_exposes_source_diagnostics() -> None:
    payload = build_status_payload(
        observation=_observation().model_copy(update={"source_app": "Rekordbox"}),
        mode_state="reactive_fallback",
        active_show_id=None,
        armed_show_id=None,
        prepared_asset=None,
        show_dir=None,
        provider_attempts=[],
        preparing=None,
        source_diagnostics={
            "sourceApp": "Rekordbox",
            "databaseLoaded": True,
            "selectedPath": "/Volumes/MUSIC/example.mp3",
            "selectedVia": "open_audio_db_match",
            "openAudioCandidates": [],
            "recentEventContentIds": [],
        },
    )

    assert payload["sourceDiagnostics"] == {
        "sourceApp": "Rekordbox",
        "databaseLoaded": True,
        "selectedPath": "/Volumes/MUSIC/example.mp3",
        "selectedVia": "open_audio_db_match",
        "openAudioCandidates": [],
        "recentEventContentIds": [],
    }


def test_route_request_rekordbox_debug_endpoint_forces_poll(monkeypatch) -> None:
    monkeypatch.setattr(
        "phrase2photon.now_playing.server.poll_rekordbox",
        lambda: _observation().model_copy(update={"source_app": "Rekordbox"}),
    )
    monkeypatch.setattr(
        "phrase2photon.now_playing.server.last_rekordbox_diagnostics",
        lambda: {
            "sourceApp": "Rekordbox",
            "databaseLoaded": True,
            "selectedPath": "/Volumes/MUSIC/example.mp3",
            "selectedVia": "open_audio_db_match",
            "openAudioCandidates": [],
            "recentEventContentIds": [],
        },
    )

    response = route_request("/api/now-playing/debug/rekordbox")

    assert response.status_code == 200
    assert response.body is not None
    assert json.loads(response.body.decode("utf-8"))["selectedPath"] == "/Volumes/MUSIC/example.mp3"


def test_preserve_playback_keeps_rekordbox_clock_advancing_when_position_signal_disappears(monkeypatch) -> None:
    previous_observed_at = datetime(2026, 5, 16, 22, 0, 0, tzinfo=UTC)

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 5, 16, 22, 0, 4, tzinfo=UTC)

    monkeypatch.setattr("phrase2photon.now_playing.server.datetime", FrozenDateTime)

    previous = TrackObservation(
        source_app="Rekordbox",
        title="Want You",
        artist="GIGSTA",
        duration_seconds=386.0,
        observed_at=previous_observed_at,
        source_hint_path=Path("/Volumes/MUSIC/Deep_Minimal_3_/GIGSTA_-_Want_You_-_Radio_Edit.mp3"),
        playback_position_seconds=120.0,
        is_playing=True,
    )
    current = TrackObservation(
        source_app="Rekordbox",
        title="Want You",
        artist="GIGSTA",
        duration_seconds=386.0,
        observed_at=datetime(2026, 5, 16, 22, 0, 4, tzinfo=UTC),
        source_hint_path=previous.source_hint_path,
        playback_position_seconds=None,
        is_playing=False,
    )

    preserved = _preserve_playback_if_needed(previous, current)

    assert preserved.playback_position_seconds is not None
    assert preserved.playback_position_seconds >= 124.0
    assert preserved.is_playing is True


def test_now_playing_service_promotes_to_premade_active_for_ready_disk_audio(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Example Set"}}), encoding="utf-8")
    observation = _observation()

    def ensure_show(resolved: ResolvedNowPlayingTrack) -> Path:
        resolved.show_dir = show_dir
        return show_dir

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=ensure_show,
    )

    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert payload["modeState"] == "premade_active"
    assert payload["activeShowId"] == payload["armedShow"]["id"]
    assert payload["armedShow"]["showUrl"] == f"/api/now-playing/show/{payload['activeShowId']}"
    assert payload["preparedAudio"] == {
        "path": str(audio_path),
        "audioUrl": f"/api/now-playing/audio/{payload['activeShowId']}",
        "durationSeconds": 1200.0,
        "provider": "disk",
    }
    assert payload["providerAttempts"] == [{"provider": "disk", "status": "hit", "message": "resolved from Example Set"}]


def test_now_playing_service_resolves_the_source_hint_file_itself(tmp_path: Path) -> None:
    """An unprepared on-air track starts preparing from the file the deck loaded.

    Demo-library tracks sit outside the scanned candidate roots, so the disk
    scan finds nothing; the observation still carries the exact path Rekordbox
    is playing, and preparation must use it instead of stalling until a
    provider happens to match.
    """
    audio_path = tmp_path / "music" / "PioneerDJ" / "Demo Tracks" / "Demo Track 1.mp3"
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    audio_path.write_bytes(b"mp3")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Demo Track 1"}}), encoding="utf-8")
    observation = TrackObservation(
        source_app="Rekordbox",
        title="Demo Track 1",
        artist="Loopmasters",
        duration_seconds=214.0,
        observed_at=datetime.now(UTC),
        source_hint_path=audio_path,
        is_playing=True,
        deck=1,
    )

    service = NowPlayingService(
        cache_root=tmp_path / "cache",
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 214.0,
        ensure_show=lambda resolved: show_dir,
    )

    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert payload["modeState"] == "premade_active"
    assert payload["preparedAudio"]["path"] == str(audio_path)
    assert payload["providerAttempts"] == [
        {"provider": "disk", "status": "hit", "message": "resolved from Demo Track 1"}
    ]


def test_now_playing_service_accepts_exact_hinted_disk_file_despite_duration_mismatch(tmp_path: Path) -> None:
    source_audio_path = tmp_path / "Franky Rizardo - Baile De Fantome.mp3"
    source_audio_path.write_bytes(b"mp3")
    cached_audio_path = tmp_path / "cache" / source_audio_path.name
    cached_audio_path.parent.mkdir(parents=True, exist_ok=True)
    cached_audio_path.write_bytes(b"mp3-copy")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Baile De Fantome"}}), encoding="utf-8")
    observation = TrackObservation(
        source_app="Rekordbox",
        title="Baile De Fantome",
        artist="Franky Rizardo",
        duration_seconds=427.0,
        observed_at=datetime(2026, 5, 16, 21, 12, tzinfo=UTC),
        source_hint_path=source_audio_path,
    )

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title=source_audio_path.stem,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=source_audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda _candidate: cached_audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 435.6997,
        ensure_show=lambda _resolved: show_dir,
    )

    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert payload["modeState"] == "premade_active"
    assert payload["preparedAudio"] == {
        "path": str(cached_audio_path),
        "audioUrl": f"/api/now-playing/audio/{payload['activeShowId']}",
        "durationSeconds": 435.6997,
        "provider": "disk",
    }
    assert payload["providerAttempts"] == [
        {"provider": "disk", "status": "hit", "message": "resolved from Baile De Fantome"}
    ]


def test_now_playing_service_ignores_stale_observations(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    observations = [
        _observation(observed_at=datetime(2026, 5, 15, 22, 31, tzinfo=UTC)),
        _observation(observed_at=datetime(2026, 5, 15, 22, 30, tzinfo=UTC)),
    ]

    current_index = {"value": 0}

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observations[current_index["value"]],
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title="Example Set",
                artist="DJ Example",
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=lambda resolved: show_dir,
    )

    first = _await_status(service, lambda item: item["modeState"] == "premade_active")
    current_index["value"] = 1
    second = service.status_payload()

    assert first["modeState"] == "premade_active"
    assert second == first


def test_now_playing_service_resets_stale_guard_after_source_gap(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    observations = [
        _observation(observed_at=datetime(2026, 5, 15, 22, 31, tzinfo=UTC)),
        None,
        _observation(observed_at=datetime(2026, 5, 15, 22, 30, tzinfo=UTC)),
    ]

    current_index = {"value": 0}

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observations[current_index["value"]],
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title="Example Set",
                artist="DJ Example",
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=lambda resolved: show_dir,
    )

    first = _await_status(service, lambda item: item["modeState"] == "premade_active")
    current_index["value"] = 1
    gap = service.status_payload()
    current_index["value"] = 2
    resumed = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert first["modeState"] == "premade_active"
    assert gap["modeState"] == "reactive_fallback"
    assert resumed["modeState"] == "premade_active"


def test_now_playing_service_falls_back_when_show_preparation_fails(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    observation = _observation()

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=lambda _resolved: (_ for _ in ()).throw(RuntimeError("compile boom")),
    )

    payload = _await_status(
        service,
        lambda item: item["preparing"] is None and len(item["providerAttempts"]) > 0,
    )

    assert payload["modeState"] == "reactive_fallback"
    assert payload["armedShow"] is None
    assert payload["preparedAudio"] is None
    assert payload["providerAttempts"][-1] == {
        "provider": "disk",
        "status": "error",
        "message": "show preparation failed: compile boom",
    }


def test_now_playing_service_rejects_candidate_when_audio_fingerprint_fails(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    observation = _observation()

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: (_ for _ in ()).throw(RuntimeError("hash boom")),
        measure_duration=lambda _path: 1200.0,
        ensure_show=lambda resolved: tmp_path / "unused",
    )

    payload = _await_status(
        service,
        lambda item: item["preparing"] is None and len(item["providerAttempts"]) > 0,
    )

    assert payload["modeState"] == "reactive_fallback"
    assert payload["providerAttempts"] == [
        {
            "provider": "disk",
            "status": "rejected",
            "message": "Example Set: fingerprint failed (hash boom)",
        }
    ]


def test_ensure_compiled_show_uses_injected_cache_root(tmp_path: Path) -> None:
    audio_path = tmp_path / "prepared.wav"
    audio_path.write_bytes(b"RIFFexample")
    resolved = ResolvedNowPlayingTrack(
        observation=_observation(),
        asset=PreparedAudioAsset(
            local_path=audio_path,
            measured_duration_seconds=1200.0,
            audio_sha256="f" * 64,
            provider="disk",
        ),
        audio_identity="example-show",
    )
    show_dir = tmp_path / "example-show" / "show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Example Set"}}), encoding="utf-8")

    compiled_dir = ensure_compiled_show(resolved, cache_root=tmp_path)

    assert compiled_dir == show_dir
    assert resolved.show_dir == show_dir


def test_route_request_status_promotes_from_fallback_to_ready_show(tmp_path: Path) -> None:
    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    show_root = tmp_path / "example-ready"
    show_dir = show_root / "show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Example Set"}}), encoding="utf-8")
    observation = _observation()
    disk_batches = [
        [],
        [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
    ]

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: disk_batches.pop(0),
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "a" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=lambda resolved: show_dir,
    )

    fallback_response = route_request("/api/now-playing/status", cache_root=tmp_path, status_provider=service.status_payload)
    _await_status(service, lambda item: item["modeState"] == "premade_active")
    ready_response = route_request("/api/now-playing/status", cache_root=tmp_path, status_provider=service.status_payload)
    fallback_payload = json.loads(fallback_response.body.decode("utf-8"))
    ready_payload = json.loads(ready_response.body.decode("utf-8"))

    assert fallback_payload["modeState"] == "reactive_fallback"
    assert fallback_payload["observation"]["title"] == "Example Set"
    assert fallback_payload["armedShow"] is None
    assert fallback_payload["preparedAudio"] is None

    assert ready_payload["modeState"] == "premade_active"
    assert ready_payload["activeShowId"] == ready_payload["armedShow"]["id"]
    assert ready_payload["preparedAudio"]["audioUrl"] == f"/api/now-playing/audio/{ready_payload['activeShowId']}"


def test_route_request_serves_cached_show_and_audio_files(tmp_path: Path) -> None:
    cache_root = tmp_path
    show_root = cache_root / "example-show"
    show_dir = show_root / "show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Example Set"}}), encoding="utf-8")
    (show_root / "prepared-audio.wav").write_bytes(b"RIFFexample")

    show_response = route_request("/api/now-playing/show/example-show", cache_root=cache_root)
    audio_response = route_request("/api/now-playing/audio/example-show", cache_root=cache_root)
    status_response = route_request(
        "/api/now-playing/status",
        cache_root=cache_root,
        status_provider=current_status_payload,
    )

    assert show_response.status_code == 200
    assert show_response.content_type == "application/json"
    assert json.loads(show_response.body.decode("utf-8")) == {"song": {"title": "Example Set"}}
    assert show_response.content_length == len(show_response.body)

    assert audio_response.status_code == 200
    assert audio_response.content_type == "audio/wav"
    assert audio_response.body is None
    assert audio_response.file_path == show_root / "prepared-audio.wav"
    assert audio_response.content_length == len(b"RIFFexample")
    assert audio_response.headers["Accept-Ranges"] == "bytes"
    assert b"".join(audio_response.iter_body()) == b"RIFFexample"

    assert status_response.status_code == 200
    assert json.loads(status_response.body.decode("utf-8"))["modeState"] == "reactive_fallback"


def test_route_request_lists_cached_now_playing_tracks(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_dir = show_root / "show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(
        json.dumps({"song": {"title": "Example Set", "tempo": 124.0}}),
        encoding="utf-8",
    )
    (show_root / "prepared-audio.wav").write_bytes(b"RIFFexample")

    response = route_request("/api/now-playing/library", cache_root=tmp_path)

    assert response.status_code == 200
    payload = json.loads(response.body.decode("utf-8"))
    assert payload == {
        "tracks": [
            {
                "id": "example-show",
                "title": "Example Set",
                "artist": None,
                "abletonProjectPath": None,
                "bpm": 124.0,
                "notes": "Cached from Now Playing",
                "audioUrl": "/api/now-playing/audio/example-show",
                "showUrl": "/api/now-playing/show/example-show",
                "exportShowUrl": "/api/now-playing/show/example-show",
            }
        ]
    }


def test_route_request_head_for_audio_is_bodyless_and_file_backed(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_root.mkdir(parents=True, exist_ok=True)
    audio_path = show_root / "prepared-audio.wav"
    audio_path.write_bytes(b"RIFFexample")

    response = route_request("/api/now-playing/audio/example-show", cache_root=tmp_path, method="HEAD")

    assert response.status_code == 200
    assert response.body is None
    assert response.file_path == audio_path
    assert response.content_length == len(b"RIFFexample")
    assert response.headers["Accept-Ranges"] == "bytes"


def test_route_request_serves_partial_audio_range(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_root.mkdir(parents=True, exist_ok=True)
    audio_path = show_root / "prepared-audio.wav"
    audio_path.write_bytes(b"0123456789")

    response = route_request(
        "/api/now-playing/audio/example-show",
        cache_root=tmp_path,
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206
    assert response.content_length == 4
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.headers["Content-Range"] == "bytes 2-5/10"
    assert b"".join(response.iter_body()) == b"2345"


def test_route_request_serves_suffix_audio_range(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_root.mkdir(parents=True, exist_ok=True)
    audio_path = show_root / "prepared-audio.wav"
    audio_path.write_bytes(b"0123456789")

    response = route_request(
        "/api/now-playing/audio/example-show",
        cache_root=tmp_path,
        headers={"Range": "bytes=-4"},
    )

    assert response.status_code == 206
    assert response.content_length == 4
    assert response.headers["Content-Range"] == "bytes 6-9/10"
    assert b"".join(response.iter_body()) == b"6789"


def test_route_request_rejects_unsatisfiable_audio_range(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_root.mkdir(parents=True, exist_ok=True)
    audio_path = show_root / "prepared-audio.wav"
    audio_path.write_bytes(b"0123456789")

    response = route_request(
        "/api/now-playing/audio/example-show",
        cache_root=tmp_path,
        headers={"Range": "bytes=20-30"},
    )

    assert response.status_code == 416
    assert response.content_length == 0
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.headers["Content-Range"] == "bytes */10"
    assert response.body == b""


def test_route_request_head_for_audio_range_is_bodyless_and_range_aware(tmp_path: Path) -> None:
    show_root = tmp_path / "example-show"
    show_root.mkdir(parents=True, exist_ok=True)
    audio_path = show_root / "prepared-audio.wav"
    audio_path.write_bytes(b"0123456789")

    response = route_request(
        "/api/now-playing/audio/example-show",
        cache_root=tmp_path,
        method="HEAD",
        headers={"Range": "bytes=1-3"},
    )

    assert response.status_code == 206
    assert response.body is None
    assert response.file_path == audio_path
    assert response.content_length == 3
    assert response.headers["Content-Range"] == "bytes 1-3/10"


def test_poll_osascript_app_parses_json_payload_with_delimiters_and_missing_artist() -> None:
    def runner(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["osascript"],
            returncode=0,
            stdout='{"title":"A || B","artist":null,"duration_seconds":123.5}',
            stderr="",
        )

    observation = poll_osascript_app(
        source_app="Music",
        app_name="Music",
        script_body="return \"ignored by test runner\"",
        runner=runner,
    )

    assert observation is not None
    assert observation.title == "A || B"
    assert observation.artist is None
    assert observation.duration_seconds == 123.5


def test_poll_osascript_app_treats_missing_value_artist_string_as_none() -> None:
    def runner(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["osascript"],
            returncode=0,
            stdout='{"title":"Track","artist":"missing value","duration_seconds":98}',
            stderr="",
        )

    observation = poll_osascript_app(
        source_app="Music",
        app_name="Music",
        script_body="return \"ignored by test runner\"",
        runner=runner,
    )

    assert observation is not None
    assert observation.artist is None


def test_poll_osascript_app_parses_playback_position_and_player_state() -> None:
    def runner(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=["osascript"],
            returncode=0,
            stdout='{"title":"Extract","artist":"Chris Stussy","duration_seconds":453.7,"playback_position_seconds":127.25,"is_playing":true}',
            stderr="",
        )

    observation = poll_osascript_app(
        source_app="Music",
        app_name="Music",
        script_body="return \"ignored by test runner\"",
        runner=runner,
    )

    assert observation is not None
    assert observation.playback_position_seconds == 127.25
    assert observation.is_playing is True


def test_load_extraction_derives_legacy_phrases_when_locators_exist_but_phrases_are_missing(tmp_path: Path) -> None:
    extraction_path = tmp_path / "legacy-extraction.json"
    extraction_path.write_text(
        json.dumps(
            {
                "source_name": "Legacy Set",
                "tempo": 124.0,
                "time_signature": "4/4",
                "locators": [
                    {"locator_id": "l0", "name": "Intro", "time": "1|1", "order_index": 0},
                    {"locator_id": "l1", "name": "Drop", "time": "17|1", "order_index": 1},
                ],
                "tracks": [],
            }
        ),
        encoding="utf-8",
    )

    extraction = _load_extraction(str(extraction_path))

    assert [phrase.name for phrase in extraction.phrases] == ["Intro", "Drop"]


def test_load_extraction_derives_legacy_phrases_when_phrase_list_is_empty(tmp_path: Path) -> None:
    extraction_path = tmp_path / "legacy-empty-phrases.json"
    extraction_path.write_text(
        json.dumps(
            {
                "source_name": "Legacy Set",
                "tempo": 124.0,
                "time_signature": "4/4",
                "locators": [
                    {"locator_id": "l0", "name": "Intro", "time": "1|1", "order_index": 0},
                    {"locator_id": "l1", "name": "Drop", "time": "17|1", "order_index": 1},
                ],
                "tracks": [],
                "phrases": [],
            }
        ),
        encoding="utf-8",
    )

    extraction = _load_extraction(str(extraction_path))

    assert [phrase.name for phrase in extraction.phrases] == ["Intro", "Drop"]


def test_service_clock_payload_passes_resolved_show_identity(tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    class RecordingStream:
        def clock_payload(self, *, observation_title=None, observation_artist=None, show_id=None):
            captured["show_id"] = show_id
            return {"status": "exact"}

        def on_air_deck_number(self):
            return None

        def on_air_deck_state(self, *, observation_title=None, observation_artist=None):
            return None

    audio_path = tmp_path / "example-set.wav"
    audio_path.write_bytes(b"RIFFexample")
    show_dir = tmp_path / "compiled-show"
    show_dir.mkdir(parents=True, exist_ok=True)
    (show_dir / "show.json").write_text(json.dumps({"song": {"title": "Example Set"}}), encoding="utf-8")
    observation = _observation()

    def ensure_show(resolved: ResolvedNowPlayingTrack) -> Path:
        resolved.show_dir = show_dir
        return show_dir

    service = NowPlayingService(
        cache_root=tmp_path,
        min_refresh_interval_seconds=0.0,
        poll_source=lambda: observation,
        disk_candidates_fn=lambda _observation: [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=audio_path,
                metadata_confidence=1.0,
            )
        ],
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path or audio_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 1200.0,
        ensure_show=ensure_show,
        memory_stream=RecordingStream(),
    )
    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")
    assert payload["modeState"] == "premade_active"
    assert payload["activeShowId"] is not None
    service.clock_payload()
    assert captured["show_id"] == payload["activeShowId"]
