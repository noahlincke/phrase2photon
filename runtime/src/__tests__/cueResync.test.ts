import { describe, expect, it } from "vitest";

import { CueResyncTracker, restartCueFrame } from "../dmx/cueResync.js";
import { buildFb4CueFrame, buildFb4LegacyCueFrame, cueIndexValue } from "../dmx/fb4Dmx16.js";

const bpm = 122;

describe("cue re-sync", () => {
  it("restarts the cue exactly once per bar, on the downbeat frame", () => {
    const tracker = new CueResyncTracker();
    const frames = [0, 0.05, 0.5, 4, 4.5, 8, 8.5].map((positionBeats) =>
      tracker.restart(buildFb4LegacyCueFrame(4, bpm), { positionBeats, beatsPerBar: 4, bpm }, 1, true)
    );

    // The first frame of each bar restarts; frames inside the bar go unchanged.
    expect(frames.map((frame) => frame !== null)).toEqual([true, false, false, true, false, true, false]);
    for (const frame of frames) {
      if (frame) {
        expect(frame.channels[2]).toBe(0);
      }
    }
  });

  it("restarts once per four bars when the period is four bars", () => {
    const tracker = new CueResyncTracker();
    const positions = [0, 4, 8, 12, 16, 20];
    const frames = positions.map((positionBeats) =>
      tracker.restart(buildFb4LegacyCueFrame(4, bpm), { positionBeats, beatsPerBar: 4, bpm }, 4, true)
    );

    expect(frames.map((frame) => frame !== null)).toEqual([true, false, false, false, true, false]);
  });

  it("never restarts while the option is off", () => {
    const tracker = new CueResyncTracker();
    for (const positionBeats of [0, 1, 2, 4, 16]) {
      expect(
        tracker.restart(buildFb4LegacyCueFrame(4, bpm), { positionBeats, beatsPerBar: 4, bpm }, 1, false)
      ).toBeNull();
    }
  });

  it("skips a boundary the frame loop missed instead of re-syncing mid-bar", () => {
    const tracker = new CueResyncTracker();
    // Enabling mid-bar latches the period without restarting…
    expect(
      tracker.restart(buildFb4LegacyCueFrame(4, bpm), { positionBeats: 2.5, beatsPerBar: 4, bpm }, 1, true)
    ).toBeNull();
    // …and the next downbeat still restarts on time.
    const restarted = tracker.restart(
      buildFb4LegacyCueFrame(4, bpm),
      { positionBeats: 4.02, beatsPerBar: 4, bpm },
      1,
      true
    );
    expect(restarted).not.toBeNull();
  });

  it("restarts on the 39-channel cue index channel too", () => {
    const frame = restartCueFrame(buildFb4CueFrame(4, bpm, 3));
    expect(frame.channels[13]).toBe(3);
    expect(frame.channels[14]).toBe(0);
    expect(frame.channels.filter((value, index) => index !== 14)).toEqual(
      buildFb4CueFrame(4, bpm, 3).channels.filter((value, index) => index !== 14)
    );
  });

  it("leaves every channel but the cue index untouched on restart frames", () => {
    const base = buildFb4LegacyCueFrame(4, bpm);
    const restarted = restartCueFrame(base);
    expect(restarted.channels[2]).toBe(0);
    expect(restarted.channels[2]).not.toBe(cueIndexValue(4));
    expect(restarted.channels[0]).toBe(251);
    expect(restarted.channels[1]).toBe(base.channels[1]);
    expect(restarted.channels[3]).toBe(base.channels[3]);
    expect(restarted.channels[4]).toBe(base.channels[4]);
    expect(restarted.channels[14]).toBe(base.channels[14]);
  });
});
