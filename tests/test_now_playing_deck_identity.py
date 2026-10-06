"""Show identity must follow the deck the transport clock follows.

The agent log records the last loaded track, which during a transition
describes the incoming deck while the outgoing one is still playing; the
memory stream's playing-deck rule decides which deck is actually on air. These
tests pin the show, the observation identity and the switch latency to that
rule.
"""

import json
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from phrase2photon.now_playing import rekordbox_analysis, source_polling
from phrase2photon.now_playing.models import ProviderCandidate, TrackObservation
from phrase2photon.now_playing.rekordbox_analysis import RekordboxContentInfo
from phrase2photon.now_playing.rekordbox_stream import RekordboxMemoryStream
from phrase2photon.now_playing.server import NowPlayingService

COYHAIQUE = "Coyhaique (Extended Mix)"
COYHAIQUE_ARTIST = "DJ PP, Gabriel Rocha"
RAGS = "Rags _feat. Flamant Rouge_"
RAGS_ARTIST = "Vitess"

TICK = "tick mono_ns={n} master=-1 d1={d1} d2={d2} d3=-1,-1 d4=-1,-1\n"


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _stream(clock: FakeClock) -> RekordboxMemoryStream:
    return RekordboxMemoryStream(clock=clock, pause_fn=lambda _seconds: None)


def _feed_tick(stream: RekordboxMemoryStream, clock: FakeClock, *, d1: str, d2: str) -> None:
    clock.advance(0.05)
    stream._apply_line(TICK.format(n=int(clock.now * 1e9), d1=d1, d2=d2))


def _feed_track(stream: RekordboxMemoryStream, deck: int, title: str, artist: str) -> None:
    stream._apply_line(f"track deck={deck}\ttitle={title}\tartist={artist}\tanlz=")


def _log_observation(title: str, artist: str, duration_seconds: float) -> TrackObservation:
    return TrackObservation(
        source_app="Rekordbox",
        title=title,
        artist=artist,
        duration_seconds=duration_seconds,
        observed_at=datetime.now(UTC),
    )


def _make_service(
    tmp_path: Path,
    *,
    stream: RekordboxMemoryStream,
    log_observation_fn,
    min_refresh_interval_seconds: float = 0.0,
) -> tuple[NowPlayingService, Path, Path]:
    audio_root = tmp_path / "music"
    audio_root.mkdir(parents=True, exist_ok=True)
    coyhaique_audio = audio_root / f"{COYHAIQUE_ARTIST} - {COYHAIQUE}.wav"
    rags_audio = audio_root / f"{RAGS_ARTIST} - {RAGS}.wav"
    for path in (coyhaique_audio, rags_audio):
        path.write_bytes(b"RIFFfakewav")

    def ensure_show(resolved):
        show_dir = tmp_path / "shows" / resolved.observation.title / "show"
        show_dir.mkdir(parents=True, exist_ok=True)
        (show_dir / "show.json").write_text(
            json.dumps({"song": {"title": resolved.observation.title}}), encoding="utf-8"
        )
        resolved.show_dir = show_dir
        return show_dir

    def disk_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
        path = audio_root / f"{observation.artist} - {observation.title}.wav"
        if not path.exists():
            return []
        return [
            ProviderCandidate(
                provider="disk",
                title=observation.title,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=path,
                metadata_confidence=1.0,
            )
        ]

    service = NowPlayingService(
        cache_root=tmp_path / "shows",
        min_refresh_interval_seconds=min_refresh_interval_seconds,
        poll_source=lambda: log_observation_fn(),
        disk_candidates_fn=disk_candidates,
        provider_fns=[],
        prepare_audio=lambda candidate: candidate.local_path,
        audio_sha256=lambda _path: "f" * 64,
        measure_duration=lambda _path: 392.0,
        ensure_show=ensure_show,
        memory_stream=stream,
    )
    return service, coyhaique_audio, rags_audio


