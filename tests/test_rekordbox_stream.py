import json
import os
import plistlib
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from phrase2photon.now_playing import rekordbox_stream
from phrase2photon.now_playing.rekordbox_stream import RekordboxMemoryStream
from phrase2photon.now_playing.server import NowPlayingService, route_request
from phrase2photon.now_playing.source_polling import TrackObservation


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeMemoryRunner:
    def __init__(self, *, binary_path: str, pid: int = 4242) -> None:
        self.binary_path = binary_path
        self.pid = pid
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], check: bool = False, capture_output: bool = False, text: bool = False):
        self.calls.append(list(argv))
        if argv[0] == "pgrep":
            return subprocess.CompletedProcess(argv, 0, stdout=f"{self.pid}\n", stderr="")
        if argv[0] == "ps":
            return subprocess.CompletedProcess(argv, 0, stdout=f"{self.pid} {self.binary_path}\n", stderr="")
        if argv[0] == "codesign":
            plist = plistlib.dumps({"com.apple.security.get-task-allow": True})
            return subprocess.CompletedProcess(argv, 0, stdout=plist, stderr="")
        raise AssertionError(f"Unexpected command: {argv}")


class FakeStreamProcess:
    def __init__(self, lines: list[str]) -> None:
        self._lines = list(lines)
        self.stdout = self
        self.terminated = False
        self.exit_code: int | None = None

    def readline(self) -> str:
        if self._lines:
            return self._lines.pop(0)
        self.exit_code = 1
        return ""

    def poll(self) -> int | None:
        return self.exit_code

    def wait(self) -> int:
        return self.exit_code if self.exit_code is not None else 0

    def terminate(self) -> None:
        self.terminated = True


class FakePopenFactory:
    def __init__(self, processes: list[FakeStreamProcess]) -> None:
        self.processes = list(processes)
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **_: object) -> FakeStreamProcess:
        self.calls.append(list(argv))
        return self.processes.pop(0)


