from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import plistlib
import pytest
import subprocess

from phrase2photon.now_playing import source_polling


@pytest.fixture(autouse=True)
def _isolated_rekordbox_memory_probe(monkeypatch) -> None:
    monkeypatch.setenv("P2P_REKORDBOX_APP", "/nonexistent/phrase2photon-tests/rekordbox.app")
    monkeypatch.setattr(source_polling, "_REKORDBOX_ENTITLEMENT_CACHE", {})
    monkeypatch.setattr(source_polling, "_LAST_REKORDBOX_MEMORY_STATUS", None)


class FakeQuery:
    def __init__(self, item: object | None) -> None:
        self._item = item

    def first(self) -> object | None:
        return self._item


class FakeDatabase:
    def __init__(self, *, by_id: dict[str, object], by_path: dict[str, object]) -> None:
        self._by_id = by_id
        self._by_path = by_path

    def get_content(self, **filters: str) -> object:
        if "ID" in filters:
            return self._by_id[filters["ID"]]
        if "FolderPath" in filters:
            return FakeQuery(self._by_path.get(filters["FolderPath"]))
        raise AssertionError(f"Unexpected filters: {filters}")


def _content(*, content_id: str, title: str, artist: str, duration_seconds: float, folder_path: str) -> object:
    return SimpleNamespace(
        ID=content_id,
        Title=title,
        ArtistName=artist,
        Length=duration_seconds,
        FolderPath=folder_path,
    )


def test_poll_rekordbox_prefers_recent_open_local_track(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "Cant Decide.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "\n".join(
            [
                "[260516T124239.429-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
                "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
            ]
        ),
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
                "100": _content(
                    content_id="100",
                    title="Streaming Track",
                    artist="DJ Stream",
                    duration_seconds=300.0,
                    folder_path="apple-music:tracks:123",
                ),
                "200": _content(
                    content_id="200",
                    title="Can't Decide",
                    artist="Max Dean, Luke Dean, Locky",
                    duration_seconds=175.0,
                    folder_path=str(local_path),
                ),
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 1024},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.source_app == "Rekordbox"
    assert observation.title == "Can't Decide"
    assert observation.artist == "Max Dean, Luke Dean, Locky"
    assert observation.duration_seconds == 175.0
    assert observation.observed_at == datetime(2026, 5, 16, 19, 42, 40, 850000, tzinfo=UTC)
    assert observation.source_hint_path == local_path


def test_poll_rekordbox_estimates_playback_position_from_open_file_offset(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "Extract.flac"
    local_path.write_bytes(b"x" * 4000)
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "200": _content(
                content_id="200",
                title="Extract",
                artist="Chris Stussy",
                duration_seconds=200.0,
                folder_path=str(local_path),
            )
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 1000},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.playback_position_seconds == 50.0
    assert observation.is_playing is True


def test_poll_rekordbox_uses_touch_time_baseline_when_file_is_already_fully_buffered(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "You Don't Own Me.flac"
    local_path.write_bytes(b"x" * 4000)
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "200": _content(
                content_id="200",
                title="You Don't Own Me (ft. Rahh)",
                artist="Prospa, Josh Baker, Rahh",
                duration_seconds=170.0,
                folder_path=str(local_path),
            )
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 4000},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.playback_position_seconds == 0.0
    assert observation.is_playing is True


def test_poll_rekordbox_falls_back_to_most_recent_log_track(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "\n".join(
            [
                "[260516T124239.429-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
                "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
            ]
        ),
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
                "100": _content(
                    content_id="100",
                    title="Most Recent Track",
                    artist="DJ Recent",
                    duration_seconds=146.0,
                    folder_path="apple-music:tracks:123",
                ),
                "200": _content(
                    content_id="200",
                    title="Older Track",
                    artist="DJ Older",
                    duration_seconds=175.0,
                    folder_path=str(tmp_path / "older.flac"),
                ),
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=dict,
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "Most Recent Track"
    assert observation.artist == "DJ Recent"
    assert observation.duration_seconds == 146.0


def test_poll_rekordbox_does_not_return_stale_log_without_open_audio_paths(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="Stale Track",
                artist="DJ Recent",
                duration_seconds=146.0,
                folder_path="apple-music:tracks:123",
            )
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=dict,
        db_loader=lambda: database,
    )

    assert observation is None