def _patch_deck_database(monkeypatch, audio_by_title: dict[str, Path]) -> None:
    """Stands in for the master.db collection lookup by title+artist."""

    def title_artist(title: str, artist: str | None) -> RekordboxContentInfo | None:
        path = audio_by_title.get(title)
        if path is None:
            return None
        return RekordboxContentInfo(
            folder_path=str(path), title=title, artist=artist, duration_seconds=392.0
        )

    monkeypatch.setattr(source_polling, "content_for_anlz_path", lambda _anlz: None)
    monkeypatch.setattr(source_polling, "content_for_title_artist", title_artist)


def _await_status(service: NowPlayingService, predicate, *, attempts: int = 300):
    payload = service.status_payload()
    for _ in range(attempts):
        if predicate(payload):
            return payload
        time.sleep(0.01)
        payload = service.status_payload()
    return payload


def _playing_rehearsal(
    tmp_path: Path, monkeypatch, *, min_refresh_interval_seconds: float = 0.0
):
    """Deck 1 playing Coyhaique, deck 2 loaded Rags, log claiming Rags."""
    clock = FakeClock()
    stream = _stream(clock)
    _feed_track(stream, 1, COYHAIQUE, COYHAIQUE_ARTIST)
    _feed_track(stream, 2, RAGS, RAGS_ARTIST)
    service, coyhaique_audio, rags_audio = _make_service(
        tmp_path,
        stream=stream,
        log_observation_fn=lambda: _log_observation(RAGS, RAGS_ARTIST, 409.0),
        min_refresh_interval_seconds=min_refresh_interval_seconds,
    )
    _patch_deck_database(monkeypatch, {COYHAIQUE: coyhaique_audio, RAGS: rags_audio})
    return clock, stream, service, coyhaique_audio, rags_audio


def test_playing_deck_supplies_show_identity_and_deck_number(tmp_path: Path, monkeypatch) -> None:
    clock, stream, service, coyhaique_audio, _rags_audio = _playing_rehearsal(tmp_path, monkeypatch)
    position = 0
    for _ in range(4):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="7761,125.000")

    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert payload["observation"]["title"] == COYHAIQUE
    assert payload["observation"]["deck"] == 1
    assert payload["observation"]["source_hint_path"] == str(coyhaique_audio)
    assert payload["modeState"] == "premade_active"


def test_blend_keeps_the_outgoing_deck_on_air(tmp_path: Path, monkeypatch) -> None:
    clock, stream, service, _coyhaique_audio, _rags_audio = _playing_rehearsal(tmp_path, monkeypatch)
    position = 0
    for _ in range(4):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="7761,125.000")
    _await_status(service, lambda item: item["modeState"] == "premade_active")

    # Deck 2 joins: both playheads move, the playing deck keeps the slot.
    for _ in range(6):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2=f"{position + 44100},125.000")

    assert stream.on_air_deck_number() == 1
    payload = service.status_payload()
    assert payload["observation"]["deck"] == 1
    assert payload["observation"]["title"] == COYHAIQUE


def test_pause_switches_to_the_incoming_deck_within_half_a_second(tmp_path: Path, monkeypatch) -> None:
    clock, stream, service, _coyhaique_audio, _rags_audio = _playing_rehearsal(
        tmp_path, monkeypatch, min_refresh_interval_seconds=0.5
    )
    deck1 = 0
    deck2 = 7761
    for _ in range(4):
        deck1 += 2205
        _feed_tick(stream, clock, d1=f"{deck1},124.000", d2=f"{deck2},125.000")
    _await_status(service, lambda item: item["modeState"] == "premade_active")

    # Blend: deck 2 starts while deck 1 keeps playing.
    for _ in range(4):
        deck1 += 2205
        deck2 += 2205
        _feed_tick(stream, clock, d1=f"{deck1},124.000", d2=f"{deck2},125.000")

    # Deck 1 pauses; after the 300 ms stop window the incoming deck is on air.
    for _ in range(7):
        deck2 += 2205
        _feed_tick(stream, clock, d1=f"{deck1},124.000", d2=f"{deck2},125.000")

    assert stream.on_air_deck_number() == 2

    # The status still describes the outgoing deck: a clock sample from the
    # incoming deck must not drive its show.
    stale_clock = service.clock_payload()
    assert stale_clock["deck"] == 2
    assert stale_clock["showId"] is None

    # The deck change forces a prompt re-resolve past the 0.5 s refresh gate.
    payload = service.status_payload()
    assert payload["observation"]["title"] == RAGS
    assert payload["observation"]["deck"] == 2
    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")
    assert payload["modeState"] == "premade_active"

    fresh_clock = service.clock_payload()
    assert fresh_clock["deck"] == 2
    assert fresh_clock["showId"] == payload["activeShowId"]


