import { describe, expect, it } from "vitest";

import { compatiblePresetsForPhraseId, resolveVisualPreset } from "../graphics/presetSelection.js";
import type { ShowPackage } from "../show/types.js";

const show: ShowPackage = {
  version: "0.1.0",
  song: {
    song_id: "test-song",
    title: "Test Song",
    artist: null,
    tempo: 128,
    time_signature: "4/4"
  },
  phrases: [
    {
      phrase_id: "phrase_intro",
      name: "Intro",
      range: {
        start_bar_beat: "1|1",
        end_bar_beat: "9|1",
        start_locator_id: null,
        end_locator_id: null
      },
      locators: [],
      track_features: [],
      energy: {
        level: "low",
        dynamics: 0.2,
        tension: 0.1
      },
      visual_look: {
        palette: "smoke-cool",
        motion_style: "slow_drift",
        composition: "sparse",
        notes: []
      },
      transition_in: null,
      transition_out: null
    },
    {
      phrase_id: "phrase_drop",
      name: "Drop",
      range: {
        start_bar_beat: "9|1",
        end_bar_beat: "17|1",
        start_locator_id: null,
        end_locator_id: null
      },
      locators: [],
      track_features: [],
      energy: {
        level: "peak",
        dynamics: 0.9,
        tension: 0.8
      },
      visual_look: {
        palette: "acid-contrast",
        motion_style: "hard_cuts",
        composition: "dense",
        notes: []
      },
      transition_in: null,
      transition_out: null
    }
  ],
  preset_catalog: [
    {
      preset_id: "calm-prism-chamber",
      name: "Calm Prism Chamber",
      family: "texture-atmosphere",
      mode_support: ["deterministic", "live-rotation"],
      phrase_tags: ["intro", "groove"],
      energy_tags: ["low", "mid"],
      style_tags: ["texture", "calm"],
      palette_key: "smoke-cool",
      engine: "shader-plane",
      thumbnail_url: null,
      clip_source: null,
      notes: []
    },
    {
      preset_id: "hard-kaleido-strike",
      name: "Hard Kaleido Strike",
      family: "centered-kaleidoscope",
      mode_support: ["deterministic", "live-rotation"],
      phrase_tags: ["drop", "build"],
      energy_tags: ["high", "peak"],
      style_tags: ["kaleidoscopic", "percussive"],
      palette_key: "acid-contrast",
      engine: "kaleido-core",
      thumbnail_url: null,
      clip_source: null,
      notes: []
    },
    {
      preset_id: "drop-lattice-exhale",
      name: "Drop Lattice Exhale",
      family: "cyber-psychedelic",
      mode_support: ["live-rotation"],
      phrase_tags: ["drop", "build"],
      energy_tags: ["high", "peak"],
      style_tags: ["cyber-psychedelic", "percussive"],
      palette_key: "acid-contrast",
      engine: "cyber-lattice",
      thumbnail_url: null,
      clip_source: null,
      notes: []
    }
  ],
  phrase_visual_assignments: [
    {
      phrase_id: "phrase_intro",
      preset_id: "calm-prism-chamber",
      locked: true,
      palette_override: null,
      parameter_overrides: {}
    },
    {
      phrase_id: "phrase_drop",
      preset_id: "hard-kaleido-strike",
      locked: true,
      palette_override: null,
      parameter_overrides: {}
    }
  ],
  lighting_cues: [],
  dmx_laser_cues: [],
  manual_overrides: []
};

describe("resolveVisualPreset", () => {
  it("uses deterministic phrase assignments for library playback", () => {
    const selection = resolveVisualPreset({
      mode: "deterministic",
      phraseId: "phrase_intro",
      show,
      previousPresetId: null
    });

    expect(selection.preset.preset_id).toBe("calm-prism-chamber");
    expect(selection.source).toBe("assignment");
  });

  it("rotates among compatible live presets without leaving the allowed pool", () => {
    const selection = resolveVisualPreset({
      mode: "live-rotation",
      phraseId: "phrase_drop",
      show,
      previousPresetId: "hard-kaleido-strike"
    });

    expect(selection.preset.style_tags).toContain("percussive");
    expect(selection.preset.mode_support).toContain("live-rotation");
    expect(selection.preset.preset_id).toBe("drop-lattice-exhale");
    expect(selection.source).toBe("rotation");
  });

  it("exposes the compatible preset pool for operator-facing filtering", () => {
    const compatible = compatiblePresetsForPhraseId(show, "phrase_drop", "deterministic");

    expect(compatible.map((preset) => preset.preset_id)).toEqual(["hard-kaleido-strike"]);
  });
});
