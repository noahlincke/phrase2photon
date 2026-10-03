from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TempoMapSegment(BaseModel):
    # Segments are sorted by start_seconds and the first starts at 0. A later
    # segment's downbeat_seconds may predate its start_seconds: its grid
    # extends backwards, and the downbeat must land on a whole bar of the
    # continuing beat count.
    start_seconds: float = Field(ge=0.0)
    bpm: float = Field(gt=0.0)
    downbeat_seconds: float


class SongMeta(BaseModel):
    song_id: str
    title: str
    artist: str | None = None
    tempo: float
    time_signature: str
    tempo_map: list[TempoMapSegment] | None = None


class LocatorRef(BaseModel):
    locator_id: str
    name: str
    bar_beat: str
    seconds: float | None = None


class PhraseRange(BaseModel):
    start_bar_beat: str
    end_bar_beat: str
    start_locator_id: str | None = None
    end_locator_id: str | None = None


class TrackFeatures(BaseModel):
    track_id: str
    name: str
    role: str
    activity: float = Field(ge=0.0, le=1.0)
    density: float = Field(ge=0.0, le=1.0)


class EnergyFeatures(BaseModel):
    level: Literal["low", "mid", "high", "peak"]
    dynamics: float = Field(ge=0.0, le=1.0)
    tension: float = Field(ge=0.0, le=1.0)


class VisualLook(BaseModel):
    palette: str
    motion_style: str
    composition: str
    notes: list[str] = Field(default_factory=list)


class LightingLook(BaseModel):
    palette: str
    intensity: float = Field(ge=0.0, le=1.0)
    movement: str
    strobe: bool = False


class LightingCue(BaseModel):
    cue_id: str
    phrase_id: str
    fixture_group: str
    look: LightingLook
    priority: int = 0


class DmxLaserCue(BaseModel):
    cue_id: str
    phrase_id: str
    fixture_group: str
    mode: str
    parameter_overrides: dict[str, float | int | str] = Field(default_factory=dict)


class Transition(BaseModel):
    type: Literal["cut", "fade", "strobe-hit", "hold", "ramp"]
    duration_beats: float = Field(ge=0.0)
    notes: str | None = None


class ManualOverride(BaseModel):
    target_type: Literal["phrase", "lighting_cue", "laser_cue", "visual"]
    target_id: str
    payload: dict[str, str | int | float | bool] = Field(default_factory=dict)


class VisualPreset(BaseModel):
    preset_id: str
    name: str
    family: str
    mode_support: list[Literal["deterministic", "live-rotation"]]
    phrase_tags: list[str] = Field(default_factory=list)
    energy_tags: list[Literal["low", "mid", "high", "peak"]] = Field(default_factory=list)
    style_tags: list[str] = Field(default_factory=list)
    palette_key: str
    engine: str
    thumbnail_url: str | None = None
    clip_source: str | None = None
    notes: list[str] = Field(default_factory=list)


class PhraseVisualAssignment(BaseModel):
    phrase_id: str
    preset_id: str
    locked: bool = True
    palette_override: str | None = None
    parameter_overrides: dict[str, str | int | float | bool] = Field(default_factory=dict)


class Phrase(BaseModel):
    phrase_id: str
    name: str
    range: PhraseRange
    locators: list[LocatorRef] = Field(default_factory=list)
    track_features: list[TrackFeatures] = Field(default_factory=list)
    energy: EnergyFeatures
    visual_look: VisualLook
    transition_in: Transition | None = None
    transition_out: Transition | None = None


class ShowPackage(BaseModel):
    version: Literal["0.1.0"]
    song: SongMeta
    phrases: list[Phrase]
    preset_catalog: list[VisualPreset] = Field(default_factory=list)
    phrase_visual_assignments: list[PhraseVisualAssignment] = Field(default_factory=list)
    lighting_cues: list[LightingCue]
    dmx_laser_cues: list[DmxLaserCue]
    manual_overrides: list[ManualOverride] = Field(default_factory=list)


