import { describe, expect, it } from "vitest";

import type { LiveMusicalState } from "../audio/liveAnalysis.js";
import type { NowPlayingClockSample } from "../nowPlaying/types.js";
import {
  applyDeckGridPhase,
  deckGridMatchesSample,
  deckGridPhaseAt,
  deckGridPhaseForClock,
  validateDeckGridPayload,
  type NowPlayingDeckGrid
} from "../nowPlaying/rekordboxGrid.js";

// 120 BPM: a beat every 0.5 s; the grid starts on beat 3, so the first
// downbeat is grid index 2 at 1.0 s.
const BEAT_SECONDS = Array.from({ length: 16 }, (_, index) => index * 0.5);
const DOWNBEAT_INDEXES = [2, 6, 10, 14];

function grid(overrides: Partial<NowPlayingDeckGrid> = {}): NowPlayingDeckGrid {
  return {
    deck: 2,
    anlzPath: "/rekordbox/ANLZ/746/478b4-90e9",
    title: "Track",
    artist: "Artist",
    beatSeconds: BEAT_SECONDS,
    downbeatIndexes: DOWNBEAT_INDEXES,
    ...overrides
  };
}

function liveState(overrides: Partial<LiveMusicalState> = {}): LiveMusicalState {
  return {
    tempoState: "locked",
    bpm: 126,
    tempoConfidence: 0.5,
    beatPosition: 40.2,
    beatPhase: 0.2,
    beatInBar: 3,
    bar: 9,
    barPhase: 0.55,
    phraseBar: 4,
    phrasePhase: 0.55,
    downbeatConfidence: 0.4,
    phrase: { kind: "groove", startBar: 5, bars: 4, energy: 5 },
    energy: 5,
    bands: { low: 0.3, mid: 0.4, high: 0.5 },
    level: 0.6,
    status: "Locked at 126 BPM",
    ...overrides
  };
}

function clockSample(overrides: Partial<NowPlayingClockSample> = {}): NowPlayingClockSample {
  return {
    status: "exact",
    deck: 2,
    positionSeconds: 1.25,
    playing: true,
    bpm: 120,
    title: "Track",
    artist: "Artist",
    anlzPath: "/rekordbox/ANLZ/746/478b4-90e9",
    ageMs: 0,
    showId: null,
    ...overrides
  };
}

describe("deckGridPhaseAt", () => {
  it("returns the grid's own beat phase and beat-in-bar", () => {
    const phase = deckGridPhaseAt(grid(), 1.0);
    expect(phase).toEqual({ beatPosition: 2, beatPhase: 0, beatInBar: 1, bar: 0 });

    const midBeat = deckGridPhaseAt(grid(), 1.25);
    expect(midBeat).toEqual({ beatPosition: 2.5, beatPhase: 0.5, beatInBar: 1, bar: 0 });

    const nextBar = deckGridPhaseAt(grid(), 3.0);
    expect(nextBar).toEqual({ beatPosition: 6, beatPhase: 0, beatInBar: 1, bar: 1 });

    const offBeat = deckGridPhaseAt(grid(), 3.75);
    expect(offBeat).toEqual({ beatPosition: 7.5, beatPhase: 0.5, beatInBar: 2, bar: 1 });
  });

  it("returns null before the grid can place the beat in a bar", () => {
    // Before the first analysed beat at all.
    expect(deckGridPhaseAt(grid(), -0.5)).toBeNull();
    // Inside the grid but before the first downbeat: no bar to anchor to.
    expect(deckGridPhaseAt(grid(), 0.25)).toBeNull();
  });

  it("extrapolates past the end of the grid", () => {
    const tail = deckGridPhaseAt(grid(), 8.5);
    // Grid index 17 is two beats past the last one; the bar pattern continues.
    expect(tail).toEqual({ beatPosition: 17, beatPhase: 0, beatInBar: 4, bar: 3 });
  });
});

describe("applyDeckGridPhase", () => {
  it("overrides beat phase and bar position with the grid's", () => {
    const spliced = applyDeckGridPhase(liveState(), {
      beatPosition: 6,
      beatPhase: 0,
      beatInBar: 1,
      bar: 1
    });
    expect(spliced.beatPosition).toBe(6);
    expect(spliced.beatPhase).toBe(0);
    expect(spliced.beatInBar).toBe(1);
    expect(spliced.bar).toBe(1);
    expect(spliced.barPhase).toBe(0);
  });

  it("keeps phrase, energy and bands from the live analyser", () => {
    const live = liveState();
    const spliced = applyDeckGridPhase(live, {
      beatPosition: 6,
      beatPhase: 0,
      beatInBar: 1,
      bar: 1
    });
    expect(spliced.phrase).toBe(live.phrase);
    expect(spliced.phraseBar).toBe(live.phraseBar);
    expect(spliced.phrasePhase).toBe(live.phrasePhase);
    expect(spliced.energy).toBe(live.energy);
    expect(spliced.bands).toBe(live.bands);
    expect(spliced.tempoState).toBe(live.tempoState);
  });

  it("returns the live state untouched without a grid phase", () => {
    const live = liveState();
    expect(applyDeckGridPhase(live, null)).toBe(live);
  });
});

