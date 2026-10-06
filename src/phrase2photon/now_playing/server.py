from __future__ import annotations

import copy
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from phrase2photon.now_playing.identity import audio_identity_slug, normalize_name
from phrase2photon.now_playing.models import (
    PreparedAudioAsset,
    ProviderAttempt,
    ProviderCandidate,
    ResolvedNowPlayingTrack,
    TrackObservation,
)
from phrase2photon.now_playing.providers import (
    DurationGate,
    build_disk_candidates,
    measured_duration_seconds,
    scdl_candidates,
    spotdl_candidates,
)
from phrase2photon.now_playing.rekordbox_analysis import (
    RekordboxAnalysis,
    load_rekordbox_analysis,
    snap_sections_to_bar_grid,
)
from phrase2photon.now_playing.rekordbox_stream import RekordboxMemoryStream
from phrase2photon.now_playing.source_polling import (
    last_rekordbox_diagnostics,
    now_playing_cache_root,
    observation_from_memory_deck_state,
    poll_rekordbox,
    poll_system_now_playing,
    poll_virtualdj,
)
from phrase2photon.now_playing.track_analysis import analyze_track, describe_analyzer_state
from phrase2photon.now_playing.wav_analysis import analyze_audio_sections, build_wav_analysis_extraction

ProviderFn = Callable[[TrackObservation], list[ProviderCandidate]]
PrepareAudioFn = Callable[[ProviderCandidate], Path]
AudioShaFn = Callable[[Path], str]
MeasureDurationFn = Callable[[Path], float]
EnsureShowFn = Callable[[ResolvedNowPlayingTrack], Path]
PollSourceFn = Callable[[], TrackObservation | None]

LOCAL_AUDIO_SUFFIXES = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".mp4",
    ".ogg",
    ".wav",
}

_DEFAULT_SERVICE: NowPlayingService | None = None
_DEFAULT_SERVICE_LOCK = threading.Lock()


