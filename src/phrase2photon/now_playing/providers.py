from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from mutagen import File as open_audio
from pydantic import ValidationError

from phrase2photon.now_playing.identity import audio_identity_slug, normalize_name
from phrase2photon.now_playing.models import (
    PreparedAudioAsset,
    ProviderCandidate,
    ResolvedNowPlayingTrack,
    TrackObservation,
)

ProviderFn = Callable[[TrackObservation], list[ProviderCandidate]]
PrepareAudioFn = Callable[[ProviderCandidate], Path]
AudioShaFn = Callable[[Path], str]
MeasureDurationFn = Callable[[Path], float]
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


@dataclass(frozen=True)
class DurationGate:
    max_delta_seconds: float = 2.0

    def matches(self, observed_seconds: float, candidate_seconds: float | None) -> bool:
        return candidate_seconds is not None and abs(observed_seconds - candidate_seconds) <= self.max_delta_seconds


def measured_duration_seconds(path: Path) -> float:
    metadata = open_audio(path)
    if metadata is None or metadata.info is None or getattr(metadata.info, "length", None) is None:
        raise ValueError(f"Could not read duration for {path}")
    return float(metadata.info.length)


def resolve_audio_asset(
    observation: TrackObservation,
    providers: Iterable[ProviderFn],
    disk_candidates: list[ProviderCandidate],
    gate: DurationGate,
    prepare_audio: PrepareAudioFn,
    audio_sha256: AudioShaFn,
    measure_duration: MeasureDurationFn = measured_duration_seconds,
) -> ResolvedNowPlayingTrack | None:
    for candidate in disk_candidates:
        resolved = _try_resolve_candidate(
            observation=observation,
            candidate=candidate,
            gate=gate,
            prepare_audio=prepare_audio,
            audio_sha256=audio_sha256,
            measure_duration=measure_duration,
            require_reported_match=False,
        )
        if resolved is not None:
            return resolved

    for provider in providers:
        try:
            provider_candidates = provider(observation)
        except Exception:
            continue
        for candidate in provider_candidates:
            resolved = _try_resolve_candidate(
                observation=observation,
                candidate=candidate,
                gate=gate,
                prepare_audio=prepare_audio,
                audio_sha256=audio_sha256,
                measure_duration=measure_duration,
                require_reported_match=True,
            )
            if resolved is not None:
                return resolved

    return None


def _try_resolve_candidate(
    *,
    observation: TrackObservation,
    candidate: ProviderCandidate,
    gate: DurationGate,
    prepare_audio: PrepareAudioFn,
    audio_sha256: AudioShaFn,
    measure_duration: MeasureDurationFn,
    require_reported_match: bool,
) -> ResolvedNowPlayingTrack | None:
    try:
        return _resolve_candidate(
            observation=observation,
            candidate=candidate,
            gate=gate,
            prepare_audio=prepare_audio,
            audio_sha256=audio_sha256,
            measure_duration=measure_duration,
            require_reported_match=require_reported_match,
        )
    except Exception:
        return None


def _resolve_candidate(
    *,
    observation: TrackObservation,
    candidate: ProviderCandidate,
    gate: DurationGate,
    prepare_audio: PrepareAudioFn,
    audio_sha256: AudioShaFn,
    measure_duration: MeasureDurationFn,
    require_reported_match: bool,
) -> ResolvedNowPlayingTrack | None:
    if (
        require_reported_match
        and candidate.reported_duration_seconds is not None
        and not gate.matches(
            observation.duration_seconds,
            candidate.reported_duration_seconds,
        )
    ):
        return None
    if (
        not require_reported_match
        and candidate.reported_duration_seconds is not None
        and not gate.matches(observation.duration_seconds, candidate.reported_duration_seconds)
    ):
        return None

    prepared_path = prepare_audio(candidate)
    measured = measure_duration(prepared_path)
    exact_source_hint_match = _matches_source_hint(observation, candidate)
    if not exact_source_hint_match and not gate.matches(observation.duration_seconds, measured):
        return None

    asset = PreparedAudioAsset(
        local_path=prepared_path,
        measured_duration_seconds=measured,
        audio_sha256=audio_sha256(prepared_path),
        provider=candidate.provider,
    )
    return ResolvedNowPlayingTrack(
        observation=observation,
        asset=asset,
        audio_identity=audio_identity_slug(observation, asset),
    )