def test_poll_rekordbox_does_not_return_fresh_local_log_without_open_audio_paths(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "Want You.mp3"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="Want You",
                artist="GIGSTA",
                duration_seconds=386.0,
                folder_path=str(local_path),
            )
        },
        by_path={},
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=dict,
        db_loader=lambda: database,
    )

    assert observation is None


def test_poll_rekordbox_ignores_stale_log_when_open_file_lookup_is_available(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "Oh K.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260404T103243.950-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="Stale Track",
                artist="DJ Old",
                duration_seconds=263.0,
                folder_path="apple-music:tracks:1888309188",
            )
        },
        by_path={
            str(local_path): _content(
                content_id="200",
                title="Oh K",
                artist="Alves",
                duration_seconds=181.0,
                folder_path=str(local_path),
            )
        },
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 4096},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "Oh K"
    assert observation.artist == "Alves"
    assert observation.duration_seconds == 181.0


def test_poll_rekordbox_prefers_open_local_file_over_fresh_non_local_log(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "You Don't Own Me.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="Back 2 The Beat (Extended Version) - TSZR 0095",
                artist="Local Dub",
                duration_seconds=297.0,
                folder_path="soundcloud:tracks:2282016641",
            )
        },
        by_path={
            str(local_path): _content(
                content_id="200",
                title="You Don't Own Me (ft. Rahh)",
                artist="Prospa, Josh Baker, Rahh",
                duration_seconds=170.0,
                folder_path=str(local_path),
            )
        },
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 8192},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "You Don't Own Me (ft. Rahh)"
    assert observation.artist == "Prospa, Josh Baker, Rahh"


def test_poll_rekordbox_falls_back_to_open_file_lookup_when_log_is_empty(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    local_path = tmp_path / "Oh K.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text("", encoding="utf-8")
    database = FakeDatabase(
        by_id={},
        by_path={
            str(local_path): _content(
                content_id="300",
                title="Oh K",
                artist="Alves",
                duration_seconds=181.0,
                folder_path=str(local_path),
            )
        },
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 8192},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "Oh K"
    assert observation.artist == "Alves"
    assert observation.duration_seconds == 181.0


def test_poll_rekordbox_prefers_advancing_open_file_offset_over_stale_recent_log(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    newer_path = tmp_path / "its-that-time.flac"
    playing_path = tmp_path / "cant-decide.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "\n".join(
            [
                "[260516T124239.429-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
                "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
            ]
        ),
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="Most Recent Track",
                artist="DJ Recent",
                duration_seconds=146.0,
                folder_path=str(newer_path),
            ),
            "200": _content(
                content_id="200",
                title="Can't Decide",
                artist="Max Dean, Luke Dean, Locky",
                duration_seconds=175.0,
                folder_path=str(playing_path),
            ),
        },
        by_path={
            str(newer_path): _content(
                content_id="100",
                title="Most Recent Track",
                artist="DJ Recent",
                duration_seconds=146.0,
                folder_path=str(newer_path),
            ),
            str(playing_path): _content(
                content_id="200",
                title="Can't Decide",
                artist="Max Dean, Luke Dean, Locky",
                duration_seconds=175.0,
                folder_path=str(playing_path),
            ),
        },
    )

    # Prime last offsets so only the playing path advances.
    source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {newer_path: 1024, playing_path: 4096},
        db_loader=lambda: database,
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {newer_path: 1024, playing_path: 8192},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "Can't Decide"
    assert observation.artist == "Max Dean, Luke Dean, Locky"
    assert observation.duration_seconds == 175.0