@dataclass(frozen=True)
class RouteResponse:
    status_code: int
    content_type: str
    body: bytes | None = None
    file_path: Path | None = None
    content_length: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    file_offset: int = 0
    file_length: int | None = None

    def iter_body(self, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
        if self.body is not None:
            yield self.body
            return
        if self.file_path is None:
            return

        remaining = self.file_length
        with self.file_path.open("rb") as handle:
            if self.file_offset:
                handle.seek(self.file_offset)
            while True:
                if remaining is not None and remaining <= 0:
                    break
                read_size = chunk_size if remaining is None else min(chunk_size, remaining)
                chunk = handle.read(read_size)
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                yield chunk


class NowPlayingService:
    def __init__(
        self,
        *,
        cache_root: Path | None = None,
        gate: DurationGate | None = None,
        poll_source: PollSourceFn | None = None,
        disk_candidates_fn: Callable[[TrackObservation], list[ProviderCandidate]] = build_disk_candidates,
        provider_fns: Iterable[tuple[str, ProviderFn]] | None = None,
        prepare_audio: PrepareAudioFn | None = None,
        audio_sha256: AudioShaFn | None = None,
        measure_duration: MeasureDurationFn = measured_duration_seconds,
        ensure_show: EnsureShowFn | None = None,
        min_refresh_interval_seconds: float = 0.5,
        memory_stream: RekordboxMemoryStream | None = None,
    ) -> None:
        self.cache_root = cache_root or now_playing_cache_root()
        self.gate = gate or DurationGate(max_delta_seconds=2.0)
        self.poll_source = poll_source or poll_now_playing_source
        self.disk_candidates_fn = disk_candidates_fn
        self.provider_fns = (
            list(provider_fns)
            if provider_fns is not None
            else [("scdl", scdl_candidates), ("spotdl", spotdl_candidates)]
        )
        self.prepare_audio = prepare_audio or self._prepare_audio_candidate
        self.audio_sha256 = audio_sha256 or audio_sha256_file
        self.measure_duration = measure_duration
        self.ensure_show = ensure_show or (lambda resolved: ensure_compiled_show(resolved, cache_root=self.cache_root))
        self.min_refresh_interval_seconds = min_refresh_interval_seconds
        self.memory_stream = memory_stream if memory_stream is not None else RekordboxMemoryStream()

        self._lock = threading.Lock()
        self._status = current_status_payload()
        self._resolved: ResolvedNowPlayingTrack | None = None
        self._latest_observed_at = None
        self._last_refresh_monotonic = 0.0
        self._last_on_air_deck: int | None = None
        self._preparing_key: str | None = None
        self._preparing_payload: dict[str, str] | None = None
        self._preparing_attempts: list[ProviderAttempt] = []
        self._preparing_result: tuple[ResolvedNowPlayingTrack | None, list[ProviderAttempt]] | None = None
        self._prepare_thread: threading.Thread | None = None

    def status_payload(self) -> dict[str, object]:
        self.refresh()
        with self._lock:
            return copy.deepcopy(self._status)

    def start_memory_stream(self) -> None:
        self.memory_stream.start()

    def clock_payload(self) -> dict[str, object]:
        with self._lock:
            observation = self._status.get("observation")
            active_show_id = self._status.get("activeShowId")
        title = observation.get("title") if isinstance(observation, dict) else None
        artist = observation.get("artist") if isinstance(observation, dict) else None
        observation_deck = observation.get("deck") if isinstance(observation, dict) else None
        payload = self.memory_stream.clock_payload(
            observation_title=title if isinstance(title, str) else None,
            observation_artist=artist if isinstance(artist, str) else None,
            # The show the backend resolved the deck's track to; the clock sample
            # must never drive a show it does not belong to.
            show_id=active_show_id if isinstance(active_show_id, str) else None,
        )
        # While the status still describes the outgoing deck, a sample from the
        # incoming one belongs to no show yet; handing it the old show id would
        # run that show at the wrong deck's playhead.
        if (
            payload.get("deck") is not None
            and observation_deck is not None
            and payload.get("deck") != observation_deck
        ):
            payload["showId"] = None
        return payload

    def refresh(self, *, force: bool = False) -> dict[str, object]:
        with self._lock:
            now_monotonic = time.monotonic()
            # A deck switch must resolve immediately: the outgoing deck's show
            # rides a playhead that no longer belongs to it until this happens.
            on_air_deck = self.memory_stream.on_air_deck_number()
            if not force and on_air_deck is not None and on_air_deck != self._last_on_air_deck:
                force = True
            self._last_on_air_deck = on_air_deck
            if (
                not force
                and self._last_refresh_monotonic
                and now_monotonic - self._last_refresh_monotonic < self.min_refresh_interval_seconds
            ):
                return copy.deepcopy(self._status)

            observation = _prefer_on_air_deck(self.poll_source(), self.memory_stream)
            self._last_refresh_monotonic = now_monotonic

            if observation is None:
                self._resolved = None
                self._latest_observed_at = None
                self._clear_prepare_state_locked()
                self._status = build_status_payload(
                    observation=None,
                    mode_state="reactive_fallback",
                    active_show_id=None,
                    armed_show_id=None,
                    prepared_asset=None,
                    show_dir=None,
                    provider_attempts=[],
                    preparing=None,
                    source_diagnostics=last_rekordbox_diagnostics(),
                )
                return copy.deepcopy(self._status)

            if self._latest_observed_at is not None and observation.observed_at < self._latest_observed_at:
                return copy.deepcopy(self._status)
            self._latest_observed_at = observation.observed_at

            if self._resolved is not None and _observations_match(
                self._resolved.observation,
                observation,
                gate=self.gate,
            ):
                observation = _preserve_playback_if_needed(self._resolved.observation, observation)
                self._resolved = self._resolved.model_copy(update={"observation": observation})
                show_dir = self._resolved.show_dir or show_dir_for_identity(self._resolved.audio_identity)
                self._clear_prepare_state_locked()
                self._status = build_status_payload(
                    observation=observation,
                    mode_state="premade_active",
                    active_show_id=self._resolved.audio_identity,
                    armed_show_id=self._resolved.audio_identity,
                    prepared_asset=self._resolved.asset,
                    show_dir=show_dir,
                    provider_attempts=[
                        ProviderAttempt(
                            provider=self._resolved.asset.provider,
                            status="cached",
                            message="reusing prepared audio and compiled show",
                        )
                    ],
                    preparing=None,
                    source_diagnostics=_source_diagnostics_for_observation(observation),
                )
                return copy.deepcopy(self._status)

            prepare_key = _preparation_key(observation)
            if self._preparing_key == prepare_key:
                if self._preparing_result is not None:
                    resolved, provider_attempts = self._preparing_result
                    self._clear_prepare_state_locked()
                    if resolved is None:
                        self._resolved = None
                        self._status = build_status_payload(
                            observation=observation,
                            mode_state="reactive_fallback",
                            active_show_id=None,
                            armed_show_id=None,
                            prepared_asset=None,
                            show_dir=None,
                            provider_attempts=provider_attempts,
                            preparing=None,
                            source_diagnostics=_source_diagnostics_for_observation(observation),
                        )
                        return copy.deepcopy(self._status)

                    self._resolved = resolved
                    self._status = build_status_payload(
                        observation=resolved.observation,
                        mode_state="premade_active",
                        active_show_id=resolved.audio_identity,
                        armed_show_id=resolved.audio_identity,
                        prepared_asset=resolved.asset,
                        show_dir=resolved.show_dir,
                        provider_attempts=provider_attempts,
                        preparing=None,
                        source_diagnostics=_source_diagnostics_for_observation(resolved.observation),
                    )
                    return copy.deepcopy(self._status)

                if self._prepare_thread is not None and self._prepare_thread.is_alive():
                    self._resolved = None
                    self._status = build_status_payload(
                        observation=observation,
                        mode_state="reactive_fallback",
                        active_show_id=None,
                        armed_show_id=None,
                        prepared_asset=None,
                        show_dir=None,
                        provider_attempts=self._preparing_attempts,
                        preparing=self._preparing_payload,
                        source_diagnostics=_source_diagnostics_for_observation(observation),
                    )
                    return copy.deepcopy(self._status)

            if self._preparing_key is not None and (
                self._prepare_thread is None or not self._prepare_thread.is_alive()
            ):
                self._clear_prepare_state_locked()

            self._start_prepare_job_locked(observation)
            self._resolved = None
            self._status = build_status_payload(
                observation=observation,
                mode_state="reactive_fallback",
                active_show_id=None,
                armed_show_id=None,
                prepared_asset=None,
                show_dir=None,
                provider_attempts=self._preparing_attempts,
                preparing=self._preparing_payload,
                source_diagnostics=_source_diagnostics_for_observation(observation),
            )
            return copy.deepcopy(self._status)

    def _clear_prepare_state_locked(self) -> None:
        self._preparing_key = None
        self._preparing_payload = None
        self._preparing_attempts = []
        self._preparing_result = None
        self._prepare_thread = None

    def _start_prepare_job_locked(self, observation: TrackObservation) -> None:
        key = _preparation_key(observation)
        self._preparing_key = key
        self._preparing_payload = {
            "showId": "",
            "stage": "matching_audio",
            "message": "Matching cached or downloadable audio.",
        }
        self._preparing_attempts = []
        self._preparing_result = None
        self._prepare_thread = threading.Thread(
            target=self._run_prepare_job,
            args=(key, observation.model_copy(deep=True)),
            daemon=True,
        )
        self._prepare_thread.start()

    def _run_prepare_job(self, key: str, observation: TrackObservation) -> None:
        resolved, provider_attempts = self._resolve_observation(observation)
        with self._lock:
            if self._preparing_key != key:
                return
            self._preparing_attempts = provider_attempts
        if resolved is None:
            with self._lock:
                if self._preparing_key == key:
                    self._preparing_result = (None, provider_attempts)
            return

        with self._lock:
            if self._preparing_key != key:
                return
            self._preparing_payload = {
                "showId": resolved.audio_identity,
                "stage": "compiling_show",
                "message": "Caching audio and compiling show.",
            }
        try:
            show_dir = self.ensure_show(resolved)
            resolved.show_dir = show_dir
            result: tuple[ResolvedNowPlayingTrack | None, list[ProviderAttempt]] = (resolved, provider_attempts)
        except Exception as error:
            result = (
                None,
                [
                    *provider_attempts,
                    ProviderAttempt(
                        provider=resolved.asset.provider,
                        status="error",
                        message=f"show preparation failed: {error}",
                    ),
                ],
            )
        with self._lock:
            if self._preparing_key == key:
                self._preparing_attempts = result[1]
                self._preparing_result = result

    def _resolve_observation(
        self,
        observation: TrackObservation,
    ) -> tuple[ResolvedNowPlayingTrack | None, list[ProviderAttempt]]:
        disk_candidates = self.disk_candidates_fn(observation)
        resolved, disk_attempt = self._resolve_candidates(
            observation=observation,
            provider_name="disk",
            candidates=disk_candidates,
        )
        provider_attempts = [disk_attempt]
        if resolved is not None:
            return resolved, provider_attempts

        for provider_name, provider_fn in self.provider_fns:
            try:
                candidates = provider_fn(observation)
            except Exception as error:
                provider_attempts.append(
                    ProviderAttempt(
                        provider=provider_name,
                        status="error",
                        message=f"provider query failed: {error}",
                    )
                )
                continue

            resolved, attempt = self._resolve_candidates(
                observation=observation,
                provider_name=provider_name,
                candidates=candidates,
            )
            provider_attempts.append(attempt)
            if resolved is not None:
                return resolved, provider_attempts

        return None, provider_attempts

    def _resolve_candidates(
        self,
        *,
        observation: TrackObservation,
        provider_name: str,
        candidates: list[ProviderCandidate],
    ) -> tuple[ResolvedNowPlayingTrack | None, ProviderAttempt]:
        if not candidates:
            return None, ProviderAttempt(provider=provider_name, status="miss", message="no candidates")

        rejection_messages: list[str] = []
        for candidate in candidates:
            reported_duration = candidate.reported_duration_seconds
            if reported_duration is not None and not self.gate.matches(observation.duration_seconds, reported_duration):
                rejection_messages.append(f"{candidate.title}: reported duration mismatch")
                continue
            try:
                prepared_path = self.prepare_audio(candidate)
            except Exception as error:
                rejection_messages.append(f"{candidate.title}: prepare failed ({error})")
                continue

            try:
                audio_sha256 = self.audio_sha256(prepared_path)
            except Exception as error:
                rejection_messages.append(f"{candidate.title}: fingerprint failed ({error})")
                continue

            try:
                measured_duration = self.measure_duration(prepared_path)
            except Exception as error:
                rejection_messages.append(f"{candidate.title}: duration read failed ({error})")
                continue

            if (
                not _matches_exact_disk_source_hint(observation, candidate)
                and not self.gate.matches(observation.duration_seconds, measured_duration)
            ):
                rejection_messages.append(f"{candidate.title}: measured duration mismatch")
                continue

            asset = PreparedAudioAsset(
                local_path=prepared_path,
                measured_duration_seconds=measured_duration,
                audio_sha256=audio_sha256,
                provider=provider_name,
            )
            resolved = ResolvedNowPlayingTrack(
                observation=observation,
                asset=asset,
                audio_identity=audio_identity_slug(observation, asset),
            )
            return resolved, ProviderAttempt(
                provider=provider_name,
                status="hit",
                message=f"resolved from {candidate.title}",
            )

        return None, ProviderAttempt(
            provider=provider_name,
            status="rejected",
            message="; ".join(rejection_messages[:3]) or "all candidates rejected",
        )

    def _prepare_audio_candidate(self, candidate: ProviderCandidate) -> Path:
        if candidate.local_path is not None:
            return candidate.local_path

        provider = candidate.provider.casefold()
        query = " ".join(part for part in [candidate.title, candidate.artist] if part).strip()
        if not query:
            raise ValueError("candidate is missing a usable query")

        download_dir = self.cache_root / "_downloads" / provider / _download_slug(query)
        existing = _downloaded_audio_files(download_dir)
        if existing:
            return existing[0]

        download_dir.mkdir(parents=True, exist_ok=True)
        if provider == "scdl":
            command = [
                "uv",
                "run",
                "--with",
                "scdl",
                "scdl",
                "--query",
                query,
                "--path",
                str(download_dir),
            ]
        elif provider == "spotdl":
            command = [
                "uv",
                "run",
                "--with",
                "spotdl",
                "spotdl",
                query,
                "--output",
                str(download_dir / "{title}.{output-ext}"),
            ]
        else:
            raise ValueError(f"Unsupported provider: {candidate.provider}")

        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            stderr = result.stderr.strip() or result.stdout.strip() or "unknown provider error"
            raise RuntimeError(stderr)

        downloaded = _downloaded_audio_files(download_dir)
        if not downloaded:
            raise FileNotFoundError(f"{candidate.provider} did not produce a local audio file")
        return downloaded[0]


def poll_now_playing_source() -> TrackObservation | None:
    observations: list[TrackObservation] = []
    for poller in (poll_rekordbox, poll_virtualdj, poll_system_now_playing):
        observation = poller()
        if observation is not None:
            observations.append(observation)
    if not observations:
        return None
    return max(observations, key=lambda observation: observation.observed_at)


def _prefer_on_air_deck(
    observation: TrackObservation | None,
    memory_stream: RekordboxMemoryStream,
) -> TrackObservation | None:
    """Replaces the polled observation with the on-air deck's own track.

    The agent log records the last loaded track, which lags a transition: while
    the previous deck still plays, the log already describes the incoming one.
    The memory stream's playing-deck rule decides which deck is on air, so the
    show and the transport clock always come from the same deck. A deck that is
    actually playing outranks every other source — a paused Music.app holding
    the incoming track must not outvote it — while a paused deck only corrects
    the Rekordbox observation. The log observation survives whenever the stream
    cannot provide an on-air track.
    """
    on_air = memory_stream.on_air_deck_state(
        observation_title=observation.title if observation is not None else None,
        observation_artist=observation.artist if observation is not None else None,
    )
    if on_air is None:
        return observation
    deck_observation = observation_from_memory_deck_state(
        on_air.state, is_playing=on_air.is_playing
    )
    if deck_observation is None:
        return observation
    if observation is None:
        return deck_observation if on_air.is_playing else None
    if observation.source_app == "Rekordbox" or on_air.is_playing:
        return deck_observation
    return observation


def _matches_exact_disk_source_hint(observation: TrackObservation, candidate: ProviderCandidate) -> bool:
    return (
        candidate.provider == "disk"
        and observation.source_hint_path is not None
        and candidate.local_path is not None
        and observation.source_hint_path == candidate.local_path
    )


# Used only when the runtime analyser is unavailable. Any fixed tempo is
# wrong for most tracks; this keeps Now Playing running rather than correct.
FALLBACK_TEMPO = 124.0
# Written next to the compiled show when the fallback above produced it, so
# ahead-of-time preparation can tell a measured show from a guessed one.
FALLBACK_ANALYSIS_MARKER = "fallback-analysis"
# Records which analysis produced a show and, for rekordbox-backed shows, the
# mtimes of the ANLZ files it came from: Noah re-grids a track by hand and the
# cached show must follow.
ANALYSIS_SOURCE_SIDECAR = "analysis-source.json"


def show_dir_for_identity(audio_identity: str, *, cache_root: Path | None = None) -> Path:
    root = cache_root or now_playing_cache_root()
    return root / audio_identity / "show"


def ensure_compiled_show(
    resolved: ResolvedNowPlayingTrack,
    *,
    cache_root: Path | None = None,
    force: bool = False,
) -> Path:
    show_dir = show_dir_for_identity(resolved.audio_identity, cache_root=cache_root)
    cache_dir = show_dir.parent
    if force:
        shutil.rmtree(cache_dir, ignore_errors=True)
    cached_audio = _ensure_cached_audio(resolved, cache_root=cache_root)
    show_json = show_dir / "show.json"
    if show_json.exists() and _cached_analysis_current(show_dir):
        resolved.show_dir = show_dir
        return show_dir

    duration_seconds = resolved.asset.measured_duration_seconds
    # Rekordbox's own grid wins when the file is in the collection: Noah fixes
    # those beat grids by hand, so the downbeat is exact. Everything below is
    # the analyser path the service used before this existed.
    rekordbox = load_rekordbox_analysis(resolved.asset.local_path)
    tempo_map = rekordbox.tempo_map if rekordbox else None
    used_fallback = False
    if rekordbox is not None:
        tempo = rekordbox.tempo_map[0].bpm
        downbeat_seconds = rekordbox.tempo_map[0].downbeat_seconds
        sections = _rekordbox_sections(rekordbox, cached_audio, duration_seconds=duration_seconds, tempo=tempo)
    else:
        # Prefer the runtime's analyser: it is the same code the live and library
        # paths use, and it is validated against Mixed In Key. The heuristic below
        # is only a fallback for when the analyser bundle has not been built.
        analysis = analyze_track(cached_audio)
        if analysis is not None:
            tempo = analysis.tempo
            sections = analysis.sections
            downbeat_seconds = analysis.first_downbeat_seconds
        else:
            used_fallback = True
            tempo = FALLBACK_TEMPO
            sections = analyze_audio_sections(cached_audio, duration_seconds=duration_seconds, tempo=tempo)
            downbeat_seconds = 0.0

    extraction = build_wav_analysis_extraction(
        audio_path=cached_audio,
        title=resolved.observation.title,
        artist=resolved.observation.artist,
        duration_seconds=duration_seconds,
        tempo=tempo,
        sections=sections,
        downbeat_seconds=downbeat_seconds,
        tempo_map=tempo_map,
        subdivide=rekordbox is None,
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    if used_fallback:
        (cache_dir / FALLBACK_ANALYSIS_MARKER).write_text(f"tempo={FALLBACK_TEMPO}\n", encoding="utf-8")
    extraction_path = cache_dir / "wav-analysis.extraction.json"
    extraction_path.write_text(extraction.model_dump_json(indent=2) + "\n", encoding="utf-8")
    compile_show_package(cache_dir, show_dir, extraction_path)
    _write_analysis_source_sidecar(show_dir, rekordbox)
    resolved.show_dir = show_dir
    return show_dir


def compile_show_package(cache_dir: Path, show_dir: Path, extraction_path: Path) -> None:
    """Compiles the extraction and swaps the finished show dir into place.

    Compiling straight into the live show dir left a half-written show.json
    behind when the compile died mid-write, so it runs in a staging dir beside
    the show dir and the finished directory is renamed in; a failed compile
    leaves the previous show untouched.
    """
    with tempfile.TemporaryDirectory(prefix="p2p-compile-", dir=cache_dir) as temp:
        staging = Path(temp) / "show"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "phrase2photon.cli",
                "compile",
                "--extraction-in",
                str(extraction_path),
                "--outdir",
                str(staging),
            ],
            check=True,
        )
        shutil.rmtree(show_dir, ignore_errors=True)
        os.replace(staging, show_dir)