def test_stream_not_exact_falls_back_to_the_log_observation(tmp_path: Path, monkeypatch) -> None:
    clock = FakeClock()
    stream = _stream(clock)  # no ticks: the stream is not exact
    service, _coyhaique_audio, _rags_audio = _make_service(
        tmp_path,
        stream=stream,
        log_observation_fn=lambda: _log_observation(RAGS, RAGS_ARTIST, 409.0),
    )
    _patch_deck_database(monkeypatch, {})

    payload = _await_status(service, lambda item: item["observation"] is not None)

    assert payload["observation"]["title"] == RAGS
    assert payload["observation"]["deck"] is None


def test_playing_deck_outranks_a_fresher_paused_other_source(tmp_path: Path, monkeypatch) -> None:
    """A paused Music.app holding the incoming track must not outvote the playing deck."""
    clock = FakeClock()
    stream = _stream(clock)
    _feed_track(stream, 1, COYHAIQUE, COYHAIQUE_ARTIST)
    _feed_track(stream, 2, RAGS, RAGS_ARTIST)
    service, coyhaique_audio, _rags_audio = _make_service(
        tmp_path,
        stream=stream,
        log_observation_fn=lambda: TrackObservation(
            source_app="Music",
            title=RAGS,
            artist=RAGS_ARTIST,
            duration_seconds=409.0,
            observed_at=datetime.now(UTC),
            playback_position_seconds=2.997,
            position_source="exact",
            is_playing=False,
        ),
    )
    _patch_deck_database(monkeypatch, {COYHAIQUE: coyhaique_audio})
    position = 0
    for _ in range(4):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="7761,125.000")

    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")

    assert payload["observation"]["source_app"] == "Rekordbox"
    assert payload["observation"]["title"] == COYHAIQUE
    assert payload["observation"]["deck"] == 1


def test_paused_deck_leaves_a_fresher_other_source_alone(tmp_path: Path, monkeypatch) -> None:
    clock = FakeClock()
    stream = _stream(clock)
    _feed_track(stream, 1, COYHAIQUE, COYHAIQUE_ARTIST)
    service, _coyhaique_audio, _rags_audio = _make_service(
        tmp_path,
        stream=stream,
        log_observation_fn=lambda: TrackObservation(
            source_app="Music",
            title="Music Track",
            artist="Music Artist",
            duration_seconds=300.0,
            observed_at=datetime.now(UTC),
            playback_position_seconds=10.0,
            position_source="exact",
            is_playing=True,
        ),
    )
    _patch_deck_database(monkeypatch, {COYHAIQUE: _coyhaique_audio})
    position = 0
    for _ in range(4):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="-1,-1")
    for _ in range(10):  # the deck then pauses; the stream stays exact
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="-1,-1")

    payload = _await_status(service, lambda item: item["observation"] is not None)

    assert payload["observation"]["source_app"] == "Music"
    assert payload["observation"]["title"] == "Music Track"
    assert payload["observation"]["deck"] is None


