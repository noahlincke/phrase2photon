import { describe, expect, it } from "vitest";

import {
  anchorFromClockSample,
  clockSampleIsExact,
  clockSampleIsJump,
  NOW_PLAYING_JUMP_SECONDS,
  projectClockAnchor
} from "../nowPlaying/exactClock.js";
import type { NowPlayingClockSample } from "../nowPlaying/types.js";

function sample(overrides: Partial<NowPlayingClockSample> = {}): NowPlayingClockSample {
  return {
    status: "exact",
    deck: 1,
    positionSeconds: 10,
    playing: true,
    bpm: 128,
    title: "Track",
    artist: null,
    ageMs: 0,
    showId: null,
    ...overrides
  };
}

function exact(overrides: Partial<NowPlayingClockSample> = {}) {
  const candidate = sample(overrides);
  if (!clockSampleIsExact(candidate)) {
    throw new Error("test fixture is not an exact sample");
  }
  return candidate;
}

describe("clockSampleIsExact", () => {
  it("accepts an exact sample with a deck and position", () => {
    expect(clockSampleIsExact(sample())).toBe(true);
  });

  it("rejects anything the clock endpoint did not call exact", () => {
    expect(clockSampleIsExact(sample({ status: "not-running" }))).toBe(false);
    expect(clockSampleIsExact(sample({ deck: null }))).toBe(false);
    expect(clockSampleIsExact(sample({ positionSeconds: null }))).toBe(false);
    expect(clockSampleIsExact(null)).toBe(false);
  });
});

describe("transport clock re-anchoring", () => {
  it("folds the sample's age into the anchor while playing", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, ageMs: 120 }), 1000);
    expect(anchor.positionSeconds).toBeCloseTo(20.12);
    expect(projectClockAnchor(anchor, 1500)).toBeCloseTo(20.62);
  });

  it("holds the position when the deck is paused", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, playing: false, ageMs: 120 }), 1000);
    expect(anchor.positionSeconds).toBeCloseTo(20);
    expect(projectClockAnchor(anchor, 5000)).toBeCloseTo(20);
  });

  it("does not project backwards when the anchor is applied late", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, ageMs: 0 }), 1000);
    expect(projectClockAnchor(anchor, 900)).toBeCloseTo(20);
  });
});

describe("cue jump handling", () => {
  it("re-anchors immediately when a sample lands far from the projection", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 10 }), 1000);
    // A hot-cue jump: the deck now reports a position the projection left behind.
    const jumped = exact({ positionSeconds: 42, ageMs: 0 });
    expect(clockSampleIsJump(anchor, jumped, 2000)).toBe(true);

    const reanchored = anchorFromClockSample(jumped, 2000);
    expect(projectClockAnchor(reanchored, 2000)).toBeCloseTo(42);
    expect(projectClockAnchor(reanchored, 2500)).toBeCloseTo(42.5);
  });

  it("treats normal drift under the threshold as steady playback", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 10 }), 1000);
    const drifted = exact({ positionSeconds: 10.1, ageMs: 50 });
    expect(clockSampleIsJump(anchor, drifted, 1120)).toBe(false);
  });

  it("never calls a non-exact sample a jump", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 10 }), 1000);
    expect(clockSampleIsJump(anchor, sample({ status: "not-running" }), 2000)).toBe(false);
  });

  it("uses a quarter-second threshold", () => {
    expect(NOW_PLAYING_JUMP_SECONDS).toBe(0.25);
  });
});

describe("pitched-deck rate", () => {
  it("folds the sample's age and projects at the deck's effective rate", () => {
    // 123 bpm over a 120 bpm show: the deck burns source seconds 1.025x fast.
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, ageMs: 100 }), 1000, 1.025);
    expect(anchor.positionSeconds).toBeCloseTo(20.1025, 5);
    expect(projectClockAnchor(anchor, 2000)).toBeCloseTo(21.1275, 5);
  });

  it("still holds the position when a pitched deck is paused", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, playing: false, ageMs: 100 }), 1000, 1.025);
    expect(anchor.positionSeconds).toBeCloseTo(20, 5);
    expect(projectClockAnchor(anchor, 5000)).toBeCloseTo(20, 5);
  });

  it("defaults to real-time projection without a rate", () => {
    const anchor = anchorFromClockSample(exact({ positionSeconds: 20, ageMs: 100 }), 1000);
    expect(anchor.positionSeconds).toBeCloseTo(20.1, 5);
    expect(projectClockAnchor(anchor, 2000)).toBeCloseTo(21.1, 5);
  });
});
