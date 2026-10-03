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
# How often the watchdog checks for a probe that stopped producing ticks.
STREAM_WATCHDOG_INTERVAL_SECONDS = 0.25
# Grace between SIGTERM and SIGKILL when restarting a silent probe.
STREAM_KILL_GRACE_SECONDS = 0.5
# How long stop() waits for the pump thread before falling back to SIGKILL.
STOP_JOIN_SECONDS = 2.0
# A deck whose playhead moved within this window counts as playing.
PLAYING_MOTION_SECONDS = 0.25
# A deck whose playhead has not moved for at least this long counts as
# stopped; the gap between the two windows rides out a missed tick without
# flapping the on-air selection.
STOPPED_AFTER_SECONDS = 0.3


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


@dataclass(frozen=True)
class DeckMotion:
    """Playhead motion history for one deck, folded in tick by tick.

    ``last_motion_at`` is when the position last changed and ``playing_since``
    is when the current playing streak began; both stay None until the deck
    shows a second, different reading.
    """

    last_motion_at: float | None
    playing_since: float | None
    last_position: int | None


def _advanced_deck_motion(
    motion: DeckMotion | None, sample: int | None, now: float
) -> DeckMotion:
    """Fold one stream tick into a deck's motion record.

    Any position change counts as motion, so loop wraps and hot-cue jumps
    keep a deck playing while a frozen playhead ages toward stopped. A first
    sighting carries no motion evidence, so a freshly loaded paused deck is
    not mistaken for a playing one; an unreadable tick leaves the record as
    it is so one missed reading cannot erase in-progress motion.
    """
    if motion is None:
        motion = DeckMotion(last_motion_at=None, playing_since=None, last_position=None)
    if sample is None:
        return motion
    if motion.last_position is None or sample == motion.last_position:
        return DeckMotion(
            last_motion_at=motion.last_motion_at,
            playing_since=motion.playing_since,
            last_position=sample,
        )
    was_stopped = (
        motion.last_motion_at is None or now - motion.last_motion_at >= STOPPED_AFTER_SECONDS
    )
    return DeckMotion(
        last_motion_at=now,
        playing_since=now if was_stopped else motion.playing_since,
        last_position=sample,
    )


