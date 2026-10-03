"""Low-latency Rekordbox deck playhead streaming.

The memory probe's --stream mode prints one tick per interval with every
deck's sample position, so the browser can anchor its transport clock on
fresh samples instead of waiting for the 1.2 s status poll.
"""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

from phrase2photon.now_playing.source_polling import (
    REKORDBOX_MEMORY_PROBE_SCRIPT,
    REKORDBOX_MEMORY_SAMPLE_RATE_HZ,
    RekordboxMemoryDeckState,
    _matching_rekordbox_memory_state,
    _rekordbox_memory_launch_context,
)

StreamRunner = Callable[..., subprocess.CompletedProcess[str]]
StreamPopen = Callable[..., subprocess.Popen[str]]
StreamClock = Callable[[], float]

STREAM_INTERVAL_MS = 20
# How long after the last tick the stream's data still counts as fresh; past
# this the clock endpoint stops reporting exact so the browser falls back.
STREAM_STALE_SECONDS = 1.0


@dataclass(frozen=True)
class RekordboxStreamTick:
    mono_ns: int
    master_deck: int | None  # 0-3, None when the master byte is unreadable
    samples: tuple[int | None, ...]
    bpms: tuple[float | None, ...]


@dataclass(frozen=True)
class RekordboxStreamTrack:
    deck: int
    title: str | None
    artist: str | None
    anlz_path: str | None


@dataclass(frozen=True)
class RekordboxStreamDeckSample:
    sample_position: int | None
    bpm: float | None
    at_monotonic: float
    previous_sample_position: int | None

    @property
    def is_playing(self) -> bool | None:
        if self.sample_position is None:
            return None
        if self.previous_sample_position is None:
            return self.sample_position > 0
        return self.sample_position != self.previous_sample_position


def _int_or_none(text: str) -> int | None:
    try:
        return int(text)
    except ValueError:
        return None