def make_example_show_package() -> ShowPackage:
    intro_locator = LocatorRef(locator_id="loc_intro", name="Intro", bar_beat="1|1")
    drop_locator = LocatorRef(locator_id="loc_drop_a", name="Drop A", bar_beat="17|1")

    intro_phrase = Phrase(
        phrase_id="phrase_intro",
        name="Intro",
        range=PhraseRange(
            start_bar_beat="1|1",
            end_bar_beat="17|1",
            start_locator_id=intro_locator.locator_id,
            end_locator_id=drop_locator.locator_id,
        ),
        locators=[intro_locator],
        track_features=[
            TrackFeatures(
                track_id="track_pad",
                name="Pads",
                role="texture",
                activity=0.4,
                density=0.2,
            ),
            TrackFeatures(
                track_id="track_vox",
                name="Lead Vox",
                role="lead",
                activity=0.7,
                density=0.5,
            ),
        ],
        energy=EnergyFeatures(level="mid", dynamics=0.4, tension=0.6),
        visual_look=VisualLook(
            palette="amber-cyan",
            motion_style="slow_parallax",
            composition="center-weighted",
            notes=["hold contrast low until the first drop"],
        ),
        transition_out=Transition(type="fade", duration_beats=4, notes="open into the drop"),
    )

    drop_phrase = Phrase(
        phrase_id="phrase_drop_a",
        name="Drop A",
        range=PhraseRange(
            start_bar_beat="17|1",
            end_bar_beat="33|1",
            start_locator_id=drop_locator.locator_id,
        ),
        locators=[drop_locator],
        track_features=[
            TrackFeatures(
                track_id="track_drums",
                name="Drums",
                role="rhythm",
                activity=1.0,
                density=0.9,
            ),
            TrackFeatures(
                track_id="track_bass",
                name="Bass",
                role="low-end",
                activity=0.95,
                density=0.8,
            ),
        ],
        energy=EnergyFeatures(level="peak", dynamics=0.85, tension=0.3),
        visual_look=VisualLook(
            palette="acid-white",
            motion_style="hard_cuts",
            composition="full-frame",
            notes=["favor beat-locked bursts over smooth interpolation"],
        ),
        transition_in=Transition(type="strobe-hit", duration_beats=1),
    )

    return ShowPackage(
        version="0.1.0",
        song=SongMeta(
            song_id="song_demo_001",
            title="Example Song",
            artist="Phrase2Photon",
            tempo=128.0,
            time_signature="4/4",
        ),
        phrases=[intro_phrase, drop_phrase],
        preset_catalog=[
            VisualPreset(
                preset_id="calm-prism-chamber",
                name="Calm Prism Chamber",
                family="texture-atmosphere",
                mode_support=["deterministic", "live-rotation"],
                phrase_tags=["intro", "groove"],
                energy_tags=["low", "mid"],
                style_tags=["texture", "calm"],
                palette_key="amber-cyan",
                engine="shader-plane",
                notes=["slow chamber drift with restrained refracted motion"],
            ),
            VisualPreset(
                preset_id="drop-lattice-strike",
                name="Drop Lattice Strike",
                family="cyber-psychedelic",
                mode_support=["deterministic", "live-rotation"],
                phrase_tags=["drop", "build"],
                energy_tags=["high", "peak"],
                style_tags=["cyber-psychedelic", "percussive"],
                palette_key="acid-white",
                engine="cyber-lattice",
                notes=["hard-edged rotating lattice for peak sections"],
            ),
        ],
        phrase_visual_assignments=[
            PhraseVisualAssignment(
                phrase_id="phrase_intro",
                preset_id="calm-prism-chamber",
                locked=True,
            ),
            PhraseVisualAssignment(
                phrase_id="phrase_drop_a",
                preset_id="drop-lattice-strike",
                locked=True,
            ),
        ],
        lighting_cues=[
            LightingCue(
                cue_id="lx_intro_wash",
                phrase_id="phrase_intro",
                fixture_group="wash_all",
                look=LightingLook(
                    palette="amber-cyan",
                    intensity=0.35,
                    movement="slow_sweep",
                ),
            ),
            LightingCue(
                cue_id="lx_drop_a_hit",
                phrase_id="phrase_drop_a",
                fixture_group="spots_front",
                look=LightingLook(
                    palette="white-acid",
                    intensity=0.95,
                    movement="beat_chase",
                    strobe=True,
                ),
                priority=10,
            ),
        ],
        dmx_laser_cues=[
            DmxLaserCue(
                cue_id="laser_drop_a",
                phrase_id="phrase_drop_a",
                fixture_group="laser_main",
                mode="fan_sweep",
                parameter_overrides={
                    "scan_speed": 180,
                    "pattern": "burst_fan",
                    "color_macro": "white_green",
                },
            )
        ],
        manual_overrides=[
            ManualOverride(
                target_type="phrase",
                target_id="phrase_drop_a",
                payload={"notes": "operator prefers slightly reduced laser speed in small rooms"},
            )
        ],
    )