def test_paused_on_air_deck_keeps_its_show_when_the_deck_track_cannot_be_resolved(
    tmp_path: Path, monkeypatch
) -> None:
    """A paused on-air deck must not lose its identity to the agent log.

    When the collection lookup stops resolving the on-air deck's own track, the
    log observation describes the last loaded track — the other deck's — and
    adopting it would swap the show under a playhead that still belongs to the
    paused deck.
    """
    clock, stream, service, coyhaique_audio, rags_audio = _playing_rehearsal(tmp_path, monkeypatch)
    by_title = {COYHAIQUE: coyhaique_audio, RAGS: rags_audio}
    _patch_deck_database(monkeypatch, by_title)
    position = 0
    for _ in range(4):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="7761,125.000")
    payload = _await_status(service, lambda item: item["modeState"] == "premade_active")
    assert payload["observation"]["title"] == COYHAIQUE

    for _ in range(10):  # deck 1 pauses; the stream stays exact
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="7761,125.000")
    by_title.clear()  # the collection lookup stops resolving the deck's track

    payload = service.status_payload()
    assert payload["observation"]["title"] == COYHAIQUE
    assert payload["observation"]["deck"] == 1
    assert payload["activeShowId"] is not None


def test_on_air_deck_state_reports_deck_track_and_playing_flag() -> None:
    clock = FakeClock()
    stream = _stream(clock)
    _feed_track(stream, 1, COYHAIQUE, COYHAIQUE_ARTIST)
    position = 0
    for _ in range(3):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="-1,-1")

    on_air = stream.on_air_deck_state(
        observation_title=RAGS, observation_artist=RAGS_ARTIST
    )

    assert on_air is not None
    assert on_air.deck == 1
    assert on_air.state.title == COYHAIQUE
    assert on_air.state.artist == COYHAIQUE_ARTIST
    assert on_air.is_playing is True
    assert stream.on_air_deck_number() == 1


def test_on_air_deck_state_is_none_when_the_stream_is_not_exact() -> None:
    clock = FakeClock()
    stream = _stream(clock)
    assert stream.on_air_deck_state(observation_title=None, observation_artist=None) is None
    assert stream.on_air_deck_number() is None


def test_on_air_deck_state_is_none_when_the_stream_goes_stale() -> None:
    clock = FakeClock()
    stream = _stream(clock)
    _feed_track(stream, 1, COYHAIQUE, COYHAIQUE_ARTIST)
    position = 0
    for _ in range(3):
        position += 2205
        _feed_tick(stream, clock, d1=f"{position},124.000", d2="-1,-1")

    clock.advance(2.0)

    assert stream.on_air_deck_number() is None


def test_deck_observation_resolves_the_file_and_exact_position(monkeypatch) -> None:
    monkeypatch.setattr(
        source_polling,
        "content_for_anlz_path",
        lambda anlz: RekordboxContentInfo(
            folder_path="/music/a.wav", title="Track A", artist="Artist A", duration_seconds=300.0
        )
        if anlz == "/anlz/ANLZ0000.DAT"
        else None,
    )

    state = source_polling.RekordboxMemoryDeckState(
        deck=2,
        title="Track A",
        artist="Artist A",
        album="Album",
        bpm=124.0,
        sample_position=44100,
        anlz_path="/anlz/ANLZ0000.DAT",
    )

    observation = source_polling.observation_from_memory_deck_state(
        state, is_playing=True
    )

    assert observation is not None
    assert observation.deck == 2
    assert observation.title == "Track A"
    assert observation.source_hint_path == Path("/music/a.wav")
    assert observation.playback_position_seconds == 1.0
    assert observation.position_source == "exact"
    assert observation.is_playing is True
    assert observation.duration_seconds == 300.0


def test_deck_observation_falls_back_to_title_artist_lookup(monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "content_for_anlz_path", lambda _anlz: None)
    monkeypatch.setattr(
        source_polling,
        "content_for_title_artist",
        lambda title, artist: RekordboxContentInfo(
            folder_path="/music/b.wav", title=title, artist=artist, duration_seconds=310.0
        ),
    )

    state = source_polling.RekordboxMemoryDeckState(
        deck=1,
        title="Track B",
        artist="Artist B",
        album=None,
        bpm=None,
        sample_position=None,
        anlz_path=None,
    )

    observation = source_polling.observation_from_memory_deck_state(
        state, is_playing=False
    )

    assert observation is not None
    assert observation.deck == 1
    assert observation.source_hint_path == Path("/music/b.wav")
    assert observation.playback_position_seconds is None
    assert observation.is_playing is False


