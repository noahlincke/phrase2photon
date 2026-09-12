import { describe, expect, it } from "vitest";

import { createRuntimeState } from "../runtime/state.js";
import type { ShowPackage } from "../show/types.js";

const show: ShowPackage = {
  version: "0.1.0",
  song: {
    song_id: "test",
    title: "Test",
    artist: null,
    tempo: 124,
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
      notes: ["slow chamber drift"]
    }
  ],
  phrase_visual_assignments: [
    {
      phrase_id: "phrase_intro",
      preset_id: "calm-prism-chamber",
      locked: true,
      palette_override: null,
      parameter_overrides: {}
    }
  ],
  lighting_cues: [
    {
      cue_id: "lx_intro",
      phrase_id: "phrase_intro",
      fixture_group: "wash_all",
      look: {
        palette: "steel-blue",
        intensity: 0.4,
        movement: "slow_sweep",
        strobe: false
      },
      priority: 0
    }
  ],
  dmx_laser_cues: [],
  manual_overrides: []
};

describe("createRuntimeState", () => {
  it("selects a phrase and exposes parallel output intents", () => {
    const state = createRuntimeState(show, {
      bpm: 124,
      beat: 1,
      bar: 1,
      phase: 0,
      isPlaying: true,
      nowSeconds: 0
    });

    expect(state.activePhrase.phrase_id).toBe("phrase_intro");
    expect(state.outputs).toHaveLength(1);
    expect(state.outputs[0].kind).toBe("lighting");
    expect(state.activePhrase.visual_look.palette).toBe("smoke-cool");
    expect(state.show.phrase_visual_assignments[0].preset_id).toBe("calm-prism-chamber");
  });
});