def _write_test_rekordbox_app(tmp_path: Path, version: str) -> Path:
    bundle = tmp_path / "rekordbox.app"
    contents = bundle / "Contents"
    contents.mkdir(parents=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": version}))
    binary = contents / "MacOS" / "rekordbox"
    binary.parent.mkdir()
    binary.write_bytes(b"MZ")
    return bundle


@pytest.fixture(autouse=True)
def _isolated_rekordbox_app(tmp_path: Path, monkeypatch) -> None:
    bundle = _write_test_rekordbox_app(tmp_path, "7.2.18")
    monkeypatch.setenv("P2P_REKORDBOX_APP", str(bundle))


def _stream(
    processes: list[FakeStreamProcess],
    *,
    clock: FakeClock | None = None,
    restart_backoff_seconds: float = 0.5,
) -> tuple[RekordboxMemoryStream, FakeClock, FakePopenFactory, FakeMemoryRunner]:
    clock = clock or FakeClock()
    runner = FakeMemoryRunner(
        binary_path=os.environ["P2P_REKORDBOX_APP"] + "/Contents/MacOS/rekordbox"
    )
    popen = FakePopenFactory(processes)
    stream = RekordboxMemoryStream(
        runner=runner,
        popen=popen,
        clock=clock,
        pause_fn=lambda _seconds: None,
        restart_backoff_seconds=restart_backoff_seconds,
    )
    return stream, clock, popen, runner


TICK = (
    "tick mono_ns={n} master={master} d1={d1} d2={d2} d3={d3} d4={d4}\n"
)


def test_parse_stream_tick_line() -> None:
    tick = rekordbox_stream.parse_rekordbox_stream_line(
        "tick mono_ns=1234 master=2 d1=44100,128.000 d2=-1,-1 d3=0,120.500 d4=-1,-1\n"
    )
    assert tick == rekordbox_stream.RekordboxStreamTick(
        mono_ns=1234,
        master_deck=2,
        samples=(44100, None, 0, None),
        bpms=(128.0, None, 120.5, None),
    )


def test_parse_stream_tick_master_invalid() -> None:
    tick = rekordbox_stream.parse_rekordbox_stream_line(
        "tick mono_ns=5 master=-1 d1=-1,-1 d2=-1,-1 d3=-1,-1 d4=-1,-1\n"
    )
    assert tick is not None
    assert tick.master_deck is None
    assert tick.samples == (None, None, None, None)


def test_parse_stream_track_line_with_spaces() -> None:
    track = rekordbox_stream.parse_rekordbox_stream_line(
        "track deck=3 title=My Song artist=An Artist anlz=/music/My Song 12/ANLZ0000.DAT\n"
    )
    assert track == rekordbox_stream.RekordboxStreamTrack(
        deck=3,
        title="My Song",
        artist="An Artist",
        anlz_path="/music/My Song 12/ANLZ0000.DAT",
    )


def test_parse_stream_track_line_empty_fields() -> None:
    track = rekordbox_stream.parse_rekordbox_stream_line("track deck=1 title= artist= anlz=\n")
    assert track is not None
    assert track.title is None
    assert track.artist is None
    assert track.anlz_path is None


@pytest.mark.parametrize(
    "line",
    [
        "",
        "garbage",
        "tick mono_ns=abc master=0 d1=1,2 d2=-1,-1 d3=-1,-1 d4=-1,-1",
        "tick master=0 d1=1,2 d2=-1,-1 d3=-1,-1 d4=-1,-1",
        "tick mono_ns=1 master=9 d1=-1,-1 d2=-1,-1 d3=-1,-1 d4=-1,-1",
        "tick mono_ns=1 master=0 d1=oops,128 d2=-1,-1 d3=-1,-1 d4=-1,-1",
        "track deck=9 title=x artist=y anlz=z",
        "track oops title=x artist=y anlz=z",
    ],
)
def test_parse_stream_ignores_malformed_lines(line: str) -> None:
    assert rekordbox_stream.parse_rekordbox_stream_line(line + "\n") is None


def test_active_deck_prefers_master_deck_with_track() -> None:
    stream, _clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=2 title=Track B artist=B anlz=/b/ANLZ0000.DAT\n")
    stream._apply_line("track deck=3 title=Track C artist=C anlz=/c/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=1, d1="0,0.000", d2="100,128.000", d3="200,130.000", d4="-1,-1"))
    payload = stream.clock_payload()
    assert payload["deck"] == 2
    assert payload["title"] == "Track B"
    assert payload["positionSeconds"] == pytest.approx(100 / 44100)


def test_active_deck_falls_back_to_title_match_without_master() -> None:
    stream, _clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=3 title=Track C artist=C anlz=/c/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=-1, d1="-1,-1", d2="-1,-1", d3="500,128.000", d4="-1,-1"))
    payload = stream.clock_payload(observation_title="Track C", observation_artist="c")
    assert payload["deck"] == 3


def test_active_deck_ignores_master_deck_without_track() -> None:
    stream, _clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=3 title=Track C artist=C anlz=/c/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=0, d1="0,0.000", d2="-1,-1", d3="500,128.000", d4="-1,-1"))
    payload = stream.clock_payload(observation_title="Track C", observation_artist="C")
    assert payload["deck"] == 3


def test_active_deck_none_without_match() -> None:
    stream, _clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=1 title=Track A artist=A anlz=/a/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=-1, d1="0,0.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"))
    assert stream.clock_payload(observation_title="Other")["deck"] is None
    assert stream.clock_payload()["deck"] is None


def test_clock_payload_playing_and_age() -> None:
    stream, clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=1 title=Track A artist=A anlz=/a/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=0, d1="44100,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"))
    clock.advance(0.05)
    payload = stream.clock_payload()
    assert payload["playing"] is True
    assert payload["ageMs"] == pytest.approx(50.0)
    assert payload["bpm"] == pytest.approx(128.0)
    clock.advance(0.05)
    stream._apply_line(TICK.format(n=2, master=0, d1="44100,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"))
    assert stream.clock_payload()["playing"] is False


def test_clock_payload_marks_stale_after_quiet_period() -> None:
    stream, clock, _popen, _runner = _stream([])
    stream._apply_line("track deck=1 title=Track A artist=A anlz=/a/ANLZ0000.DAT\n")
    stream._apply_line(TICK.format(n=1, master=0, d1="44100,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"))
    clock.advance(rekordbox_stream.STREAM_STALE_SECONDS + 0.1)
    payload = stream.clock_payload()
    assert payload["status"] == "probe-failed:stale"
    assert payload["deck"] == 1


