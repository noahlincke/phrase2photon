from __future__ import annotations

from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field


class TrackObservation(BaseModel):
    source_app: str
    title: str
    artist: str | None = None
    album: str | None = None
    duration_seconds: float = Field(gt=0)
    observed_at: datetime
    source_hint_path: Path | None = None
    playback_position_seconds: float | None = Field(default=None, ge=0)
    is_playing: bool | None = None


class OpenAudioCandidateDiagnostic(BaseModel):
    path: Path
    title: str | None = None
    artist: str | None = None
    content_id: str | None = None
    current_offset: int = Field(ge=0)
    previous_offset: int | None = Field(default=None, ge=0)
    offset_delta: int | None = None
    file_size: int | None = Field(default=None, gt=0)
    buffer_ratio: float | None = Field(default=None, ge=0, le=1)
    is_fully_buffered: bool = False
    recent_event_at: datetime | None = None
    selected: bool = False
    matched_record: bool = False


class SourceDiagnostics(BaseModel):
    source_app: str
    database_loaded: bool
    selected_path: Path | None = None
    selected_content_id: str | None = None
    selected_via: str | None = None
    open_audio_candidates: list[OpenAudioCandidateDiagnostic] = Field(default_factory=list)
    recent_event_content_ids: list[str] = Field(default_factory=list)


class PreparedAudioAsset(BaseModel):
    local_path: Path
    measured_duration_seconds: float = Field(gt=0)
    audio_sha256: str
    provider: str


class ProviderCandidate(BaseModel):
    provider: str
    title: str
    artist: str | None = None
    reported_duration_seconds: float | None = Field(default=None, gt=0)
    local_path: Path | None = None
    metadata_confidence: float = Field(ge=0, le=1)


class ProviderAttempt(BaseModel):
    provider: str
    status: str
    message: str


class ResolvedNowPlayingTrack(BaseModel):
    observation: TrackObservation
    asset: PreparedAudioAsset
    audio_identity: str
    show_dir: Path | None = None