def test_poll_rekordbox_prefers_larger_open_offset_over_stale_log_recency(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    stale_newer_path = tmp_path / "its-that-time.flac"
    actual_playing_path = tmp_path / "oh-k.flac"
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "\n".join(
            [
                "[260516T124239.429-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
                "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
            ]
        ),
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "100": _content(
                content_id="100",
                title="It's That Time (Amber D Remix)",
                artist="Marlon Hoffstadt",
                duration_seconds=412.0,
                folder_path=str(stale_newer_path),
            ),
            "200": _content(
                content_id="200",
                title="Oh K",
                artist="Alves",
                duration_seconds=159.0,
                folder_path=str(actual_playing_path),
            ),
        },
        by_path={
            str(stale_newer_path): _content(
                content_id="100",
                title="It's That Time (Amber D Remix)",
                artist="Marlon Hoffstadt",
                duration_seconds=412.0,
                folder_path=str(stale_newer_path),
            ),
            str(actual_playing_path): _content(
                content_id="200",
                title="Oh K",
                artist="Alves",
                duration_seconds=159.0,
                folder_path=str(actual_playing_path),
            ),
        },
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {stale_newer_path: 1228800, actual_playing_path: 9449472},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.title == "Oh K"
    assert observation.artist == "Alves"
    assert observation.duration_seconds == 159.0


def test_poll_rekordbox_exposes_ranked_open_audio_diagnostics(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    monkeypatch.setattr(source_polling, "_LAST_REKORDBOX_DIAGNOSTICS", None)
    newer_path = tmp_path / "its-that-time.flac"
    playing_path = tmp_path / "oh-k.flac"
    newer_path.write_bytes(b"x" * 8192)
    playing_path.write_bytes(b"x" * 16384)
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "\n".join(
            [
                "[260516T124239.429-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
                "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:123] start : [POST] /api/v1/data/djmdContents/100/file",
            ]
        ),
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={},
        by_path={
            str(newer_path): _content(
                content_id="100",
                title="It's That Time (Amber D Remix)",
                artist="Marlon Hoffstadt",
                duration_seconds=412.0,
                folder_path=str(newer_path),
            ),
            str(playing_path): _content(
                content_id="200",
                title="Oh K",
                artist="Alves",
                duration_seconds=159.0,
                folder_path=str(playing_path),
            ),
        },
    )

    source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {newer_path: 1024, playing_path: 4096},
        db_loader=lambda: database,
    )
    source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {newer_path: 1024, playing_path: 8192},
        db_loader=lambda: database,
    )

    diagnostics = source_polling.last_rekordbox_diagnostics()

    assert diagnostics is not None
    assert diagnostics["database_loaded"] is True
    assert diagnostics["selected_via"] == "open_audio_db_match"
    assert diagnostics["selected_path"] == str(playing_path)
    assert diagnostics["recent_event_content_ids"] == ["100", "200"]
    candidates = diagnostics["open_audio_candidates"]
    assert [candidate["path"] for candidate in candidates] == [str(playing_path), str(newer_path)]
    assert candidates[0]["selected"] is True
    assert candidates[0]["offset_delta"] == 4096
    assert candidates[0]["matched_record"] is True
    assert candidates[1]["selected"] is False


def test_poll_rekordbox_falls_back_to_filename_metadata_without_database(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", None)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    monkeypatch.setattr(source_polling, "_LAST_REKORDBOX_DIAGNOSTICS", None)
    local_path = tmp_path / "GIGSTA_-_Want_You_-_Radio_Edit.mp3"
    local_path.write_bytes(b"x" * 4000)
    monkeypatch.setattr(source_polling, "_measured_local_audio_duration_seconds", lambda _path: 386.0)

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=tmp_path / "rekordbox.log",
        open_audio_state_fn=lambda: {local_path: 1000},
    )

    diagnostics = source_polling.last_rekordbox_diagnostics()

    assert observation is not None
    assert observation.title == "Want You - Radio Edit"
    assert observation.artist == "GIGSTA"
    assert observation.duration_seconds == 386.0
    assert observation.playback_position_seconds == 96.5
    assert diagnostics is not None
    assert diagnostics["database_loaded"] is False
    assert diagnostics["selected_via"] == "open_audio_fallback"
    assert diagnostics["selected_path"] == str(local_path)