def _float_or_none(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_rekordbox_stream_line(
    line: str,
) -> RekordboxStreamTick | RekordboxStreamTrack | None:
    stripped = line.strip()
    if not stripped:
        return None
    tokens = stripped.split()
    if tokens[0] == "tick":
        return _parse_stream_tick(tokens[1:])
    if tokens[0] == "track":
        return _parse_stream_track(stripped)
    return None


def _parse_stream_tick(tokens: list[str]) -> RekordboxStreamTick | None:
    mono_ns: int | None = None
    master_deck: int | None = None
    samples: list[int | None] = [None, None, None, None]
    bpms: list[float | None] = [None, None, None, None]
    for token in tokens:
        key, _, value = token.partition("=")
        if key == "mono_ns":
            mono_ns = _int_or_none(value)
            if mono_ns is None:
                return None
        elif key == "master":
            if value == "-1":
                continue
            master = _int_or_none(value)
            if master is None or not 0 <= master <= 3:
                return None
            master_deck = master
        elif key in {"d1", "d2", "d3", "d4"}:
            sample_text, _, bpm_text = value.partition(",")
            sample = None if sample_text == "-1" else _int_or_none(sample_text)
            bpm = None if bpm_text in {"-1", ""} else _float_or_none(bpm_text)
            if sample_text != "-1" and sample is None:
                return None
            samples[int(key[1]) - 1] = sample
            bpms[int(key[1]) - 1] = bpm
        else:
            return None
    if mono_ns is None:
        return None
    return RekordboxStreamTick(
        mono_ns=mono_ns,
        master_deck=master_deck,
        samples=tuple(samples),
        bpms=tuple(bpms),
    )


def _parse_stream_track(line: str) -> RekordboxStreamTrack | None:
    deck_token, _, rest = line[len("track "):].partition(" ")
    deck = _int_or_none(deck_token.removeprefix("deck="))
    if deck is None or not 1 <= deck <= 4 or not rest.startswith("title="):
        return None
    artist_index = rest.find(" artist=")
    anlz_index = rest.rfind(" anlz=")
    if artist_index < 0 or anlz_index < 0:
        return None
    title = rest[len("title="):artist_index]
    artist = rest[artist_index + len(" artist="):anlz_index]
    anlz = rest[anlz_index + len(" anlz="):]
    return RekordboxStreamTrack(deck=deck, title=title or None, artist=artist or None, anlz_path=anlz or None)


class RekordboxMemoryStream:
    """Owns a streaming memory probe subprocess and its latest deck samples."""

    def __init__(
        self,
        *,
        interval_ms: int = STREAM_INTERVAL_MS,
        runner: StreamRunner = subprocess.run,
        popen: StreamPopen = subprocess.Popen,
        clock: StreamClock = time.monotonic,
        pause_fn: Callable[[float], None] | None = None,
        restart_backoff_seconds: float = 0.5,
        max_restart_backoff_seconds: float = 5.0,
    ) -> None:
        self._interval_ms = interval_ms
        self._runner = runner
        self._popen = popen
        self._clock = clock
        self._restart_backoff_seconds = restart_backoff_seconds
        self._max_restart_backoff_seconds = max_restart_backoff_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._pause_fn = pause_fn if pause_fn is not None else self._stop.wait
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen[str] | None = None
        self._spawned_at = 0.0
        self._current_backoff = restart_backoff_seconds
        self._status: str | None = None
        self._master_deck: int | None = None
        self._last_tick_at: float | None = None
        self._samples: list[RekordboxStreamDeckSample | None] = [None, None, None, None]
        self._tracks: list[RekordboxStreamTrack | None] = [None, None, None, None]

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run, name="rekordbox-memory-stream", daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        with self._lock:
            thread = self._thread
            self._thread = None
        if thread is None:
            return
        self._stop.set()
        with self._lock:
            process = self._process
        if process is not None:
            process.terminate()
        thread.join()

    def status(self) -> str | None:
        with self._lock:
            return self._status

    def clock_payload(
        self,
        *,
        observation_title: str | None = None,
        observation_artist: str | None = None,
    ) -> dict[str, object]:
        now = self._clock()
        with self._lock:
            status = self._status
            if status == "exact" and (
                self._last_tick_at is None or now - self._last_tick_at > STREAM_STALE_SECONDS
            ):
                status = "probe-failed:stale"
            deck = self._active_deck_locked(observation_title, observation_artist)
            if deck is None:
                return {
                    "status": status,
                    "deck": None,
                    "positionSeconds": None,
                    "playing": None,
                    "bpm": None,
                    "title": None,
                    "artist": None,
                    "ageMs": None,
                }
            sample = self._samples[deck - 1]
            track = self._tracks[deck - 1]
            position = (
                None
                if sample is None or sample.sample_position is None
                else max(0.0, sample.sample_position / REKORDBOX_MEMORY_SAMPLE_RATE_HZ)
            )
            return {
                "status": status,
                "deck": deck,
                "positionSeconds": position,
                "playing": None if sample is None else sample.is_playing,
                "bpm": None if sample is None else sample.bpm,
                "title": track.title if track is not None else None,
                "artist": track.artist if track is not None else None,
                "ageMs": None if sample is None else max(0.0, (now - sample.at_monotonic) * 1000.0),
            }

    # The manager loop; also driven one step at a time by tests through _pump.
    def _run(self) -> None:
        while not self._stop.is_set():
            self._pump()

    def _pump(self) -> None:
        process = self._ensure_process()
        if process is None:
            self._pause_before_restart()
            return
        line = process.stdout.readline()
        if not line:
            self._handle_exit(process)
            self._pause_before_restart()
            return
        self._apply_line(line)

    def _pause_before_restart(self) -> None:
        self._pause_fn(self._current_backoff)
        self._current_backoff = min(
            self._current_backoff * 2, self._max_restart_backoff_seconds
        )

    def _ensure_process(self) -> subprocess.Popen[str] | None:
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return self._process
            self._process = None
        if self._stop.is_set():
            return None
        return self._spawn()

    def _handle_exit(self, process: subprocess.Popen[str]) -> None:
        code = process.wait()
        with self._lock:
            if self._process is process:
                self._process = None
        self._set_status(f"probe-failed:exit{code}")
        # A process that lived a while points at a healthy setup that just
        # ended (Rekordbox quit); only rapid crash loops deserve growing waits.
        if self._clock() - self._spawned_at >= 5.0:
            self._current_backoff = self._restart_backoff_seconds

    def _spawn(self) -> subprocess.Popen[str] | None:
        launch = _rekordbox_memory_launch_context(runner=self._runner)
        if isinstance(launch, str):
            self._set_status(launch)
            return None
        pid, chains_path = launch
        try:
            process = self._popen(
                [
                    "bash",
                    str(REKORDBOX_MEMORY_PROBE_SCRIPT),
                    str(pid),
                    str(chains_path),
                    "--stream",
                    str(self._interval_ms),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except OSError:
            self._set_status("probe-failed:bash-missing")
            return None
        with self._lock:
            self._process = process
            self._spawned_at = self._clock()
        self._set_status("exact")
        return process

    def _apply_line(self, line: str) -> None:
        parsed = parse_rekordbox_stream_line(line)
        if parsed is None:
            return
        now = self._clock()
        with self._lock:
            if isinstance(parsed, RekordboxStreamTick):
                self._apply_tick_locked(parsed, now)
            else:
                self._tracks[parsed.deck - 1] = parsed

    def _apply_tick_locked(self, tick: RekordboxStreamTick, now: float) -> None:
        self._master_deck = tick.master_deck
        self._last_tick_at = now
        for deck, (sample, bpm) in enumerate(zip(tick.samples, tick.bpms), start=1):
            previous = self._samples[deck - 1]
            self._samples[deck - 1] = RekordboxStreamDeckSample(
                sample_position=sample,
                bpm=bpm,
                at_monotonic=now,
                previous_sample_position=None if previous is None else previous.sample_position,
            )
        self._status = (
            "exact" if any(value is not None for value in tick.samples) else "probe-failed:unreadable"
        )

    def _set_status(self, status: str) -> None:
        with self._lock:
            self._status = status

    def _active_deck_locked(
        self, observation_title: str | None, observation_artist: str | None
    ) -> int | None:
        master = self._master_deck
        if master is not None:
            track = self._tracks[master]
            if track is not None and track.title:
                return master + 1
        if not observation_title:
            return None
        match = _matching_rekordbox_memory_state(
            observation_title,
            observation_artist,
            memory_states=self._memory_states_locked(),
        )
        return match.deck if match is not None else None

    def _memory_states_locked(self) -> list[RekordboxMemoryDeckState]:
        return [
            RekordboxMemoryDeckState(
                deck=deck,
                title=track.title if track is not None else None,
                artist=track.artist if track is not None else None,
                album=None,
                bpm=sample.bpm if sample is not None else None,
                sample_position=sample.sample_position if sample is not None else None,
                anlz_path=track.anlz_path if track is not None else None,
            )
            for deck, (sample, track) in enumerate(zip(self._samples, self._tracks), start=1)
        ]