def _rekordbox_sections(
    rekordbox: RekordboxAnalysis,
    cached_audio: Path,
    *,
    duration_seconds: float,
    tempo: float,
) -> list[dict[str, Any]]:
    if rekordbox.phrases:
        return [
            {
                "label": phrase.label,
                "energy": phrase.energy,
                "start_seconds": phrase.start_seconds,
                "end_seconds": phrase.end_seconds,
            }
            for phrase in rekordbox.phrases
        ]
    # No phrase analysis in rekordbox: keep the analyser's structure but put
    # every interior boundary on a bar of rekordbox's hand-fixed grid.
    analysis = analyze_track(cached_audio)
    if analysis is not None:
        sections = analysis.sections
    else:
        sections = analyze_audio_sections(cached_audio, duration_seconds=duration_seconds, tempo=tempo)
    return snap_sections_to_bar_grid(sections, rekordbox)


def _cached_analysis_current(show_dir: Path) -> bool:
    """True when the cached show's analysis is still the one we would build.

    Rekordbox-backed shows record their ANLZ mtimes next to show.json, so a
    re-gridded track rebuilds on the next preparation. Shows compiled from the
    analyser, or before the sidecar existed, never invalidate here.
    """
    sidecar = show_dir / ANALYSIS_SOURCE_SIDECAR
    if not sidecar.is_file():
        return True
    try:
        payload = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    for path_text, mtime in (payload.get("anlz_mtimes") or {}).items():
        try:
            if Path(path_text).stat().st_mtime != mtime:
                return False
        except OSError:
            return False
    return True


