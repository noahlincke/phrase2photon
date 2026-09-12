import type { PhraseKind } from "../audio/structure.js";
import { ensureShowPresetCatalog, buildDefaultPhraseVisualAssignments } from "../graphics/visualPresets.js";
import type { EnergyLevel, Phrase, ShowPackage } from "../show/types.js";

/**
 * A minimal show package describing live microphone input.
 *
 * The output lanes - lighting cues, FB4 laser cues, palette selection - are all
 * written against a `ShowPackage`, so live input needs one too. Rather than
 * bypass that contract for the microphone path, this exposes the detector's
 * phrase kinds as a small standing show, which keeps the laser lane driven by
 * exactly the same code whether the source is a compiled track or a room.
 */

const LIVE_PHRASES: Array<{
  kind: PhraseKind;
  name: string;
  level: EnergyLevel;
  dynamics: number;
  tension: number;
  palette: string;
  motion: string;
  composition: string;
}> = [
  { kind: "intro", name: "Intro", level: "low", dynamics: 0.22, tension: 0.16, palette: "smoke-cool", motion: "slow_drift", composition: "sparse" },
  { kind: "breakdown", name: "Breakdown", level: "low", dynamics: 0.3, tension: 0.42, palette: "nocturne-glow", motion: "slow_drift", composition: "sparse" },
  { kind: "groove", name: "Groove", level: "mid", dynamics: 0.54, tension: 0.3, palette: "nocturne-glow", motion: "steady_orbit", composition: "open" },
  { kind: "build", name: "Build", level: "high", dynamics: 0.72, tension: 0.78, palette: "warm-cinematic", motion: "ramp_sweep", composition: "medium" },
  { kind: "drop", name: "Drop", level: "peak", dynamics: 0.95, tension: 0.6, palette: "acid-contrast", motion: "beat_locked_cuts", composition: "dense" },
  { kind: "outro", name: "Outro", level: "low", dynamics: 0.26, tension: 0.2, palette: "desaturated_decay", motion: "slow_drift", composition: "sparse" }
];

function phraseFor(entry: (typeof LIVE_PHRASES)[number], index: number): Phrase {
  const startBar = 1 + index * 8;
  return {
    phrase_id: `live_${entry.kind}`,
    name: entry.name,
    range: {
      start_bar_beat: `${startBar}|1`,
      end_bar_beat: `${startBar + 8}|1`,
      start_locator_id: null,
      end_locator_id: null
    },
    locators: [],
    track_features: [],
    energy: { level: entry.level, dynamics: entry.dynamics, tension: entry.tension },
    visual_look: {
      palette: entry.palette,
      motion_style: entry.motion,
      composition: entry.composition,
      notes: ["Detected from live audio input."]
    },
    transition_in: { type: "cut", duration_beats: 1, notes: "live phrase change" },
    transition_out: null
  };
}

/** Builds the standing live show. Cheap enough to call once at startup. */
export function buildLiveShow(): ShowPackage {
  const phrases = LIVE_PHRASES.map(phraseFor);
  const base: ShowPackage = {
    version: "0.1.0",
    song: {
      song_id: "live-input",
      title: "Live input",
      artist: null,
      tempo: 126,
      time_signature: "4/4"
    },
    phrases,
    preset_catalog: [],
    phrase_visual_assignments: [],
    lighting_cues: phrases.map((phrase, index) => ({
      cue_id: `lx_${phrase.phrase_id}`,
      phrase_id: phrase.phrase_id,
      fixture_group: index >= 3 ? "spots_front" : "wash_all",
      look: {
        palette: phrase.visual_look.palette,
        intensity: phrase.energy.dynamics,
        movement: index >= 3 ? "beat_chase" : "slow_sweep",
        strobe: phrase.energy.level === "peak"
      },
      priority: index
    })),
    // The intro has no laser cue: the projector should stay dark until the
    // detector has actually found something.
    dmx_laser_cues: phrases.slice(1).map((phrase, index) => ({
      cue_id: `laser_${phrase.phrase_id}`,
      phrase_id: phrase.phrase_id,
      fixture_group: "laser_center",
      mode: index >= 2 ? "burst_fan" : "fan_sweep",
      parameter_overrides: {
        scan_speed: Math.round(130 + phrase.energy.dynamics * 95),
        intensity: phrase.energy.dynamics
      }
    })),
    manual_overrides: []
  };

  const preset_catalog = ensureShowPresetCatalog(base);
  return {
    ...base,
    preset_catalog,
    phrase_visual_assignments: buildDefaultPhraseVisualAssignments({ ...base, preset_catalog })
  };
}

export function livePhraseFor(show: ShowPackage, kind: PhraseKind): Phrase {
  return show.phrases.find((phrase) => phrase.phrase_id === `live_${kind}`) ?? show.phrases[0];
}