def test_parse_rekordbox_memory_probe_output_extracts_clock_and_metadata() -> None:
    states = source_polling._parse_rekordbox_memory_probe_output(
        """
pid=11628
base=0x104134000
master_deck=255
deck_1:
  bpm=126.301
  sample_position=3591017
  seconds=81.429
  track_info=k Title: This Is What You Came ForArtist: Calvin HarrisAlbum: 96 Months
  title=This Is What You Came For
  artist=Calvin Harris
  album=96 Months
  anlz_path=/Users/test/ANLZ0000.DAT
deck_2:
  bpm=0.000
  sample_position=0
  seconds=0.000
  track_info=
  anlz_path=
""".strip()
    )

    assert len(states) == 2
    assert states[0].deck == 1
    assert states[0].title == "This Is What You Came For"
    assert states[0].artist == "Calvin Harris"
    assert states[0].album == "96 Months"
    assert states[0].bpm == 126.301
    assert states[0].sample_position == 3591017
    assert states[0].anlz_path == "/Users/test/ANLZ0000.DAT"
    assert states[1].deck == 2
    assert states[1].sample_position == 0


def test_poll_rekordbox_prefers_memory_clock_over_fully_buffered_baseline(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "Rekordbox6Database", object())
    monkeypatch.setattr(source_polling, "_event_is_fresh", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_AUDIO_OFFSETS", {})
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_MEMORY_SAMPLES", {})

    local_path = tmp_path / "Back 2 Back.flac"
    local_path.write_bytes(b"x" * 4000)
    log_path = tmp_path / "rekordbox.log"
    log_path.write_text(
        "[260516T124240.850-0700] I/routes/api/data/djmdContents/touch_file [rid:124] start : [POST] /api/v1/data/djmdContents/200/file",
        encoding="utf-8",
    )
    database = FakeDatabase(
        by_id={
            "200": _content(
                content_id="200",
                title="Back 2 Back (Extended Mix)",
                artist="Murphy's Law (Uk)",
                duration_seconds=320.0,
                folder_path=str(local_path),
            )
        },
        by_path={},
    )
    monkeypatch.setattr(
        source_polling,
        "_poll_rekordbox_memory_states",
        lambda: [
            source_polling.RekordboxMemoryDeckState(
                deck=1,
                title="Back 2 Back (Extended Mix)",
                artist="Murphy's Law (Uk)",
                album=None,
                bpm=130.904,
                sample_position=13269307,
                anlz_path="/Users/test/ANLZ0000.DAT",
            )
        ],
    )

    observation = source_polling.poll_rekordbox_log_and_db(
        log_path=log_path,
        open_audio_state_fn=lambda: {local_path: 4000},
        db_loader=lambda: database,
    )

    assert observation is not None
    assert observation.playback_position_seconds is not None
    assert round(observation.playback_position_seconds, 3) == round(13269307 / 44100.0, 3)
    assert observation.is_playing is True


def test_apply_rekordbox_memory_clock_marks_paused_when_sample_position_freezes(monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "_REKORDBOX_LAST_MEMORY_SAMPLES", {})
    first = source_polling._apply_rekordbox_memory_clock(
        source_polling.TrackObservation(
            source_app="Rekordbox",
            title="Back 2 Back (Extended Mix)",
            artist="Murphy's Law (Uk)",
            duration_seconds=320.0,
            observed_at=datetime(2026, 5, 25, 20, 0, tzinfo=UTC),
        ),
        memory_states=[
            source_polling.RekordboxMemoryDeckState(
                deck=1,
                title="Back 2 Back (Extended Mix)",
                artist="Murphy's Law (Uk)",
                album=None,
                bpm=130.904,
                sample_position=13269307,
                anlz_path=None,
            )
        ],
    )
    second = source_polling._apply_rekordbox_memory_clock(
        first,
        memory_states=[
            source_polling.RekordboxMemoryDeckState(
                deck=1,
                title="Back 2 Back (Extended Mix)",
                artist="Murphy's Law (Uk)",
                album=None,
                bpm=130.904,
                sample_position=13269307,
                anlz_path=None,
            )
        ],
    )

    assert first.is_playing is True
    assert second.is_playing is False


def test_rekordbox_offsets_json_covers_known_versions() -> None:
    offsets = source_polling._rekordbox_memory_offsets()
    assert set(offsets) == {"7.2.8", "7.2.17", "7.2.18"}
    for entry in offsets.values():
        assert len(entry["master_deck"]) >= 2
        assert set(entry["decks"]) == {"1", "2", "3", "4"}
        for deck_entry in entry["decks"].values():
            assert set(deck_entry) == {"bpm", "sample_position", "track_info", "anlz_path"}
            for chain in deck_entry.values():
                assert len(chain) >= 2
                for token in chain:
                    int(token, 16)


def test_rekordbox_offsets_json_preserves_7_2_8_probe_constants() -> None:
    entry = source_polling._rekordbox_memory_offsets()["7.2.8"]
    assert entry["master_deck"] == ["04DCFD18", "20", "278", "124"]
    assert entry["decks"]["1"]["bpm"] == ["04D8AA18", "0", "2C8", "188"]
    assert entry["decks"]["1"]["sample_position"] == ["04D8AA18", "0", "2C8", "120"]
    assert entry["decks"]["1"]["track_info"] == ["04D8AA18", "0", "270", "38", "80", "28", "F0", "4"]
    assert entry["decks"]["1"]["anlz_path"] == ["04DD0708", "8", "3F0", "0"]
    assert entry["decks"]["4"]["track_info"] == ["04D8AA18", "18", "270", "38", "48", "28", "F0", "4"]


def test_parse_rekordbox_version_takes_first_three_components() -> None:
    assert source_polling._parse_rekordbox_version("7.2.16.0342") == "7.2.16"
    assert source_polling._parse_rekordbox_version("7.2.18") == "7.2.18"
    assert source_polling._parse_rekordbox_version("7.2") is None
    assert source_polling._parse_rekordbox_version("beta") is None


def test_rekordbox_chains_text_matches_probe_line_format() -> None:
    entry = source_polling._rekordbox_memory_offsets()["7.2.8"]
    lines = source_polling._rekordbox_chains_text(entry).splitlines()
    assert lines[0] == "master 0 04DCFD18 20 278 124"
    assert "bpm 1 04D8AA18 0 2C8 188" in lines
    assert "sample 4 04D8AA18 18 2C8 120" in lines
    assert "anlz 4 04DD0708 20 3F0 0" in lines
    assert len(lines) == 17


def _write_test_rekordbox_app(tmp_path: Path, version: str) -> Path:
    bundle = tmp_path / "rekordbox.app"
    contents = bundle / "Contents"
    contents.mkdir(parents=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": version}))
    binary = contents / "MacOS" / "rekordbox"
    binary.parent.mkdir()
    binary.write_bytes(b"MZ")
    return bundle


_PROBE_STDOUT = """
pid=4242
base=0x104134000
master_deck=0
deck_1:
  bpm=126.301
  sample_position=3591017
  seconds=81.429
  track_info=k Title: Test TrackArtist: Test ArtistAlbum: Test Album
  title=Test Track
  artist=Test Artist
  album=Test Album
  anlz_path=/Users/test/ANLZ0000.DAT
""".strip()

_UNREADABLE_PROBE_STDOUT = """
pid=4242
base=0x104134000
master_deck=unreadable
deck_1:
  bpm=unreadable
  sample_position=unreadable
  track_info=unreadable
  anlz_path=unreadable
""".strip()


class _FakeRekordboxRunner:
    def __init__(
        self,
        *,
        binary_path: str,
        pgrep_pids: str | None = "4242",
        entitlements: bytes | None = None,
        probe_result: subprocess.CompletedProcess[str] | Exception | None = None,
    ) -> None:
        self.binary_path = binary_path
        self.pgrep_pids = pgrep_pids
        self.entitlements = entitlements
        self.probe_result = probe_result
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        self.calls.append(argv)
        if argv[0] == "pgrep":
            if self.pgrep_pids is None:
                raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0, stdout=self.pgrep_pids, stderr="")
        if argv[0] == "ps":
            return subprocess.CompletedProcess(argv, 0, stdout=f"4242 {self.binary_path}", stderr="")
        if argv[0] == "codesign":
            if self.entitlements is None:
                raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0, stdout=self.entitlements, stderr=b"")
        if argv[0] == "bash":
            if isinstance(self.probe_result, Exception):
                raise self.probe_result
            return self.probe_result
        raise AssertionError(f"Unexpected command: {argv}")


