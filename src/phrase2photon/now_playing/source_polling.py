from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from phrase2photon.now_playing.identity import normalize_name
from phrase2photon.now_playing.models import (
    OpenAudioCandidateDiagnostic,
    SourceDiagnostics,
    TrackObservation,
)

Runner = Callable[..., subprocess.CompletedProcess[str]]
OpenAudioStateFn = Callable[[], dict[Path, int]]

try:
    from pyrekordbox import Rekordbox6Database
except ImportError:  # pragma: no cover - exercised on non-macOS installs.
    Rekordbox6Database = None

REKORDBOX_AGENT_LOG_PATH = Path.home() / "Library" / "Application Support" / "Pioneer" / "rekordboxAgent" / "log.log"
REKORDBOX_CONTENT_EVENT_PATTERN = re.compile(r"/api/v1/data/djmdContents/(\d+)/file")
REKORDBOX_TIMESTAMP_PATTERN = re.compile(r"\[(\d{6}T\d{6}\.\d{3}[+-]\d{4})\]")
REKORDBOX_EVENT_LOOKBACK = 24
REKORDBOX_EVENT_FRESHNESS_SECONDS = 15 * 60
_REKORDBOX_LAST_AUDIO_OFFSETS: dict[Path, int] = {}
_REKORDBOX_LAST_MEMORY_SAMPLES: dict[int, int] = {}
_LAST_REKORDBOX_DIAGNOSTICS: SourceDiagnostics | None = None
REKORDBOX_FULLY_BUFFERED_RATIO = 0.98
REKORDBOX_CONTENT_EVENT_BASELINE_MAX_AGE_SECONDS = 30 * 60
REKORDBOX_MEMORY_APP_PATH = Path.home() / "Applications" / "rekordbox 7.2.8" / "rekordbox.app" / "Contents" / "MacOS" / "rekordbox"
REKORDBOX_MEMORY_PROBE_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "run_rekordbox_memory_probe.sh"


@dataclass(frozen=True)
class RekordboxContentEvent:
    content_id: str
    observed_at: datetime


@dataclass(frozen=True)
class RekordboxTrackRecord:
    content_id: str | None
    title: str
    artist: str | None
    duration_seconds: float
    folder_path: str | None

    @property
    def local_path(self) -> Path | None:
        if not self.folder_path:
            return None
        path = Path(self.folder_path)
        return path if path.is_absolute() else None


@dataclass(frozen=True)
class RekordboxOpenAudioCandidate:
    path: Path
    record: RekordboxTrackRecord | None
    current_offset: int
    previous_offset: int | None
    offset_delta: int
    file_size: int | None
    buffer_ratio: float | None
    recent_event_at: datetime | None

    @property
    def is_fully_buffered(self) -> bool:
        return self.buffer_ratio is not None and self.buffer_ratio >= REKORDBOX_FULLY_BUFFERED_RATIO


@dataclass(frozen=True)
class RekordboxMemoryDeckState:
    deck: int
    title: str | None
    artist: str | None
    album: str | None
    bpm: float | None
    sample_position: int | None
    anlz_path: str | None


def now_playing_cache_root() -> Path:
    return Path.home() / "Phrase2PhotonShows" / "now-playing" / "tracks"