def build_disk_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
    return scan_audio_candidates(
        [
            Path.home() / "Phrase2PhotonShows",
            Path("/Volumes/MUSIC"),
        ],
        observation,
    )


def scan_audio_candidates(roots: Iterable[Path], observation: TrackObservation) -> list[ProviderCandidate]:
    normalized_title = normalize_name(observation.title)
    normalized_artist = normalize_name(observation.artist)
    if not normalized_title:
        return []
    candidates: list[ProviderCandidate] = []
    seen_paths: set[Path] = set()

    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.casefold() not in LOCAL_AUDIO_SUFFIXES:
                continue
            if path.name.startswith("._"):
                continue
            if path in seen_paths:
                continue

            normalized_stem = normalize_name(path.stem)
            if normalized_title not in normalized_stem:
                continue

            confidence = 0.7
            if normalized_stem == normalized_title:
                confidence = 0.9
            parent_tokens = normalize_name(" ".join(path.parts[-3:]))
            if normalized_artist and normalized_artist in parent_tokens:
                confidence = 1.0

            candidates.append(
                ProviderCandidate(
                    provider="disk",
                    title=path.stem,
                    artist=observation.artist,
                    reported_duration_seconds=None,
                    local_path=path,
                    metadata_confidence=confidence,
                )
            )
            seen_paths.add(path)

    candidates.sort(key=lambda candidate: (-candidate.metadata_confidence, len(candidate.local_path.parts) if candidate.local_path else 9999))
    return candidates


def _matches_source_hint(
    observation: TrackObservation,
    candidate: ProviderCandidate,
) -> bool:
    hint_path = observation.source_hint_path
    candidate_path = candidate.local_path
    if hint_path is None or candidate_path is None or candidate.provider != "disk":
        return False
    return hint_path == candidate_path


def scdl_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
    query = _query_string(observation)
    result = _run_provider_command(
        [
            "uv",
            "run",
            "--with",
            "scdl",
            "scdl",
            "--query",
            query,
            "--path",
            "/tmp",
            "--dry-run",
        ]
    )
    return _parse_provider_candidates("scdl", result.stdout)


def spotdl_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
    query = _query_string(observation)
    result = _run_provider_command(
        [
            "uv",
            "run",
            "--with",
            "spotdl",
            "spotdl",
            "search",
            query,
            "--format",
            "json",
        ]
    )
    return _parse_provider_candidates("spotdl", result.stdout)


def _query_string(observation: TrackObservation) -> str:
    parts = [observation.title]
    if observation.artist:
        parts.append(observation.artist)
    return " ".join(part for part in parts if part)


def _run_provider_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
    )


def _parse_provider_candidates(provider: str, stdout: str) -> list[ProviderCandidate]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return []

    if isinstance(payload, dict):
        items = payload.get("tracks") or payload.get("results") or []
    elif isinstance(payload, list):
        items = payload
    else:
        items = []

    candidates: list[ProviderCandidate] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or item.get("name")
        if not isinstance(title, str) or not title.strip():
            continue

        artist = item.get("artist")
        uploader = item.get("uploader")
        if artist is not None and not isinstance(artist, str):
            continue
        if artist is None and uploader is not None and not isinstance(uploader, str):
            continue

        duration = item.get("duration_seconds")
        if duration is None:
            duration = item.get("duration")
        try:
            reported_duration = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            reported_duration = None
        if reported_duration is not None and reported_duration <= 0:
            continue

        try:
            candidates.append(
                ProviderCandidate(
                    provider=provider,
                    title=title,
                    artist=artist or uploader,
                    reported_duration_seconds=reported_duration,
                    local_path=None,
                    metadata_confidence=0.8,
                )
            )
        except ValidationError:
            continue
    return candidates
