export type EnergyLevel = "low" | "mid" | "high" | "peak";
export type TransitionType = "cut" | "fade" | "strobe-hit" | "hold" | "ramp";
export type PresetModeSupport = "deterministic" | "live-rotation";

export interface SongMeta {
  song_id: string;
  title: string;
  artist: string | null;
  tempo: number;
  time_signature: string;
}

export interface LocatorRef {
  locator_id: string;
  name: string;
  bar_beat: string;
  seconds: number | null;
}

export interface PhraseRange {
  start_bar_beat: string;
  end_bar_beat: string;
  start_locator_id: string | null;
  end_locator_id: string | null;
}

export interface TrackFeatures {
  track_id: string;
  name: string;
  role: string;
  activity: number;
  density: number;
}

export interface EnergyFeatures {
  level: EnergyLevel;
  dynamics: number;
  tension: number;
}

export interface VisualLook {
  palette: string;
  motion_style: string;
  composition: string;
  notes: string[];
}

export interface LightingLook {
  palette: string;
  intensity: number;
  movement: string;
  strobe: boolean;
}

export interface LightingCue {
  cue_id: string;
  phrase_id: string;
  fixture_group: string;
  look: LightingLook;
  priority: number;
}

export interface DmxLaserCue {
  cue_id: string;
  phrase_id: string;
  fixture_group: string;
  mode: string;
  parameter_overrides: Record<string, number | string>;
}

export interface Transition {
  type: TransitionType;
  duration_beats: number;
  notes: string | null;
}

export interface ManualOverride {
  target_type: "phrase" | "lighting_cue" | "laser_cue" | "visual";
  target_id: string;
  payload: Record<string, string | number | boolean>;
}

export interface VisualPreset {
  preset_id: string;
  name: string;
  family: string;
  mode_support: PresetModeSupport[];
  phrase_tags: string[];
  energy_tags: EnergyLevel[];
  style_tags: string[];
  palette_key: string;
  engine: string;
  thumbnail_url: string | null;
  clip_source: string | null;
  notes: string[];
}

export interface PhraseVisualAssignment {
  phrase_id: string;
  preset_id: string;
  locked: boolean;
  palette_override: string | null;
  parameter_overrides: Record<string, string | number | boolean>;
}

export interface Phrase {
  phrase_id: string;
  name: string;
  range: PhraseRange;
  locators: LocatorRef[];
  track_features: TrackFeatures[];
  energy: EnergyFeatures;
  visual_look: VisualLook;
  transition_in: Transition | null;
  transition_out: Transition | null;
}

export interface ShowPackage {
  version: "0.1.0";
  song: SongMeta;
  phrases: Phrase[];
  preset_catalog: VisualPreset[];
  phrase_visual_assignments: PhraseVisualAssignment[];
  lighting_cues: LightingCue[];
  dmx_laser_cues: DmxLaserCue[];
  manual_overrides: ManualOverride[];
}