def test_stream_spawns_probe_in_stream_mode() -> None:
    processes = [
        FakeStreamProcess(
            [
                TICK.format(n=1, master=0, d1="44100,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"),
                TICK.format(n=2, master=0, d1="88200,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"),
            ]
        )
    ]
    stream, _clock, popen, _runner = _stream(processes)
    stream._pump()
    stream._pump()
    assert stream.status() == "exact"
    assert len(popen.calls) == 1
    argv = popen.calls[0]
    assert argv[0] == "bash"
    assert argv[-2:] == ["--stream", "20"]


def test_stream_restarts_subprocess_after_exit() -> None:
    first = FakeStreamProcess(
        [
            "track deck=1 title=Track A artist=A anlz=/a/ANLZ0000.DAT\n",
            TICK.format(n=1, master=0, d1="44100,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"),
        ]
    )
    second = FakeStreamProcess(
        [
            "track deck=1 title=Track A artist=A anlz=/a/ANLZ0000.DAT\n",
            TICK.format(n=2, master=0, d1="88200,128.000", d2="-1,-1", d3="-1,-1", d4="-1,-1"),
        ]
    )
    stream, _clock, popen, _runner = _stream([first, second])

    stream._pump()
    stream._pump()
    assert stream.clock_payload()["positionSeconds"] == pytest.approx(1.0)

    # Probe hits EOF (Rekordbox quit): status reports the exit, the next pump
    # pauses for the backoff, and the one after respawns against the new pid.
    stream._pump()
    assert stream.status() == "probe-failed:exit1"
    stream._pump()
    stream._pump()
    assert len(popen.calls) == 2
    payload = stream.clock_payload()
    assert payload["status"] == "exact"
    assert payload["positionSeconds"] == pytest.approx(2.0)


def test_stream_grows_backoff_after_rapid_exit() -> None:
    stream, _clock, popen, _runner = _stream(
        [FakeStreamProcess([]), FakeStreamProcess([])], restart_backoff_seconds=0.5
    )
    stream._pump()  # spawn followed by an immediate EOF: a rapid exit
    assert stream.status() == "probe-failed:exit1"
    assert stream._current_backoff == 1.0
    assert len(popen.calls) == 1
    stream._pump()  # respawns after the pause
    assert len(popen.calls) == 2


def test_stream_resets_backoff_after_long_lived_process() -> None:
    processes = [
        FakeStreamProcess([]),
        FakeStreamProcess([]),
        FakeStreamProcess([TICK.format(n=1, master=-1, d1="-1,-1", d2="-1,-1", d3="-1,-1", d4="-1,-1")]),
        FakeStreamProcess([]),
    ]
    stream, clock, _popen, _runner = _stream(processes, restart_backoff_seconds=0.5)

    stream._pump()
    stream._pump()
    assert stream._current_backoff == 2.0

    stream._pump()  # third probe reads a tick and stays alive
    clock.advance(10.0)
    stream._pump()  # EOF after a long life resets the backoff before growing
    assert stream._current_backoff == 1.0


def test_clock_route_serves_stream_payload() -> None:
    payload = {"status": "exact", "deck": 2, "positionSeconds": 1.5}
    response = route_request("/api/now-playing/clock", clock_provider=lambda: payload)
    assert response.status_code == 200
    assert json.loads(response.body)["deck"] == 2


def test_service_clock_payload_reads_current_observation(tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    class RecordingStream:
        def clock_payload(self, *, observation_title=None, observation_artist=None):
            captured["title"] = observation_title
            captured["artist"] = observation_artist
            return {"status": "exact"}

    observation = TrackObservation(
        source_app="Rekordbox",
        title="Track A",
        artist="Artist A",
        duration_seconds=100.0,
        observed_at=datetime.now(UTC),
    )
    service = NowPlayingService(
        cache_root=tmp_path,
        poll_source=lambda: observation,
        memory_stream=RecordingStream(),
    )
    service.refresh()
    payload = service.clock_payload()
    assert payload == {"status": "exact"}
    assert captured == {"title": "Track A", "artist": "Artist A"}