def _select_playing_deck(
    now: float, current: int | None, motions: list[DeckMotion | None]
) -> int | None:
    """Sticky on-air deck choice driven by playhead motion alone.

    The playing deck keeps the slot through blends; once it stops, the deck
    that has been playing longest takes over; with nothing playing the last
    on-air deck holds so a pause keeps its deck.
    """
    if current is not None:
        motion = motions[current - 1]
        if (
            motion is not None
            and motion.last_motion_at is not None
            and now - motion.last_motion_at < STOPPED_AFTER_SECONDS
        ):
            return current
    candidates = [
        (deck, motion.playing_since)
        for deck, motion in enumerate(motions, start=1)
        if motion is not None
        and motion.last_motion_at is not None
        and now - motion.last_motion_at <= PLAYING_MOTION_SECONDS
    ]
    if not candidates:
        return current
    return min(candidates, key=lambda entry: (entry[1], entry[0]))[0]


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
            # The probe prints BPM with %.3f, so an unreadable deck emits
            # "-1.000" rather than "-1"; either way it means unknown.
            if bpm is not None and bpm < 0:
                bpm = None
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
    # Fields are tab-separated so a title containing " artist=" or " anlz="
    # cannot corrupt them; the probe strips tabs from every field it prints.
    fields = line[len("track "):].split("\t")
    if len(fields) != 4 or not fields[0].startswith("deck="):
        return None
    deck = _int_or_none(fields[0].removeprefix("deck="))
    if deck is None or not 1 <= deck <= 4:
        return None
    prefixes = ("title=", "artist=", "anlz=")
    if not all(field.startswith(prefix) for field, prefix in zip(fields[1:], prefixes)):
        return None
    title, artist, anlz = (
        field[len(prefix):] or None for field, prefix in zip(fields[1:], prefixes)
    )
    return RekordboxStreamTrack(deck=deck, title=title, artist=artist, anlz_path=anlz)


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
        watchdog_interval_seconds: float = STREAM_WATCHDOG_INTERVAL_SECONDS,
        kill_grace_seconds: float = STREAM_KILL_GRACE_SECONDS,
        stop_join_seconds: float = STOP_JOIN_SECONDS,
    ) -> None:
        self._interval_ms = interval_ms
        self._runner = runner
        self._popen = popen
        self._clock = clock
        self._restart_backoff_seconds = restart_backoff_seconds
        self._max_restart_backoff_seconds = max_restart_backoff_seconds
        self._watchdog_interval_seconds = watchdog_interval_seconds
        self._kill_grace_seconds = kill_grace_seconds
        self._stop_join_seconds = stop_join_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._pause_fn = pause_fn if pause_fn is not None else self._stop.wait
        self._thread: threading.Thread | None = None
        self._watchdog: threading.Thread | None = None
        self._process: subprocess.Popen[str] | None = None
        self._spawned_at = 0.0
        self._current_backoff = restart_backoff_seconds
        self._status: str | None = None
        self._master_deck: int | None = None
        self._last_tick_at: float | None = None
        self._samples: list[RekordboxStreamDeckSample | None] = [None, None, None, None]
        self._tracks: list[RekordboxStreamTrack | None] = [None, None, None, None]
        self._deck_motion: list[DeckMotion | None] = [None, None, None, None]
        self._playing_deck: int | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run, name="rekordbox-memory-stream", daemon=True
            )
            self._watchdog = threading.Thread(
                target=self._watch, name="rekordbox-memory-stream-watchdog", daemon=True
            )
            self._thread.start()
            self._watchdog.start()

    def stop(self) -> None:
        with self._lock:
            thread = self._thread
            self._thread = None
            watchdog = self._watchdog
            self._watchdog = None
        if thread is None:
            return
        self._stop.set()
        with self._lock:
            process = self._process
        if process is not None:
            process.terminate()
        thread.join(timeout=self._stop_join_seconds)
        if thread.is_alive():
            # A probe can wedge so hard that even the terminated pipe never
            # yields an EOF; SIGKILL so shutdown cannot hang here.
            self._kill_current_process(kill=True)
            thread.join(timeout=self._stop_join_seconds)
        # A spawn already past its stop check can have published a fresh child
        # after the snapshot above; terminate whatever is current now.
        self._kill_current_process()
        if watchdog is not None:
            watchdog.join(timeout=self._stop_join_seconds)

    def _kill_current_process(self, *, kill: bool = False) -> None:
        with self._lock:
            process = self._process
        if process is None:
            return
        if kill:
            process.kill()
        else:
            process.terminate()

    def _watch(self) -> None:
        """Kills a probe that stopped producing ticks so the pump can respawn.

        A probe wedged mid-syscall never exits but stops printing ticks, which
        would leave the pump thread blocked in readline() forever; ending the
        process turns that readline into an EOF and the normal restart path
        takes over.
        """
        while not self._stop.wait(self._watchdog_interval_seconds):
            with self._lock:
                process = self._process
                reference = (
                    self._spawned_at if self._last_tick_at is None else self._last_tick_at
                )
                stale = (
                    process is not None
                    and self._clock() - reference > STREAM_STALE_SECONDS
                )
            if not stale or process is None or process.poll() is not None:
                continue
            process.terminate()
            time.sleep(self._kill_grace_seconds)
            if process.poll() is None:
                process.kill()

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
            if self._stop.is_set():
                # A stop() that ran while this spawn was in flight never saw
                # this child; terminate it here instead of leaking the probe.
                process.terminate()
                return None
            self._process = process
            self._spawned_at = self._clock()
            self._last_tick_at = None
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
            self._deck_motion[deck - 1] = _advanced_deck_motion(
                self._deck_motion[deck - 1], sample, now
            )
        self._status = (
            "exact" if any(value is not None for value in tick.samples) else "probe-failed:unreadable"
        )
        self._playing_deck = _select_playing_deck(now, self._playing_deck, self._deck_motion)

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
        deck = _select_playing_deck(self._clock(), self._playing_deck, self._deck_motion)
        if deck is not None:
            return deck
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