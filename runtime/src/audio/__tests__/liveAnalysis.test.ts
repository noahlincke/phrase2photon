import { describe, expect, it } from "vitest";

import { LiveAnalyzer } from "../liveAnalysis.js";
import { synthesizeBeatTrack } from "./synthesize.js";

/**
 * Feeds audio through the analyzer the way a capture node would: small fixed
 * blocks, timestamped on the audio clock.
 */
function stream(analyzer: LiveAnalyzer, samples: Float32Array, sampleRate: number, blockSize = 128): void {
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const block = samples.subarray(offset, Math.min(samples.length, offset + blockSize));
    analyzer.push(block, offset / sampleRate);
  }
}

describe("LiveAnalyzer", () => {
  it("locks onto the tempo of a steady 4/4 feed", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 128, bars: 48 });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);

    const state = analyzer.snapshot(samples.length / sampleRate);
    expect(state.tempoState).toBe("locked");
    expect(state.bpm).toBeGreaterThan(127);
    expect(state.bpm).toBeLessThan(129);
  });

  it("places its beat grid on the real beats", () => {
    const { samples, sampleRate, beatTimes } = synthesizeBeatTrack({ bpm: 124, bars: 48 });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);

    // Compare near the end, where the loop has had time to settle.
    const probe = beatTimes[beatTimes.length - 8];
    const position = analyzer.snapshot(probe).beatPosition;
    const offset = Math.abs(position - Math.round(position));
    expect(offset).toBeLessThan(0.12);
  });

  it("stays on the beat when offbeat hats dominate", () => {
    const { samples, sampleRate, beatTimes } = synthesizeBeatTrack({
      bpm: 132,
      bars: 48,
      offbeatHats: true
    });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);

    const probe = beatTimes[beatTimes.length - 8];
    const position = analyzer.snapshot(probe).beatPosition;
    const offset = Math.abs(position - Math.round(position));
    expect(offset).toBeLessThan(0.15);
  });

  it("honours a tapped downbeat over its own estimate", () => {
    const { samples, sampleRate, beatTimes } = synthesizeBeatTrack({ bpm: 126, bars: 32 });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);

    // Tap on a beat that really is a downbeat in the synthesised track.
    const downbeat = beatTimes[64];
    analyzer.tapDownbeat(downbeat);
    const state = analyzer.snapshot(downbeat + 0.001);
    expect(state.beatInBar).toBe(1);
    expect(state.phraseBar).toBe(0);
    expect(state.downbeatConfidence).toBe(1);
  });

  it("follows a fixed BPM without estimating", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 128, bars: 24 });
    const analyzer = new LiveAnalyzer(sampleRate);
    analyzer.setFixedBpm(140);
    stream(analyzer, samples, sampleRate);

    const state = analyzer.snapshot(samples.length / sampleRate);
    expect(analyzer.hasFixedBpm).toBe(true);
    expect(state.bpm).toBe(140);
    expect(state.tempoState).toBe("locked");
  });

  it("reports a musical position that advances monotonically", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 130, bars: 32 });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);

    const duration = samples.length / sampleRate;
    let previous = -Infinity;
    for (let time = duration - 8; time < duration; time += 0.05) {
      const state = analyzer.snapshot(time);
      expect(state.beatPosition).toBeGreaterThan(previous);
      expect(state.beatPhase).toBeGreaterThanOrEqual(0);
      expect(state.beatPhase).toBeLessThan(1);
      expect(state.beatInBar).toBeGreaterThanOrEqual(1);
      expect(state.beatInBar).toBeLessThanOrEqual(4);
      expect(state.phraseBar).toBeGreaterThanOrEqual(0);
      expect(state.phraseBar).toBeLessThanOrEqual(7);
      previous = state.beatPosition;
    }
  });

  it("rates a stripped-back section lower in energy than a full one", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({
      bpm: 128,
      bars: 64,
      quietBars: (bar) => bar >= 32 && bar < 48
    });
    const analyzer = new LiveAnalyzer(sampleRate);
    const period = 60 / 128;

    const energies: number[] = [];
    const blockSize = 128;
    for (let offset = 0; offset < samples.length; offset += blockSize) {
      analyzer.push(samples.subarray(offset, offset + blockSize), offset / sampleRate);
      energies.push(analyzer.snapshot(offset / sampleRate).energy);
    }
    const energyAtBar = (bar: number): number => {
      const index = Math.min(energies.length - 1, Math.floor((bar * 4 * period * sampleRate) / blockSize));
      return energies[index];
    };
    expect(energyAtBar(44)).toBeLessThan(energyAtBar(28));
  });

  it("resets cleanly", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 128, bars: 16 });
    const analyzer = new LiveAnalyzer(sampleRate);
    stream(analyzer, samples, sampleRate);
    analyzer.reset();
    expect(analyzer.running).toBe(false);
    const state = analyzer.snapshot(0);
    expect(state.tempoState).toBe("idle");
    expect(state.bar).toBe(0);
  });
});

describe("LiveAnalyzer phrase state", () => {
  it("does not open on a drop when capture starts mid-groove", () => {
    // Regression: `phraseHadBass` started false, so the first loud bar looked
    // like bass returning and the very first phrase reported was a drop.
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 128, bars: 24 });
    const analyzer = new LiveAnalyzer(sampleRate);

    const kinds = new Set<string>();
    const blockSize = 128;
    for (let offset = 0; offset < samples.length; offset += blockSize) {
      analyzer.push(samples.subarray(offset, offset + blockSize), offset / sampleRate);
      kinds.add(analyzer.snapshot(offset / sampleRate).phrase.kind);
    }
    expect(kinds.has("drop")).toBe(false);
  });

  it("calls a drop when the bass returns after a stripped section", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({
      bpm: 128,
      bars: 80,
      quietBars: (bar) => bar >= 24 && bar < 48
    });
    const analyzer = new LiveAnalyzer(sampleRate);

    const seen: string[] = [];
    const blockSize = 128;
    for (let offset = 0; offset < samples.length; offset += blockSize) {
      analyzer.push(samples.subarray(offset, offset + blockSize), offset / sampleRate);
      const kind = analyzer.snapshot(offset / sampleRate).phrase.kind;
      if (seen[seen.length - 1] !== kind) {
        seen.push(kind);
      }
    }
    // The bass drops out and comes back, so the run must contain a
    // low-energy state followed later by a bass-present one.
    expect(seen).toContain("breakdown");
    expect(seen.indexOf("breakdown")).toBeLessThan(seen.length - 1);
  });
});
