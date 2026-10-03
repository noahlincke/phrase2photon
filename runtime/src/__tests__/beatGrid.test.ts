import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { barBeatToBeat, beatsToSeconds, gridFor, secondsToBeats, tempoAt, type BeatGrid } from "../show/beatGrid.js";
import { buildPhraseSchedule, playbackStateAt } from "../runtime/schedule.js";
import type { ShowPackage } from "../show/types.js";

interface VectorFile {
  grids: Record<string, { beats_per_bar: number; segments: BeatGrid["segments"] }>;
  samples: Record<string, { seconds: number; beats: number }[]>;
  bar_beats: { beats: number; bar_beat: string }[];
}

// Shared with the python twin (src/phrase2photon/contracts/beat_grid.py); the
// fixture is generated once and both suites must reproduce it exactly.
const vectors: VectorFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../fixtures/beat-grid-vectors.json", import.meta.url)), "utf-8")
);

function makeShow(tempoMap?: ShowPackage["song"]["tempo_map"]): ShowPackage {
  return {
    version: "0.1.0",
    song: {
      song_id: "song",
      title: "Song",
      artist: null,
      tempo: 120,
      time_signature: "4/4",
      tempo_map: tempoMap
    },
    phrases: [
      {
        phrase_id: "phrase_a",
        name: "A",
        range: { start_bar_beat: "1|1", end_bar_beat: "5|1", start_locator_id: null, end_locator_id: null },
        locators: [],
        track_features: [],
        energy: { level: "low", dynamics: 0.2, tension: 0.1 },
        visual_look: { palette: "smoke-cool", motion_style: "slow_drift", composition: "sparse", notes: [] },
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
}

describe("beat grid", () => {
  it("defaults to a single segment anchored at zero", () => {
    const grid = gridFor(makeShow());
    expect(grid.segments).toEqual([{ start_seconds: 0, bpm: 120, downbeat_seconds: 0 }]);
    expect(grid.beatsPerBar).toBe(4);
    expect(secondsToBeats(grid, 2)).toBe(4);
    expect(beatsToSeconds(grid, 4)).toBe(2);
    expect(tempoAt(grid, 100)).toBe(120);
  });

  it("counts bar|beat from the first downbeat, not from zero seconds", () => {
    const grid = gridFor(makeShow([{ start_seconds: 0, bpm: 120, downbeat_seconds: 1.5 }]));
    expect(beatsToSeconds(grid, 0)).toBe(1.5);
    expect(secondsToBeats(grid, 1.5)).toBe(0);
    expect(secondsToBeats(grid, 0)).toBe(-3);
    // Times before the first downbeat still convert back onto the grid.
    expect(beatsToSeconds(grid, -3)).toBe(0);
    expect(tempoAt(grid, 0)).toBe(120);
  });

  it("an absent tempo map and an explicit single-entry map behave identically", () => {
    const implicit = makeShow();
    const explicit = makeShow([{ start_seconds: 0, bpm: 120, downbeat_seconds: 0 }]);
    const implicitSchedule = buildPhraseSchedule(implicit);
    const explicitSchedule = buildPhraseSchedule(explicit);

    expect(explicitSchedule.map((entry) => [entry.startSeconds, entry.endSeconds]))
      .toEqual(implicitSchedule.map((entry) => [entry.startSeconds, entry.endSeconds]));

    const implicitGrid = gridFor(implicit);
    const explicitGrid = gridFor(explicit);
    for (let index = 0; index < 50; index += 1) {
      const seconds = index * 1.7;
      expect(secondsToBeats(explicitGrid, seconds)).toBe(secondsToBeats(implicitGrid, seconds));
      expect(beatsToSeconds(explicitGrid, secondsToBeats(implicitGrid, seconds)))
        .toBe(beatsToSeconds(implicitGrid, secondsToBeats(implicitGrid, seconds)));
      const implicitState = playbackStateAt(implicitSchedule, seconds, implicitGrid);
      const explicitState = playbackStateAt(explicitSchedule, seconds, explicitGrid);
      expect(explicitState.beat).toBe(implicitState.beat);
      expect(explicitState.bar).toBe(implicitState.bar);
      expect(explicitState.phase).toBe(implicitState.phase);
    }
  });

  it("keeps each segment's own beats integer across a tempo boundary", () => {
    // 384 beats (96 bars) elapse at 128 bpm before 180 s. The incoming
    // 100 bpm grid is anchored one bar earlier so its downbeat lands on a
    // whole bar of the continuing count: 384 - 4 = 380.
    const grid = gridFor(makeShow([
      { start_seconds: 0, bpm: 128, downbeat_seconds: 0 },
      { start_seconds: 180, bpm: 100, downbeat_seconds: 177.6 }
    ]));

    expect(secondsToBeats(grid, 180)).toBe(384);
    expect(beatsToSeconds(grid, 384)).toBe(180);
    for (let beat = 0; beat * (60 / 128) < 180; beat += 1) {
      expect(secondsToBeats(grid, beat * (60 / 128))).toBe(beat);
    }
    // From the boundary the incoming grid owns the count: its own beat k
    // lands at 380 + k continuous beats (380 is a whole bar).
    for (let beat = 4; beat <= 40; beat += 1) {
      const seconds = 177.6 + beat * (60 / 100);
      expect(secondsToBeats(grid, seconds)).toBe(380 + beat);
      expect(beatsToSeconds(grid, 380 + beat)).toBeCloseTo(seconds, 10);
    }
    expect(tempoAt(grid, 179.9)).toBe(128);
    expect(tempoAt(grid, 180)).toBe(100);
  });

  it("lands a late segment's downbeat on a whole bar even when plain continuation would not", () => {
    // 60 beats (120 bpm) elapse by 30 s. Plain continuation would put the
    // incoming 90 bpm downbeat at 31 s on beat 61.5 - mid-bar. Snapping it
    // forward to bar 17 (beat 64) puts the segment start on beat 62.5.
    const late = gridFor(makeShow([
      { start_seconds: 0, bpm: 120, downbeat_seconds: 0 },
      { start_seconds: 30, bpm: 90, downbeat_seconds: 31 }
    ]));
    expect(secondsToBeats(late, 30)).toBe(62.5);
    expect(secondsToBeats(late, 31)).toBe(64);
    expect(beatsToSeconds(late, 64)).toBe(31);
    expect(beatsToSeconds(late, 62.5)).toBe(30);

    // A downbeat before the segment start extends the grid backwards: it
    // still lands on a whole bar (60 = bar 16) and the count never falls
    // back below where the previous grid left off.
    const early = gridFor(makeShow([
      { start_seconds: 0, bpm: 120, downbeat_seconds: 0 },
      { start_seconds: 30, bpm: 90, downbeat_seconds: 29 }
    ]));
    expect(secondsToBeats(early, 30)).toBe(61.5);
    expect(secondsToBeats(early, 29)).toBe(58); // still on the previous grid

    for (let seconds = 25; seconds <= 35; seconds += 0.1) {
      expect(secondsToBeats(late, seconds)).toBeGreaterThanOrEqual(secondsToBeats(late, seconds - 0.1));
      expect(secondsToBeats(early, seconds)).toBeGreaterThanOrEqual(secondsToBeats(early, seconds - 0.1));
    }
    for (let beats = 0; beats <= 80; beats += 0.5) {
      expect(beatsToSeconds(late, beats)).toBeGreaterThanOrEqual(beatsToSeconds(late, beats - 0.5));
      expect(beatsToSeconds(early, beats)).toBeGreaterThanOrEqual(beatsToSeconds(early, beats - 0.5));
    }
  });

  it("round-trips a compiled downbeat offset through the schedule", () => {
    // Matches the python compiler: tempo_map [{0, tempo, first_downbeat}] and
    // a phrase four bars after the downbeat labelled "5|1".
    const show = makeShow([{ start_seconds: 0, bpm: 120, downbeat_seconds: 0.5 }]);
    const schedule = buildPhraseSchedule({
      ...show,
      phrases: [
        {
          ...show.phrases[0],
          range: { start_bar_beat: "5|1", end_bar_beat: "9|1", start_locator_id: null, end_locator_id: null }
        }
      ]
    });

    expect(schedule[0].startSeconds).toBe(8.5);
    expect(schedule[0].endSeconds).toBe(16.5);
    const state = playbackStateAt(schedule, 8.5, gridFor(show));
    expect(state.beat).toBe(17);
    expect(state.bar).toBe(5);
  });

  it("reproduces the shared beat-grid vectors the python twin generated", () => {
    for (const [name, gridSpec] of Object.entries(vectors.grids)) {
      const grid: BeatGrid = { segments: gridSpec.segments, beatsPerBar: gridSpec.beats_per_bar };
      for (const sample of vectors.samples[name]) {
        expect(secondsToBeats(grid, sample.seconds), `${name} @ ${sample.seconds}s`).toBe(sample.beats);
        // The stored beats are themselves rounded forward results, so the way
        // back may land a few ULPs off the original seconds.
        expect(beatsToSeconds(grid, sample.beats), `${name} @ ${sample.beats} beats`).toBeCloseTo(sample.seconds, 9);
      }
    }
  });

  it("parses bar|beat strings as before", () => {
    expect(barBeatToBeat("1|1", 4)).toBe(0);
    expect(barBeatToBeat("5|1", 4)).toBe(16);
  });
});