def _write_analysis_source_sidecar(show_dir: Path, rekordbox: RekordboxAnalysis | None) -> None:
    mtimes: dict[str, float] = {}
    if rekordbox is not None:
        mtimes = {str(path): path.stat().st_mtime for path in rekordbox.anlz_files}
    (show_dir / ANALYSIS_SOURCE_SIDECAR).write_text(
        json.dumps({"analysis_source": "rekordbox-anlz" if rekordbox else "analyser", "anlz_mtimes": mtimes}, indent=2) + "\n",
        encoding="utf-8",
    )


def build_status_payload(
    *,
    observation: TrackObservation | None,
    mode_state: str,
    active_show_id: str | None,
    armed_show_id: str | None,
    prepared_asset: PreparedAudioAsset | None,
    show_dir: Path | None,
    provider_attempts: Iterable[dict[str, str] | ProviderAttempt],
    preparing: dict[str, str] | None,
    source_diagnostics: dict[str, object] | None = None,
) -> dict[str, object]:
    show_url = f"/api/now-playing/show/{armed_show_id}" if armed_show_id and show_dir else None
    audio_url = f"/api/now-playing/audio/{armed_show_id}" if armed_show_id and prepared_asset else None
    return {
        "observation": None if observation is None else observation.model_dump(mode="json"),
        "modeState": mode_state,
        "activeShowId": active_show_id,
        "armedShow": None
        if armed_show_id is None
        else {
            "id": armed_show_id,
            "showUrl": show_url,
        },
        "preparedAudio": None
        if prepared_asset is None
        else {
            "path": str(prepared_asset.local_path),
            "audioUrl": audio_url,
            "durationSeconds": prepared_asset.measured_duration_seconds,
            "provider": prepared_asset.provider,
        },
        "preparing": preparing,
        "providerAttempts": [_provider_attempt_payload(attempt) for attempt in provider_attempts],
        "sourceDiagnostics": source_diagnostics,
        "analyzer": describe_analyzer_state(),
    }