def poll_osascript_app(
    *,
    source_app: str,
    app_name: str,
    script_body: str,
    runner: Runner = subprocess.run,
    observed_at: datetime | None = None,
) -> TrackObservation | None:
    script = _wrapped_osascript(app_name=app_name, script_body=script_body)
    try:
        result = runner(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    raw = result.stdout.strip()
    if not raw:
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None

    try:
        title = str(payload["title"]).strip()
        duration_seconds = float(payload["duration_seconds"])
    except (KeyError, TypeError, ValueError):
        return None
    if not title:
        return None

    artist_value = payload.get("artist")
    artist = None if artist_value is None else str(artist_value).strip()
    if artist in {"", "missing value"}:
        artist = None
    playback_position_value = payload.get("playback_position_seconds")
    try:
        playback_position_seconds = None if playback_position_value is None else float(playback_position_value)
    except (TypeError, ValueError):
        playback_position_seconds = None
    if playback_position_seconds is not None and playback_position_seconds < 0:
        playback_position_seconds = None

    is_playing_value = payload.get("is_playing")
    is_playing = is_playing_value if isinstance(is_playing_value, bool) else None

    return TrackObservation(
        source_app=source_app,
        title=title,
        artist=artist,
        duration_seconds=duration_seconds,
        observed_at=observed_at or datetime.now(timezone.utc),
        playback_position_seconds=playback_position_seconds,
        position_source=None if playback_position_seconds is None else "exact",
        is_playing=is_playing,
    )


def poll_rekordbox() -> TrackObservation | None:
    return poll_rekordbox_log_and_db()


def poll_virtualdj() -> TrackObservation | None:
    return poll_osascript_app(
        source_app="VirtualDJ",
        app_name="VirtualDJ",
        script_body='return my json_track_payload(get song name, get song author, get song length, 0, true)',
    )


def poll_system_now_playing() -> TrackObservation | None:
    return poll_osascript_app(
        source_app="Music",
        app_name="Music",
        script_body="""
set currentState to player state as text
if currentState is "stopped" then
  return ""
end if
set currentTrack to current track
return my json_track_payload(name of currentTrack, artist of currentTrack, duration of currentTrack, player position, currentState is "playing")
""".strip(),
    )


def _wrapped_osascript(*, app_name: str, script_body: str) -> str:
    return f"""
on json_escape(value)
  set escapedValue to value
  set escapedValue to my replace_text("\\\\", "\\\\\\\\", escapedValue)
  set escapedValue to my replace_text("\\"", "\\\\\\"", escapedValue)
  set escapedValue to my replace_text(return, "\\\\n", escapedValue)
  set escapedValue to my replace_text(linefeed, "\\\\n", escapedValue)
  return escapedValue
end json_escape

on json_string(value)
  if value is missing value then
    return "null"
  end if
  return "\\"" & my json_escape(value as text) & "\\""
end json_string

on json_boolean(value)
  if value then
    return "true"
  end if
  return "false"
end json_boolean

on json_track_payload(trackTitle, trackArtist, trackDuration, playbackPosition, isPlaying)
  return "{{\\"title\\":" & my json_string(trackTitle) & ",\\"artist\\":" & my json_string(trackArtist) & ",\\"duration_seconds\\":" & (trackDuration as real) & ",\\"playback_position_seconds\\":" & (playbackPosition as real) & ",\\"is_playing\\":" & my json_boolean(isPlaying) & "}}"
end json_track_payload

on replace_text(searchString, replacementString, sourceText)
  set AppleScript's text item delimiters to searchString
  set textItems to every text item of sourceText
  set AppleScript's text item delimiters to replacementString
  set replacedText to textItems as text
  set AppleScript's text item delimiters to ""
  return replacedText
end replace_text

tell application "{app_name}"
  {script_body}
end tell
""".strip()


def poll_rekordbox_log_and_db(
    *,
    log_path: Path | None = None,
    open_audio_state_fn: OpenAudioStateFn | None = None,
    db_loader: Callable[[], Any | None] | None = None,
) -> TrackObservation | None:
    effective_log_path = log_path or REKORDBOX_AGENT_LOG_PATH
    open_audio_state = (open_audio_state_fn or _rekordbox_open_audio_state)()
    memory_states = _poll_rekordbox_memory_states()
    open_audio_paths = set(open_audio_state)
    previous_offsets = dict(_REKORDBOX_LAST_AUDIO_OFFSETS)
    offset_deltas = _offset_deltas({path: open_audio_state.get(path, 0) for path in open_audio_paths})
    recent_events = _recent_rekordbox_content_events(effective_log_path)
    now_utc = datetime.now(timezone.utc)
    fallback_observation: TrackObservation | None = None
    loader = db_loader or _load_rekordbox_database
    database = loader() if Rekordbox6Database is not None else None

    ranked_candidates = _ranked_open_audio_candidates(
        database,
        open_audio_paths=open_audio_paths,
        open_audio_state=open_audio_state,
        previous_offsets=previous_offsets,
        offset_deltas=offset_deltas,
        recent_events=recent_events,
    )

    if database is None:
        selected_candidate = ranked_candidates[0] if ranked_candidates else None
        _set_last_rekordbox_diagnostics(
            _build_rekordbox_diagnostics(
                database_loaded=False,
                recent_events=recent_events,
                ranked_candidates=ranked_candidates,
                selected_candidate=selected_candidate,
                selected_via="open_audio_fallback" if selected_candidate is not None else None,
            )
        )
        if selected_candidate is None:
            return None
        return _observation_from_open_audio_candidate(
            selected_candidate,
            observed_at=now_utc,
        )

    for event in recent_events:
        record = _rekordbox_track_record_for_content_id(database, event.content_id)
        if record is None:
            continue
        observation = _observation_from_rekordbox_record(record, observed_at=event.observed_at)
        if record.local_path is not None:
            observation = _observation_from_rekordbox_record(
                record,
                observed_at=event.observed_at,
                open_audio_state=open_audio_state,
                previous_offsets=previous_offsets,
            )
            if (
                record.local_path in open_audio_paths
                and observation.playback_position_seconds is None
                and record.local_path not in previous_offsets
            ):
                observation = observation.model_copy(
                    update={
                        "playback_position_seconds": 0.0,
                        "position_source": "estimated",
                        "is_playing": True,
                    }
                )
        if fallback_observation is None:
            fallback_observation = observation
        event_is_fresh = _event_is_fresh(event.observed_at, now_utc=now_utc)
        if event_is_fresh and record.local_path is not None and record.local_path in open_audio_paths:
            selected_candidate = _candidate_for_path(ranked_candidates, record.local_path)
            _set_last_rekordbox_diagnostics(
                _build_rekordbox_diagnostics(
                    database_loaded=True,
                    recent_events=recent_events,
                    ranked_candidates=ranked_candidates,
                    selected_candidate=selected_candidate,
                    selected_via="fresh_content_event_open_path",
                )
            )
            return _apply_rekordbox_memory_clock(observation, memory_states=memory_states)
        if event_is_fresh and record.local_path is not None:
            continue
        if event_is_fresh and open_audio_paths:
            continue
        if event_is_fresh:
            _set_last_rekordbox_diagnostics(
                _build_rekordbox_diagnostics(
                    database_loaded=True,
                    recent_events=recent_events,
                    ranked_candidates=ranked_candidates,
                    selected_candidate=None,
                    selected_via="fresh_content_event",
                )
            )
            return _apply_rekordbox_memory_clock(observation, memory_states=memory_states)

    fallback_candidate = ranked_candidates[0] if ranked_candidates else None
    if fallback_candidate is not None and fallback_candidate.record is not None:
        fallback_record = fallback_candidate.record
        observation = _observation_from_rekordbox_record(
            fallback_record,
            open_audio_state=open_audio_state,
            previous_offsets=previous_offsets,
        )
        observation = _apply_rekordbox_open_file_baseline(
            observation,
            record=fallback_record,
            previous_offsets=previous_offsets,
            log_path=effective_log_path,
            now_utc=now_utc,
        )
        _set_last_rekordbox_diagnostics(
            _build_rekordbox_diagnostics(
                database_loaded=True,
                recent_events=recent_events,
                ranked_candidates=ranked_candidates,
                selected_candidate=fallback_candidate,
                selected_via="open_audio_db_match",
            )
        )
        return _apply_rekordbox_memory_clock(observation, memory_states=memory_states)

    if fallback_candidate is not None:
        _set_last_rekordbox_diagnostics(
            _build_rekordbox_diagnostics(
                database_loaded=True,
                recent_events=recent_events,
                ranked_candidates=ranked_candidates,
                selected_candidate=fallback_candidate,
                selected_via="open_audio_filename_fallback",
            )
        )
        return _apply_rekordbox_memory_clock(_observation_from_open_audio_candidate(
            fallback_candidate,
            observed_at=now_utc,
        ), memory_states=memory_states)

    _set_last_rekordbox_diagnostics(
        _build_rekordbox_diagnostics(
            database_loaded=True,
            recent_events=recent_events,
            ranked_candidates=ranked_candidates,
            selected_candidate=None,
            selected_via="stale_log_fallback" if fallback_observation is not None and open_audio_paths else None,
        )
    )
    if fallback_observation is not None and open_audio_paths:
        return _apply_rekordbox_memory_clock(fallback_observation, memory_states=memory_states)
    return None


def _event_is_fresh(observed_at: datetime, *, now_utc: datetime) -> bool:
    observed_utc = observed_at.astimezone(timezone.utc)
    return (now_utc - observed_utc).total_seconds() <= REKORDBOX_EVENT_FRESHNESS_SECONDS


@lru_cache(maxsize=1)
def _load_rekordbox_database() -> Any | None:
    if Rekordbox6Database is None:
        return None
    try:
        return Rekordbox6Database()
    except Exception:
        return None


def _recent_rekordbox_content_events(log_path: Path, *, max_events: int = REKORDBOX_EVENT_LOOKBACK) -> list[RekordboxContentEvent]:
    try:
        lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []

    events: list[RekordboxContentEvent] = []
    seen_content_ids: set[str] = set()
    for line in reversed(lines):
        content_match = REKORDBOX_CONTENT_EVENT_PATTERN.search(line)
        if content_match is None:
            continue
        content_id = content_match.group(1)
        if content_id in seen_content_ids:
            continue
        observed_at = _parse_rekordbox_log_timestamp(line)
        if observed_at is None:
            continue
        events.append(RekordboxContentEvent(content_id=content_id, observed_at=observed_at))
        seen_content_ids.add(content_id)
        if len(events) >= max_events:
            break
    return events


def _latest_rekordbox_content_event(log_path: Path, content_id: str | None) -> RekordboxContentEvent | None:
    if not content_id:
        return None
    pattern = f"/api/v1/data/djmdContents/{content_id}/file"
    try:
        lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None

    for line in reversed(lines):
        if pattern not in line:
            continue
        observed_at = _parse_rekordbox_log_timestamp(line)
        if observed_at is None:
            continue
        return RekordboxContentEvent(content_id=content_id, observed_at=observed_at)
    return None


def _parse_rekordbox_log_timestamp(line: str) -> datetime | None:
    timestamp_match = REKORDBOX_TIMESTAMP_PATTERN.search(line)
    if timestamp_match is None:
        return None
    try:
        return datetime.strptime(timestamp_match.group(1), "%y%m%dT%H%M%S.%f%z")
    except ValueError:
        return None


def _rekordbox_open_audio_state(*, runner: Runner = subprocess.run) -> dict[Path, int]:
    try:
        pid_result = runner(
            ["pgrep", "-x", "rekordbox"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return {}

    process_ids = [pid.strip() for pid in pid_result.stdout.splitlines() if pid.strip()]
    if not process_ids:
        return {}

    try:
        lsof_result = runner(
            ["lsof", "-p", process_ids[0], "-o", "-Fno"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return {}

    open_state: dict[Path, int] = {}
    pending_offset = 0
    for line in lsof_result.stdout.splitlines():
        if line.startswith("o"):
            pending_offset = _parse_lsof_offset(line[1:])
            continue
        if not line.startswith("n"):
            continue
        raw_path = line[1:].strip()
        if not raw_path:
            continue
        path = Path(raw_path)
        if not path.is_absolute():
            continue
        if path.suffix.casefold() not in {".aac", ".aif", ".aiff", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".wav"}:
            continue
        open_state[path] = pending_offset
        pending_offset = 0
    return open_state


def _poll_rekordbox_memory_states(*, runner: Runner = subprocess.run) -> list[RekordboxMemoryDeckState]:
    pid = _rekordbox_memory_probe_pid(runner=runner)
    if pid is None or not REKORDBOX_MEMORY_PROBE_SCRIPT.exists():
        return []
    try:
        result = runner(
            ["bash", str(REKORDBOX_MEMORY_PROBE_SCRIPT), str(pid)],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return []
    return _parse_rekordbox_memory_probe_output(result.stdout)


def _rekordbox_memory_probe_pid(*, runner: Runner = subprocess.run) -> int | None:
    try:
        pid_result = runner(
            ["pgrep", "-f", str(REKORDBOX_MEMORY_APP_PATH)],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    pids = [pid.strip() for pid in pid_result.stdout.splitlines() if pid.strip()]
    if not pids:
        return None
    try:
        ps_result = runner(
            ["ps", "-p", ",".join(pids), "-o", "pid=,args="],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    target = str(REKORDBOX_MEMORY_APP_PATH)
    for line in ps_result.stdout.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) != 2:
            continue
        args = parts[1].strip()
        if args != target and not args.startswith(f"{target} "):
            continue
        try:
            return int(parts[0])
        except ValueError:
            continue
    return None


def _parse_rekordbox_memory_probe_output(stdout: str) -> list[RekordboxMemoryDeckState]:
    states: list[RekordboxMemoryDeckState] = []
    current: dict[str, object] | None = None
    for raw_line in stdout.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        if line.startswith("deck_") and line.endswith(":"):
            if current is not None:
                states.append(_build_rekordbox_memory_deck_state(current))
            deck_label = line.split("_", 1)[1].split(":", 1)[0]
            try:
                deck = int(deck_label)
            except ValueError:
                current = None
                continue
            current = {"deck": deck}
            continue
        if current is None or not line.startswith("  ") or "=" not in line:
            continue
        key, value = line.strip().split("=", 1)
        current[key] = value
    if current is not None:
        states.append(_build_rekordbox_memory_deck_state(current))
    return states


def _build_rekordbox_memory_deck_state(payload: dict[str, object]) -> RekordboxMemoryDeckState:
    bpm_value = payload.get("bpm")
    sample_position_value = payload.get("sample_position")
    return RekordboxMemoryDeckState(
        deck=int(payload["deck"]),
        title=_none_if_blank(str(payload.get("title", "")).strip()),
        artist=_none_if_blank(str(payload.get("artist", "")).strip()),
        album=_none_if_blank(str(payload.get("album", "")).strip()),
        bpm=None if bpm_value in {None, "", "unreadable"} else float(str(bpm_value)),
        sample_position=None
        if sample_position_value in {None, "", "unreadable"}
        else int(str(sample_position_value)),
        anlz_path=_none_if_blank(str(payload.get("anlz_path", "")).strip()),
    )


def _none_if_blank(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _parse_lsof_offset(raw_offset: str) -> int:
    cleaned = raw_offset.strip()
    if cleaned.startswith("0t"):
        cleaned = cleaned[2:]
    try:
        return int(cleaned)
    except ValueError:
        return 0


def _rekordbox_track_record_for_content_id(database: Any, content_id: str) -> RekordboxTrackRecord | None:
    try:
        content = database.get_content(ID=str(content_id))
    except Exception:
        return None
    return _rekordbox_track_record_from_content(content)


def _rekordbox_track_record_for_path(database: Any, path: Path) -> RekordboxTrackRecord | None:
    try:
        content_or_query = database.get_content(FolderPath=str(path))
    except Exception:
        return None

    if hasattr(content_or_query, "first"):
        content = content_or_query.first()
    else:
        content = content_or_query
    if content is None:
        return None
    return _rekordbox_track_record_from_content(content)


def _rekordbox_track_record_from_content(content: Any) -> RekordboxTrackRecord | None:
    try:
        content_id = str(content.ID)
        title = str(content.Title).strip()
        duration_seconds = float(content.Length)
    except (AttributeError, TypeError, ValueError):
        return None
    if not title:
        return None

    artist_value = getattr(content, "ArtistName", None)
    if not artist_value:
        try:
            artist_relation = getattr(content, "Artist", None)
            artist_value = getattr(artist_relation, "Name", None)
        except Exception:
            artist_value = None
    artist = None if artist_value in {None, "", "missing value"} else str(artist_value).strip()
    folder_path = getattr(content, "FolderPath", None)
    return RekordboxTrackRecord(
        content_id=content_id,
        title=title,
        artist=artist,
        duration_seconds=duration_seconds,
        folder_path=None if folder_path in {None, ""} else str(folder_path),
    )


def last_rekordbox_diagnostics() -> dict[str, object] | None:
    if _LAST_REKORDBOX_DIAGNOSTICS is None:
        return None
    return _LAST_REKORDBOX_DIAGNOSTICS.model_dump(mode="json")


def _set_last_rekordbox_diagnostics(diagnostics: SourceDiagnostics) -> None:
    global _LAST_REKORDBOX_DIAGNOSTICS
    _LAST_REKORDBOX_DIAGNOSTICS = diagnostics


def _ranked_open_audio_candidates(
    database: Any | None,
    *,
    open_audio_paths: set[Path],
    open_audio_state: dict[Path, int],
    previous_offsets: dict[Path, int],
    offset_deltas: dict[Path, int],
    recent_events: list[RekordboxContentEvent],
) -> list[RekordboxOpenAudioCandidate]:
    recent_event_map = {event.content_id: event.observed_at for event in recent_events}
    candidates: list[RekordboxOpenAudioCandidate] = []
    for path in open_audio_paths:
        record = _rekordbox_track_record_for_path(database, path) if database is not None else None
        try:
            file_size = path.stat().st_size
        except OSError:
            file_size = None
        current_offset = open_audio_state.get(path, 0)
        buffer_ratio = None
        if file_size is not None and file_size > 0:
            buffer_ratio = max(0.0, min(float(current_offset) / float(file_size), 1.0))
        recent_event_at = recent_event_map.get(record.content_id or "") if record is not None else None
        candidates.append(
            RekordboxOpenAudioCandidate(
                path=path,
                record=record,
                current_offset=current_offset,
                previous_offset=previous_offsets.get(path),
                offset_delta=offset_deltas.get(path, 0),
                file_size=file_size,
                buffer_ratio=buffer_ratio,
                recent_event_at=recent_event_at,
            )
        )

    candidates.sort(key=_candidate_rank, reverse=True)
    return candidates


def _candidate_rank(candidate: RekordboxOpenAudioCandidate) -> tuple[int, int, int, int, str]:
    event_rank = int(candidate.recent_event_at.timestamp()) if candidate.recent_event_at is not None else -1
    matched_record = 1 if candidate.record is not None else 0
    title = candidate.record.title if candidate.record is not None else candidate.path.name
    return (
        candidate.offset_delta,
        candidate.current_offset,
        event_rank,
        matched_record,
        title,
    )


def _candidate_for_path(
    candidates: list[RekordboxOpenAudioCandidate],
    path: Path,
) -> RekordboxOpenAudioCandidate | None:
    for candidate in candidates:
        if candidate.path == path:
            return candidate
    return None


def _build_rekordbox_diagnostics(
    *,
    database_loaded: bool,
    recent_events: list[RekordboxContentEvent],
    ranked_candidates: list[RekordboxOpenAudioCandidate],
    selected_candidate: RekordboxOpenAudioCandidate | None,
    selected_via: str | None,
) -> SourceDiagnostics:
    diagnostics_candidates = [
        OpenAudioCandidateDiagnostic(
            path=candidate.path,
            title=candidate.record.title if candidate.record is not None else _fallback_title_artist_from_path(candidate.path)[0],
            artist=candidate.record.artist if candidate.record is not None else _fallback_title_artist_from_path(candidate.path)[1],
            content_id=candidate.record.content_id if candidate.record is not None else None,
            current_offset=candidate.current_offset,
            previous_offset=candidate.previous_offset,
            offset_delta=candidate.offset_delta,
            file_size=candidate.file_size,
            buffer_ratio=candidate.buffer_ratio,
            is_fully_buffered=candidate.is_fully_buffered,
            recent_event_at=candidate.recent_event_at,
            selected=selected_candidate is not None and candidate.path == selected_candidate.path,
            matched_record=candidate.record is not None,
        )
        for candidate in ranked_candidates
    ]
    return SourceDiagnostics(
        source_app="Rekordbox",
        database_loaded=database_loaded,
        selected_path=selected_candidate.path if selected_candidate is not None else None,
        selected_content_id=selected_candidate.record.content_id if selected_candidate and selected_candidate.record else None,
        selected_via=selected_via,
        open_audio_candidates=diagnostics_candidates,
        recent_event_content_ids=[event.content_id for event in recent_events],
    )


def _offset_deltas(current_offsets: dict[Path, int]) -> dict[Path, int]:
    global _REKORDBOX_LAST_AUDIO_OFFSETS

    deltas = {
        path: current_offset - _REKORDBOX_LAST_AUDIO_OFFSETS.get(path, current_offset)
        for path, current_offset in current_offsets.items()
    }
    _REKORDBOX_LAST_AUDIO_OFFSETS = dict(current_offsets)
    return deltas


def _observation_from_open_audio_candidate(
    candidate: RekordboxOpenAudioCandidate,
    *,
    observed_at: datetime,
) -> TrackObservation:
    if candidate.record is not None:
        title = candidate.record.title
        artist = candidate.record.artist
    else:
        title, artist = _fallback_title_artist_from_path(candidate.path)
    duration_seconds = (
        candidate.record.duration_seconds
        if candidate.record is not None
        else _measured_local_audio_duration_seconds(candidate.path) or 1.0
    )
    playback_position_seconds = None
    if candidate.buffer_ratio is not None and not candidate.is_fully_buffered:
        playback_position_seconds = candidate.buffer_ratio * duration_seconds
    return TrackObservation(
        source_app="Rekordbox",
        title=title,
        artist=artist,
        duration_seconds=duration_seconds,
        observed_at=observed_at,
        source_hint_path=candidate.path,
        playback_position_seconds=playback_position_seconds,
        position_source=None if playback_position_seconds is None else "estimated",
        is_playing=playback_position_seconds is not None or candidate.offset_delta > 0,
    )


def _observation_from_rekordbox_record(
    record: RekordboxTrackRecord,
    *,
    observed_at: datetime | None = None,
    open_audio_state: dict[Path, int] | None = None,
    previous_offsets: dict[Path, int] | None = None,
) -> TrackObservation:
    playback_position_seconds = _estimate_rekordbox_playback_position_seconds(
        record.local_path,
        duration_seconds=record.duration_seconds,
        open_audio_state=open_audio_state or {},
        previous_offsets=previous_offsets or {},
    )
    return TrackObservation(
        source_app="Rekordbox",
        title=record.title,
        artist=record.artist,
        duration_seconds=record.duration_seconds,
        observed_at=observed_at or datetime.now(timezone.utc),
        source_hint_path=record.local_path,
        playback_position_seconds=playback_position_seconds,
        position_source=None if playback_position_seconds is None else "estimated",
        is_playing=playback_position_seconds is not None,
    )


def _apply_rekordbox_memory_clock(
    observation: TrackObservation,
    *,
    memory_states: list[RekordboxMemoryDeckState],
) -> TrackObservation:
    matching_state = _matching_rekordbox_memory_state(observation, memory_states=memory_states)
    if matching_state is None or matching_state.sample_position is None:
        return observation

    global _REKORDBOX_LAST_MEMORY_SAMPLES
    previous_sample_position = _REKORDBOX_LAST_MEMORY_SAMPLES.get(matching_state.deck)
    _REKORDBOX_LAST_MEMORY_SAMPLES[matching_state.deck] = matching_state.sample_position

    playback_position_seconds = max(0.0, matching_state.sample_position / 44100.0)
    if previous_sample_position is None:
        is_playing = playback_position_seconds > 0
    else:
        is_playing = matching_state.sample_position != previous_sample_position

    return observation.model_copy(
        update={
            "title": matching_state.title or observation.title,
            "artist": matching_state.artist if matching_state.artist is not None else observation.artist,
            "album": matching_state.album if matching_state.album is not None else observation.album,
            "playback_position_seconds": min(observation.duration_seconds, playback_position_seconds),
            "position_source": "exact",
            "is_playing": is_playing,
            "observed_at": datetime.now(timezone.utc),
        }
    )


def _matching_rekordbox_memory_state(
    observation: TrackObservation,
    *,
    memory_states: list[RekordboxMemoryDeckState],
) -> RekordboxMemoryDeckState | None:
    observation_title = normalize_name(observation.title)
    observation_artist = normalize_name(observation.artist)
    for state in memory_states:
        if normalize_name(state.title) != observation_title:
            continue
        state_artist = normalize_name(state.artist)
        if observation_artist and state_artist and state_artist != observation_artist:
            continue
        return state
    return None


def _apply_rekordbox_open_file_baseline(
    observation: TrackObservation,
    *,
    record: RekordboxTrackRecord,
    previous_offsets: dict[Path, int],
    log_path: Path,
    now_utc: datetime,
) -> TrackObservation:
    if record.local_path is None or observation.playback_position_seconds is not None:
        return observation

    latest_event = _latest_rekordbox_content_event(log_path, record.content_id)
    if latest_event is not None:
        event_age_seconds = max(0.0, (now_utc - latest_event.observed_at.astimezone(timezone.utc)).total_seconds())
        max_age_seconds = max(
            REKORDBOX_EVENT_FRESHNESS_SECONDS,
            REKORDBOX_CONTENT_EVENT_BASELINE_MAX_AGE_SECONDS,
            record.duration_seconds * 2,
        )
        if event_age_seconds <= max_age_seconds:
            return observation.model_copy(
                update={
                    "observed_at": latest_event.observed_at,
                    "playback_position_seconds": 0.0,
                    "position_source": "estimated",
                    "is_playing": True,
                }
            )

    if record.local_path not in previous_offsets:
        return observation.model_copy(
            update={
                "playback_position_seconds": 0.0,
                "position_source": "estimated",
                "is_playing": True,
            }
        )
    return observation


def _estimate_rekordbox_playback_position_seconds(
    local_path: Path | None,
    *,
    duration_seconds: float,
    open_audio_state: dict[Path, int],
    previous_offsets: dict[Path, int],
) -> float | None:
    if local_path is None:
        return None
    try:
        offset = open_audio_state[local_path]
        size = local_path.stat().st_size
    except (KeyError, OSError):
        return None
    if size <= 0:
        return None
    previous_offset = previous_offsets.get(local_path)
    if previous_offset is not None and offset <= previous_offset:
        return None
    ratio = max(0.0, min(float(offset) / float(size), 1.0))
    if ratio >= REKORDBOX_FULLY_BUFFERED_RATIO:
        return None
    return ratio * duration_seconds


def _fallback_title_artist_from_path(path: Path) -> tuple[str, str | None]:
    normalized = path.stem.replace("_-_", " - ").replace("_", " ").strip()
    if " - " not in normalized:
        return normalized or path.stem, None
    artist, title = normalized.split(" - ", 1)
    artist = artist.strip() or None
    title = title.strip() or path.stem
    return title, artist


@lru_cache(maxsize=512)
def _measured_local_audio_duration_seconds(path: Path) -> float | None:
    try:
        from phrase2photon.now_playing.providers import measured_duration_seconds
    except Exception:
        return None

    try:
        return measured_duration_seconds(path)
    except Exception:
        return None