def test_memory_status_not_running_when_no_rekordbox_process() -> None:
    runner = _FakeRekordboxRunner(binary_path="unused", pgrep_pids=None)
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "not-running"


def test_memory_status_unsupported_version_skips_entitlement_check(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "9.9.9")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    runner = _FakeRekordboxRunner(binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"))
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "unsupported-version:9.9.9"
    assert all(argv[0] != "codesign" for argv in runner.calls)


def test_memory_status_not_resigned_without_get_task_allow(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    runner = _FakeRekordboxRunner(
        binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"),
        entitlements=plistlib.dumps({"com.apple.security.get-task-allow": False}),
    )
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "not-resigned"


def test_memory_status_not_resigned_when_codesign_fails(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    runner = _FakeRekordboxRunner(binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"))
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "not-resigned"


def test_memory_status_exact_passes_chains_file_to_probe(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    probe_result = subprocess.CompletedProcess(["bash"], 0, stdout=_PROBE_STDOUT, stderr="")
    runner = _FakeRekordboxRunner(
        binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"),
        entitlements=plistlib.dumps({"com.apple.security.get-task-allow": True}),
        probe_result=probe_result,
    )
    states = source_polling._poll_rekordbox_memory_states(runner=runner)
    assert source_polling.last_rekordbox_memory_status() == "exact"
    assert [state.deck for state in states] == [1]
    assert states[0].sample_position == 3591017
    probe_call = next(argv for argv in runner.calls if argv[0] == "bash")
    assert probe_call[1] == str(source_polling.REKORDBOX_MEMORY_PROBE_SCRIPT)
    assert probe_call[2] == "4242"
    assert probe_call[3].endswith("phrase2photon-rekordbox-chains-7.2.18.txt")
    assert Path(probe_call[3]).read_text() == source_polling._rekordbox_chains_text(
        source_polling._rekordbox_memory_offsets()["7.2.18"]
    )


def test_memory_status_probe_failed_on_probe_exit(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    runner = _FakeRekordboxRunner(
        binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"),
        entitlements=plistlib.dumps({"com.apple.security.get-task-allow": True}),
        probe_result=subprocess.CalledProcessError(1, ["bash"]),
    )
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "probe-failed:exit1"


def test_memory_status_probe_failed_when_decks_unreadable(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))
    probe_result = subprocess.CompletedProcess(["bash"], 0, stdout=_UNREADABLE_PROBE_STDOUT, stderr="")
    runner = _FakeRekordboxRunner(
        binary_path=str(bundle / "Contents" / "MacOS" / "rekordbox"),
        entitlements=plistlib.dumps({"com.apple.security.get-task-allow": True}),
        probe_result=probe_result,
    )
    assert source_polling._poll_rekordbox_memory_states(runner=runner) == []
    assert source_polling.last_rekordbox_memory_status() == "probe-failed:unreadable"


def test_rekordbox_diagnostics_include_memory_clock_status(monkeypatch) -> None:
    monkeypatch.setattr(source_polling, "_LAST_REKORDBOX_MEMORY_STATUS", "not-resigned")
    diagnostics = source_polling._build_rekordbox_diagnostics(
        database_loaded=False,
        recent_events=[],
        ranked_candidates=[],
        selected_candidate=None,
        selected_via=None,
    )
    assert diagnostics.memory_clock_status == "not-resigned"