def current_status_payload() -> dict[str, object]:
    return build_status_payload(
        observation=None,
        mode_state="reactive_fallback",
        active_show_id=None,
        armed_show_id=None,
        prepared_asset=None,
        show_dir=None,
        provider_attempts=[],
        preparing=None,
        source_diagnostics=None,
    )


def route_request(
    path: str,
    *,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
    cache_root: Path | None = None,
    status_provider: Callable[[], dict[str, object]] | None = None,
    clock_provider: Callable[[], dict[str, object]] | None = None,
) -> RouteResponse:
    normalized_path = urlparse(path).path
    root = cache_root or now_playing_cache_root()

    if normalized_path == "/api/now-playing/status":
        provider = status_provider or _default_now_playing_service().status_payload
        return _json_response(provider())

    if normalized_path == "/api/now-playing/clock":
        provider = clock_provider or _default_now_playing_service().clock_payload
        return _json_response(provider())

    if normalized_path == "/api/now-playing/debug/rekordbox":
        poll_rekordbox()
        diagnostics = last_rekordbox_diagnostics() or {"source_app": "Rekordbox", "open_audio_candidates": []}
        return _json_response(diagnostics)

    if normalized_path == "/api/now-playing/library":
        return _json_response({"tracks": list_cached_now_playing_tracks(root)})

    if normalized_path.startswith("/api/now-playing/show/"):
        show_id = normalized_path.rsplit("/", 1)[-1]
        show_json = root / show_id / "show" / "show.json"
        if not show_json.exists():
            return _json_response({"error": "Show not found"}, status_code=404)
        body = show_json.read_bytes()
        return RouteResponse(
            status_code=200,
            content_type="application/json",
            body=body,
            content_length=len(body),
        )

    if normalized_path.startswith("/api/now-playing/audio/"):
        show_id = normalized_path.rsplit("/", 1)[-1]
        audio_path = _cached_audio_path(root / show_id)
        if audio_path is None:
            return _json_response({"error": "Audio not found"}, status_code=404)
        return _audio_file_response(audio_path, headers=headers)

    return _json_response({"error": "Not found"}, status_code=404)