def test_deck_observation_is_none_without_a_collection_record(monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "content_for_anlz_path", lambda _anlz: None)
    monkeypatch.setattr(source_polling, "content_for_title_artist", lambda title, artist: None)

    state = source_polling.RekordboxMemoryDeckState(
        deck=1,
        title="Unknown Track",
        artist=None,
        album=None,
        bpm=None,
        sample_position=None,
        anlz_path=None,
    )

    assert (
        source_polling.observation_from_memory_deck_state(state, is_playing=None) is None
    )


def test_content_for_anlz_path_matches_the_database_suffix(monkeypatch) -> None:
    snapshot = (
        RekordboxContentInfo(
            folder_path="/Volumes/MUSIC/a.mp3",
            title="Track A",
            artist="Artist A",
            duration_seconds=392.0,
            analysis_data_path="/PIONEER/USBANLZ/eee/6657d-08df/ANLZ0000.DAT",
        ),
        RekordboxContentInfo(
            folder_path="/music/b.mp3",
            title="Track B",
            artist="Artist B",
            duration_seconds=300.0,
            analysis_data_path="/PIONEER/USBANLZ/4b9/469a4-c3a3/ANLZ0000.DAT",
        ),
    )
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_content_snapshot", lambda: snapshot)

    found = rekordbox_analysis.content_for_anlz_path(
        "/Volumes/MUSIC/sets/PIONEER/USBANLZ/4b9/469a4-c3a3/ANLZ0000.DAT"
    )

    assert found is not None
    assert found.folder_path == "/music/b.mp3"


def test_content_for_title_artist_prefers_the_artist_match(monkeypatch) -> None:
    snapshot = (
        RekordboxContentInfo(
            folder_path="/music/one.mp3",
            title="Same Title",
            artist="Artist One",
            duration_seconds=300.0,
            analysis_data_path=None,
        ),
        RekordboxContentInfo(
            folder_path="/music/two.mp3",
            title="Same Title",
            artist="Artist Two",
            duration_seconds=320.0,
            analysis_data_path=None,
        ),
    )
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_content_snapshot", lambda: snapshot)

    found = rekordbox_analysis.content_for_title_artist("Same Title", "Artist Two")

    assert found is not None
    assert found.folder_path == "/music/two.mp3"


def test_content_snapshot_loads_from_a_master_db_copy(monkeypatch, tmp_path: Path) -> None:
    class FakeContent:
        ID = 1
        Title = "Track A"
        ArtistName = "Artist A"
        FolderPath = "/music/a.wav"
        AnalysisDataPath = "/PIONEER/USBANLZ/eee/6657d/ANLZ0000.DAT"
        Length = 392

    class FakeSession:
        def query(self, _table):
            return self

        def all(self):
            return [FakeContent()]

        def close(self) -> None:
            return None

    class FakeDatabase:
        session = FakeSession()

    real_db = tmp_path / "master.db"
    real_db.write_bytes(b"sqlite")
    monkeypatch.setattr(rekordbox_analysis, "_rekordbox_db_path", lambda: real_db)
    monkeypatch.setattr(rekordbox_analysis.shutil, "copy2", lambda src, dst: Path(dst).write_bytes(b"copy"))
    monkeypatch.setattr(rekordbox_analysis.tempfile, "TemporaryDirectory", lambda **_: _FakeTempDir(tmp_path))
    import pyrekordbox

    monkeypatch.setattr(pyrekordbox, "Rekordbox6Database", lambda **_: FakeDatabase())

    snapshot = rekordbox_analysis._rekordbox_content_snapshot()

    assert len(snapshot) == 1
    assert snapshot[0].folder_path == "/music/a.wav"
    assert snapshot[0].duration_seconds == 392.0


class _FakeTempDir:
    def __init__(self, root: Path) -> None:
        self.path = root

    def __enter__(self):
        return str(self.path)

    def __exit__(self, *_args) -> bool:
        return False