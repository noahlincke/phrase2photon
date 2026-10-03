import { describe, expect, it } from "vitest";

import { barBeatToBeat, buildPhraseSchedule, playbackStateAt } from "../runtime/schedule.js";
import { gridFor } from "../show/beatGrid.js";
import type { ShowPackage } from "../show/types.js";

const show: ShowPackage = {
  version: "0.1.0",
  song: {
    song_id: "song",
    title: "Song",
    artist: null,
    tempo: 120,
    time_signature: "4/4"
  },
  phrases: [
    {
      phrase_id: "phrase_a",
      name: "A",
      range: {
        start_bar_beat: "1|1",
        end_bar_beat: "5|1",
        start_locator_id: null,
        end_locator_id: null
      },
      locators: [],
      track_features: [],
      energy: { level: "low", dynamics: 0.2, tension: 0.1 },
      visual_look: { palette: "smoke-cool", motion_style: "slow_drift", composition: "sparse", notes: [] },
      transition_in: null,
      transition_out: null
    },
    {
      phrase_id: "phrase_b",
      name: "B",
      range: {
        start_bar_beat: "5|1",
        end_bar_beat: "9|1",
        start_locator_id: null,
        end_locator_id: null
      },
      locators: [],
      track_features: [],
      energy: { level: "peak", dynamics: 1, tension: 0.4 },
      visual_look: { palette: "acid-contrast", motion_style: "beat_locked_cuts", composition: "dense", notes: [] },
      transition_in: null,
      transition_out: null
    }
  ],
  preset_catalog: [],
  phrase_visual_assignments: [],
  lighting_cues: [],
  dmx_laser_cues: [],
  manual_overrides: []
};

describe("phrase schedule", () => {
  it("maps bar beat values to zero-based beats", () => {
    expect(barBeatToBeat("1|1", 4)).toBe(0);
    expect(barBeatToBeat("5|1", 4)).toBe(16);
  });

  it("selects the active phrase from audio seconds", () => {
    const schedule = buildPhraseSchedule(show);
    expect(schedule[0].startSeconds).toBe(0);
    expect(schedule[1].startSeconds).toBe(8);

    const playback = playbackStateAt(schedule, 8.25, gridFor(show));
    expect(playback.active.phrase.phrase_id).toBe("phrase_b");
    expect(playback.bar).toBe(5);
  });

  it("clamps the lead-in before the first downbeat to bar 1 beat 1", () => {
    // Shows compiled from a measured first downbeat play through the lead-in
    // before it; the grid counts beats from that downbeat, so raw beats go
    // negative there and would hand the HUD a bar 0.
    const leadIn: ShowPackage = {
      ...show,
      song: { ...show.song, tempo_map: [{ start_seconds: 0, bpm: 120, downbeat_seconds: 1.4 }] }
    };
    const schedule = buildPhraseSchedule(leadIn);

    const playback = playbackStateAt(schedule, 0.0, gridFor(leadIn));
    expect(playback.beat).toBe(1);
    expect(playback.bar).toBe(1);
    expect(playback.active.phrase.phrase_id).toBe("phrase_a");
  });
});