def run_server(host: str, port: int) -> None:
    service = _default_now_playing_service()
    service.start_memory_stream()

    class NowPlayingHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self._respond(method="GET", include_body=True)

        def do_HEAD(self) -> None:  # noqa: N802
            self._respond(method="HEAD", include_body=False)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A003
            return

        def _respond(self, *, method: str, include_body: bool) -> None:
            response = route_request(
                self.path,
                method=method,
                headers=self.headers,
                status_provider=service.status_payload,
            )
            self.send_response(response.status_code)
            self.send_header("Content-Type", response.content_type)
            self.send_header("Content-Length", str(response.content_length))
            for key, value in response.headers.items():
                self.send_header(key, value)
            self.end_headers()
            if include_body:
                for chunk in response.iter_body():
                    self.wfile.write(chunk)

    with ThreadingHTTPServer((host, port), NowPlayingHandler) as server:
        server.serve_forever()


def audio_sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _default_now_playing_service() -> NowPlayingService:
    global _DEFAULT_SERVICE
    with _DEFAULT_SERVICE_LOCK:
        if _DEFAULT_SERVICE is None:
            _DEFAULT_SERVICE = NowPlayingService()
        return _DEFAULT_SERVICE


def _audio_file_response(audio_path: Path, *, headers: Mapping[str, str] | None) -> RouteResponse:
    content_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    if content_type == "audio/x-wav":
        content_type = "audio/wav"

    size = audio_path.stat().st_size
    range_header = None if headers is None else headers.get("Range")
    base_headers = {"Accept-Ranges": "bytes"}
    if not range_header:
        return RouteResponse(
            status_code=200,
            content_type=content_type,
            body=None,
            file_path=audio_path,
            content_length=size,
            headers=base_headers,
            file_offset=0,
            file_length=size,
        )

    try:
        start, end = _parse_range_header(range_header, size)
    except ValueError:
        return RouteResponse(
            status_code=416,
            content_type=content_type,
            body=b"",
            content_length=0,
            headers={
                **base_headers,
                "Content-Range": f"bytes */{size}",
            },
        )

    content_length = end - start + 1
    return RouteResponse(
        status_code=206,
        content_type=content_type,
        body=None,
        file_path=audio_path,
        content_length=content_length,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
        },
        file_offset=start,
        file_length=content_length,
    )


