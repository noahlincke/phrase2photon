from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ToolCatalogEntry(BaseModel):
    name: str
    title: str | None = None
    description: str | None = None
    input_schema: dict[str, Any] = Field(default_factory=dict)


class LocatorSnapshot(BaseModel):
    locator_id: str
    name: str
    time: str
    order_index: int


class ArrangementClipSnapshot(BaseModel):
    clip_id: str
    arrangement_start: str
    color: str | None = None
    name: str | None = None


class DeviceSnapshot(BaseModel):
    device_id: str
    path: str
    type: str
    name: str | None = None
    deactivated: bool = False


class SendSnapshot(BaseModel):
    return_name: str
    gain_db: float


class TrackSnapshot(BaseModel):
    track_id: str
    track_index: int
    name: str
    type: str
    color: str | None = None
    group_id: str | None = None
    group_name: str | None = None
    is_group: bool = False
    is_group_member: bool = False
    state: str | None = None
    instrument: str | None = None
    gain_db: float | None = None
    pan: float | None = None
    arrangement_clip_count: int = 0
    arrangement_clips: list[ArrangementClipSnapshot] = Field(default_factory=list)
    devices: list[DeviceSnapshot] = Field(default_factory=list)
    sends: list[SendSnapshot] = Field(default_factory=list)
    semantic_role: str
    tags: list[str] = Field(default_factory=list)
    has_producer_pal_device: bool = False


class EnergySnapshot(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    level: str
    rhythmic_drive: float = Field(ge=0.0, le=1.0)
    harmonic_density: float = Field(ge=0.0, le=1.0)
    melodic_presence: float = Field(ge=0.0, le=1.0)
    bass_presence: float = Field(ge=0.0, le=1.0)
    fx_presence: float = Field(ge=0.0, le=1.0)


class VisualIntentSnapshot(BaseModel):
    palette: str
    motion: str
    density: str
    contrast: str


class LightingIntentSnapshot(BaseModel):
    intensity: float = Field(ge=0.0, le=1.0)
    movement: str
    strobe_bias: bool = False
    laser_emphasis: bool = False


class PhraseSemanticsSnapshot(BaseModel):
    section_kind: str
    dominant_roles: list[str] = Field(default_factory=list)
    transition_in_hint: str
    transition_out_hint: str
    energy: EnergySnapshot
    visual_intent: VisualIntentSnapshot
    lighting_intent: LightingIntentSnapshot


class PhraseSnapshot(BaseModel):
    phrase_id: str
    name: str
    start_bar_beat: str
    end_bar_beat: str | None = None
    locator_id: str
    next_locator_id: str | None = None
    active_track_ids: list[str] = Field(default_factory=list)
    active_track_count: int = 0
    active_roles: list[str] = Field(default_factory=list)
    active_role_counts: dict[str, int] = Field(default_factory=dict)
    semantics: PhraseSemanticsSnapshot


class LiveSetExtraction(BaseModel):
    source_name: str
    tempo: float
    time_signature: str
    first_downbeat_seconds: float = 0.0
    scale: str | None = None
    scale_pitches: str | None = None
    producer_pal_version: str | None = None
    ableton_live_version: str | None = None
    tool_catalog: list[ToolCatalogEntry] = Field(default_factory=list)
    locators: list[LocatorSnapshot] = Field(default_factory=list)
    tracks: list[TrackSnapshot] = Field(default_factory=list)
    phrases: list[PhraseSnapshot] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