describe("deckGridMatchesSample", () => {
  it("requires the same deck and anlz path", () => {
    expect(deckGridMatchesSample(grid(), clockSample())).toBe(true);
    expect(deckGridMatchesSample(grid({ deck: 1 }), clockSample())).toBe(false);
    expect(deckGridMatchesSample(grid({ anlzPath: "/other" }), clockSample())).toBe(false);
  });
});

describe("validateDeckGridPayload", () => {
  it("accepts a server grid payload", () => {
    const parsed = validateDeckGridPayload({
      status: "exact",
      deck: 2,
      title: "Track",
      artist: "Artist",
      anlzPath: "/rekordbox/ANLZ/746/478b4-90e9",
      beatSeconds: [0, 0.5, 1],
      downbeatIndexes: [2]
    });
    expect(parsed).toEqual(grid({ beatSeconds: [0, 0.5, 1], downbeatIndexes: [2] }));
  });

  it("rejects payloads without a deck or grid", () => {
    expect(validateDeckGridPayload({ status: "exact", deck: null })).toBeNull();
    expect(
      validateDeckGridPayload({
        status: "exact",
        deck: 2,
        title: null,
        artist: null,
        anlzPath: "/x",
        beatSeconds: "nope",
        downbeatIndexes: []
      })
    ).toBeNull();
  });
});

describe("deckGridPhaseForClock", () => {
  interface GateInput {
    grid: NowPlayingDeckGrid | null;
    sample: NowPlayingClockSample | null;
    observation: { deck: number | null; positionSource: string | null; playbackPositionSeconds: number | null } | null;
    trackSeconds: number | null;
  }

  function gate(input: GateInput) {
    return deckGridPhaseForClock({
      grid: input.grid,
      deck: input.sample?.deck ?? null,
      anlzPath: input.sample?.anlzPath ?? null,
      observationDeck: input.observation?.deck ?? null,
      positionSource: input.observation?.positionSource ?? null,
      playbackPositionSeconds: input.observation?.playbackPositionSeconds ?? null,
      trackSeconds: input.trackSeconds
    });
  }

  const observation = { deck: 2, positionSource: "exact", playbackPositionSeconds: 1.25 };

  it("returns the grid phase when clock, observation and grid agree", () => {
    expect(gate({ grid: grid(), sample: clockSample(), observation, trackSeconds: 1.25 })).toEqual({
      beatPosition: 2.5,
      beatPhase: 0.5,
      beatInBar: 1,
      bar: 0
    });
  });

  it("falls back when the grid describes another deck track", () => {
    expect(
      gate({ grid: grid({ deck: 1 }), sample: clockSample(), observation, trackSeconds: 1.25 })
    ).toBeNull();
    expect(
      gate({ grid: grid({ anlzPath: "/other" }), sample: clockSample(), observation, trackSeconds: 1.25 })
    ).toBeNull();
  });

  it("falls back when the clock sample is not exact or carries no anlz path", () => {
    // Without an exact sample there is no anchor, so the playhead is unknown.
    expect(
      gate({ grid: grid(), sample: clockSample({ status: "probe-failed:stale" }), observation, trackSeconds: null })
    ).toBeNull();
    expect(gate({ grid: grid(), sample: clockSample({ deck: null }), observation, trackSeconds: null })).toBeNull();
    expect(gate({ grid: grid(), sample: clockSample({ anlzPath: null }), observation, trackSeconds: null })).toBeNull();
  });

  it("falls back when the observation is not an exact deck clock", () => {
    expect(
      gate({
        grid: grid(),
        sample: clockSample(),
        observation: { deck: 2, positionSource: "estimated", playbackPositionSeconds: 1.25 },
        trackSeconds: 1.25
      })
    ).toBeNull();
    expect(
      gate({ grid: grid(), sample: clockSample(), observation: { deck: 1, positionSource: "exact", playbackPositionSeconds: 1.25 }, trackSeconds: 1.25 })
    ).toBeNull();
    expect(
      gate({ grid: grid(), sample: clockSample(), observation: { deck: 2, positionSource: "exact", playbackPositionSeconds: null }, trackSeconds: 1.25 })
    ).toBeNull();
    expect(gate({ grid: grid(), sample: clockSample(), observation: null, trackSeconds: 1.25 })).toBeNull();
  });

  it("falls back with no projected playhead", () => {
    expect(gate({ grid: grid(), sample: clockSample(), observation, trackSeconds: null })).toBeNull();
  });
});