def _parse_range_header(value: str, size: int) -> tuple[int, int]:
    if not value.startswith("bytes="):
        raise ValueError("unsupported range unit")
    spec = value[6:].strip()
    if "," in spec:
        raise ValueError("multiple ranges are unsupported")
    if "-" not in spec:
        raise ValueError("invalid range")

    start_text, end_text = spec.split("-", 1)
    if not start_text:
        suffix_length = int(end_text)
        if suffix_length <= 0:
            raise ValueError("invalid suffix range")
        if suffix_length >= size:
            return 0, size - 1
        return size - suffix_length, size - 1

    start = int(start_text)
    if start < 0 or start >= size:
        raise ValueError("range start out of bounds")
    if not end_text:
        return start, size - 1

    end = int(end_text)
    if end < start:
        raise ValueError("range end before start")
    if end >= size:
        end = size - 1
    return start, end


def _provider_attempt_payload(attempt: dict[str, str] | ProviderAttempt) -> dict[str, str]:
    if hasattr(attempt, "model_dump"):
        dumped = attempt.model_dump()
        return {
            "provider": str(dumped["provider"]),
            "status": str(dumped["status"]),
            "message": str(dumped["message"]),
        }
    return {
        "provider": str(attempt["provider"]),
        "status": str(attempt["status"]),
        "message": str(attempt["message"]),
    }


