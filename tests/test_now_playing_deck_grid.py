"""The on-air deck's Rekordbox beat grid, served from its ANLZ PQTZ tag."""

import struct
from pathlib import Path

from construct import Container

from phrase2photon.now_playing import rekordbox_analysis
from phrase2photon.now_playing.rekordbox_analysis import load_deck_beat_grid
from phrase2photon.now_playing.server import NowPlayingService, route_request


def build_pqtz_anlz(path: Path, beats: list[tuple[int, float]]) -> None:
    """Writes a minimal ANLZ .DAT whose PQTZ carries (beat-in-bar, seconds)."""
    import pyrekordbox.anlz.structs as anlz_structs

    entries = [Container(beat=beat, tempo=12000, time=int(seconds * 1000)) for beat, seconds in beats]
    body = anlz_structs.PQTZ.build(
        Container(u1=b"\x00\x00\x00\x00", u2=0x80000, entry_count=len(entries), entries=entries)
    )
    tag = b"PQTZ" + struct.pack(">II", 24, 12 + len(body)) + body
    header = b"PMAI" + struct.pack(">II", 24, 24 + len(tag)) + b"\x00" * 12
    path.write_bytes(header + tag)


def anlz_dir(tmp_path: Path, beats: list[tuple[int, float]]) -> Path:
    """An ANLZ directory the way the deck probe reports one."""
    directory = tmp_path / "anlz" / "746" / "478b4-90e9"
    directory.mkdir(parents=True)
    build_pqtz_anlz(directory / "ANLZ0000.DAT", beats)
    return directory


# 120 BPM: 0.5 s per beat, the grid starts on beat 3 so it begins mid-bar.
BEATS = [((index + 2) % 4 + 1, index * 0.5) for index in range(16)]


def test_load_deck_beat_grid_reads_beat_times_and_downbeats(tmp_path: Path) -> None:
    directory = anlz_dir(tmp_path, BEATS)

    grid = load_deck_beat_grid(str(directory))

    assert grid is not None
    assert grid.beat_seconds == tuple(seconds for _, seconds in BEATS)
    assert grid.downbeat_indexes == (2, 6, 10, 14)


def test_load_deck_beat_grid_accepts_the_dat_file_itself(tmp_path: Path) -> None:
    dat = tmp_path / "ANLZ0000.DAT"
    build_pqtz_anlz(dat, BEATS)

    grid = load_deck_beat_grid(str(dat))

    assert grid is not None
    assert grid.downbeat_indexes == (2, 6, 10, 14)


def test_load_deck_beat_grid_is_cached_until_the_file_changes(tmp_path: Path, monkeypatch) -> None:
    directory = anlz_dir(tmp_path, BEATS)
    parses: list[str] = []
    real_parse = rekordbox_analysis._parse_beat_grid_from_dat

    def counting_parse(dat_path: Path):
        parses.append(str(dat_path))
        return real_parse(dat_path)

    monkeypatch.setattr(rekordbox_analysis, "_parse_beat_grid_from_dat", counting_parse)

    first = load_deck_beat_grid(str(directory))
    second = load_deck_beat_grid(str(directory))
    assert parses == [str(directory / "ANLZ0000.DAT")]
    assert second is first

    rebuild = anlz_dir(tmp_path / "again", BEATS)
    load_deck_beat_grid(str(rebuild))
    assert parses[-1] == str(rebuild / "ANLZ0000.DAT")


def test_load_deck_beat_grid_missing_or_empty(tmp_path: Path) -> None:
    assert load_deck_beat_grid(None) is None
    assert load_deck_beat_grid(str(tmp_path / "missing")) is None
    empty = tmp_path / "empty"
    empty.mkdir()
    assert load_deck_beat_grid(str(empty)) is None


class FakeDeckStream:
    """Stands in for the memory stream with one on-air deck."""

    def __init__(self, anlz_path: str | None, deck: int = 2) -> None:
        from phrase2photon.now_playing.source_polling import RekordboxMemoryDeckState

        self.state = RekordboxMemoryDeckState(
            deck=deck,
            title="Track",
            artist="Artist",
            album=None,
            bpm=120.0,
            sample_position=44_100,
            anlz_path=anlz_path,
        )

    def on_air_deck_state(self, *, observation_title, observation_artist):
        if self.state.anlz_path is None:
            return None
        from phrase2photon.now_playing.rekordbox_stream import RekordboxOnAirDeck

        return RekordboxOnAirDeck(deck=self.state.deck, state=self.state, is_playing=True)

    def on_air_deck_number(self):
        return None

    def status(self):
        return "exact"

    def clock_payload(self, **_):
        return {"status": "exact", "deck": 2}


def test_clock_payload_carries_the_deck_anlz_path(tmp_path: Path) -> None:
    from phrase2photon.now_playing.rekordbox_stream import RekordboxMemoryStream

    directory = anlz_dir(tmp_path, BEATS)
    stream = RekordboxMemoryStream()
    stream._set_status("exact")
    stream._apply_line(
        "tick mono_ns=1 master=1 d1=0,-1 d2=88200,-1 d3=-1,-1 d4=-1,-1\n"
    )
    stream._apply_line(f"track deck=2\ttitle=Track\tartist=Artist\tanlz={directory}\n")

    payload = stream.clock_payload()

    assert payload["deck"] == 2
    assert payload["anlzPath"] == str(directory)


def test_grid_endpoint_serves_the_on_air_deck_grid(tmp_path: Path, monkeypatch) -> None:
    directory = anlz_dir(tmp_path, BEATS)
    service = NowPlayingService(cache_root=tmp_path, memory_stream=FakeDeckStream(str(directory)))

    response = route_request(
        "/api/now-playing/grid",
        cache_root=tmp_path,
        grid_provider=service.grid_payload,
    )
    import json

    payload = json.loads(response.body)
    assert payload["deck"] == 2
    assert payload["anlzPath"] == str(directory)
    assert payload["beatSeconds"] == [seconds for _, seconds in BEATS]
    assert payload["downbeatIndexes"] == [2, 6, 10, 14]


def test_grid_endpoint_without_a_deck(tmp_path: Path) -> None:
    service = NowPlayingService(cache_root=tmp_path, memory_stream=FakeDeckStream(None))

    response = route_request(
        "/api/now-playing/grid",
        cache_root=tmp_path,
        grid_provider=service.grid_payload,
    )
    import json

    payload = json.loads(response.body)
    assert payload["deck"] is None
    assert payload["beatSeconds"] == []