def _source_diagnostics_for_observation(observation: TrackObservation | None) -> dict[str, object] | None:
    if observation is None or observation.source_app == "Rekordbox":
        return last_rekordbox_diagnostics()
    return None


def _json_response(payload: dict[str, object], *, status_code: int = 200) -> RouteResponse:
    body = json.dumps(payload).encode("utf-8")
    return RouteResponse(
        status_code=status_code,
        content_type="application/json",
        body=body,
        content_length=len(body),
    )


def _ensure_cached_audio(
    resolved: ResolvedNowPlayingTrack,
    *,
    cache_root: Path | None = None,
) -> Path:
    cache_dir = show_dir_for_identity(resolved.audio_identity, cache_root=cache_root).parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    suffix = resolved.asset.local_path.suffix or ".wav"
    cached_audio = cache_dir / f"prepared-audio{suffix}"
    if cached_audio.exists():
        return cached_audio
    try:
        cached_audio.symlink_to(resolved.asset.local_path)
    except OSError:
        shutil.copy2(resolved.asset.local_path, cached_audio)
    return cached_audio


def _cached_audio_path(cache_dir: Path) -> Path | None:
    matches = sorted(cache_dir.glob("prepared-audio.*"))
    if not matches:
        return None
    return matches[0]


def _download_slug(query: str) -> str:
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()
    prefix = normalize_name(query).replace(" ", "-")[:48].strip("-")
    if prefix:
        return f"{prefix}-{digest[:12]}"
    return digest[:12]


def _downloaded_audio_files(download_dir: Path) -> list[Path]:
    if not download_dir.exists():
        return []
    matches = [
        path
        for path in download_dir.rglob("*")
        if path.is_file() and path.suffix.casefold() in LOCAL_AUDIO_SUFFIXES
    ]
    matches.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return matches


def list_cached_now_playing_tracks(cache_root: Path) -> list[dict[str, object]]:
    tracks: list[dict[str, object]] = []
    for show_root in sorted(cache_root.iterdir()) if cache_root.exists() else []:
        if not show_root.is_dir():
            continue
        show_json = show_root / "show" / "show.json"
        audio_path = _cached_audio_path(show_root)
        if not show_json.exists() or audio_path is None:
            continue
        try:
            payload = json.loads(show_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        song = payload.get("song", {}) if isinstance(payload, dict) else {}
        title = song.get("title") if isinstance(song, dict) else None
        tempo = song.get("tempo") if isinstance(song, dict) else None
        tracks.append(
            {
                "id": show_root.name,
                "title": str(title or show_root.name),
                "artist": None,
                "abletonProjectPath": None,
                "bpm": float(tempo) if isinstance(tempo, (int, float)) else None,
                "notes": "Cached from Now Playing",
                "audioUrl": f"/api/now-playing/audio/{show_root.name}",
                "showUrl": f"/api/now-playing/show/{show_root.name}",
                "exportShowUrl": f"/api/now-playing/show/{show_root.name}",
            }
        )
    return tracks


def _preparation_key(observation: TrackObservation) -> str:
    return "::".join(
        [
            normalize_name(observation.title),
            normalize_name(observation.artist),
            str(round(observation.duration_seconds, 3)),
        ]
    )


def _preserve_playback_if_needed(
    previous: TrackObservation,
    current: TrackObservation,
) -> TrackObservation:
    if current.playback_position_seconds is not None or previous.playback_position_seconds is None:
        return current

    frozen_at = datetime.now(timezone.utc)
    playback_position = previous.playback_position_seconds
    keep_advancing_rekordbox = (
        previous.source_app == "Rekordbox"
        and current.source_app == "Rekordbox"
        and previous.source_hint_path is not None
        and previous.source_hint_path == current.source_hint_path
        and previous.is_playing is True
    )
    if previous.is_playing is True:
        playback_position = min(
            previous.duration_seconds,
            previous.playback_position_seconds + max(0.0, (frozen_at - previous.observed_at).total_seconds()),
        )
    is_playing = True if keep_advancing_rekordbox and playback_position < current.duration_seconds else False
    return current.model_copy(
        update={
            "observed_at": frozen_at,
            "playback_position_seconds": playback_position,
            "is_playing": is_playing,
        }
    )


def _observations_match(
    left: TrackObservation,
    right: TrackObservation,
    *,
    gate: DurationGate,
) -> bool:
    return (
        normalize_name(left.title) == normalize_name(right.title)
        and normalize_name(left.artist) == normalize_name(right.artist)
        and gate.matches(left.duration_seconds, right.duration_seconds)
    )
