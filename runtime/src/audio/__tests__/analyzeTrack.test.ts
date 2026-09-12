import { describe, expect, it } from "vitest";

import { analyzeTrack } from "../analyzeTrack.js";
import { computeBarFeatures, computeBarNovelty, segmentBars } from "../structure.js";
import { synthesizeBeatTrack } from "./synthesize.js";

describe("analyzeTrack", () => {
  it("recovers the tempo and a regular grid from a synthetic 4/4 track", () => {
    const { samples, sampleRate, beatTimes } = synthesizeBeatTrack({ bpm: 128, bars: 32 });
    const analysis = analyzeTrack(samples, sampleRate);

    expect(analysis.bpm).toBeGreaterThan(127.5);
    expect(analysis.bpm).toBeLessThan(128.5);

    // The emitted grid is a single line, not the tracker's wandering peaks.
    const intervals = [...analysis.beatTimes].slice(1).map((time, index) => time - analysis.beatTimes[index]);
    const spread = Math.max(...intervals) - Math.min(...intervals);
    expect(spread).toBeLessThan(1e-9);

    // And it lands on the real beats rather than between them.
    const period = analysis.periodSeconds;
    const phase = ((analysis.beatTimes[0] - beatTimes[0]) / period) % 1;
    const wrapped = Math.min(((phase % 1) + 1) % 1, 1 - (((phase % 1) + 1) % 1));
    expect(wrapped).toBeLessThan(0.08);
  });

  it("keeps the grid on the beat when offbeat hats are louder than the kick", () => {
    const { samples, sampleRate, beatTimes } = synthesizeBeatTrack({
      bpm: 130,
      bars: 32,
      offbeatHats: true
    });
    const analysis = analyzeTrack(samples, sampleRate);
    const phase = ((analysis.beatTimes[0] - beatTimes[0]) / analysis.periodSeconds) % 1;
    const wrapped = Math.min(((phase % 1) + 1) % 1, 1 - (((phase % 1) + 1) % 1));
    expect(wrapped).toBeLessThan(0.08);
  });

  it("tolerates a silent lead-in", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({ bpm: 124, bars: 24, leadInSeconds: 2.5 });
    const analysis = analyzeTrack(samples, sampleRate);
    expect(analysis.bpm).toBeGreaterThan(123.5);
    expect(analysis.bpm).toBeLessThan(124.5);
  });

  it("reports energy on the 1-10 scale and rates a sparse section lower", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({
      bpm: 126,
      bars: 48,
      quietBars: (bar) => bar >= 16 && bar < 32
    });
    const analysis = analyzeTrack(samples, sampleRate);

    for (const energy of analysis.barEnergy) {
      expect(energy).toBeGreaterThanOrEqual(1);
      expect(energy).toBeLessThanOrEqual(10);
    }
    const mean = (start: number, end: number): number => {
      let total = 0;
      for (let bar = start; bar < end; bar += 1) {
        total += analysis.barEnergy[bar] ?? 0;
      }
      return total / (end - start);
    };
    expect(mean(18, 30)).toBeLessThan(mean(2, 14));
  });
});

describe("segmentBars", () => {
  const buildBars = (barCount: number) => {
    const { samples, sampleRate } = synthesizeBeatTrack({
      bpm: 128,
      bars: barCount,
      quietBars: (bar) => bar >= 32 && bar < 48
    });
    const analysis = analyzeTrack(samples, sampleRate);
    return { analysis, bars: analysis.bars };
  };

  it("does not shatter into the shortest legal phrase", () => {
    // Regression: the objective rewarded homogeneity per segment, so the total
    // grew with the number of segments and the optimum was 4 bars everywhere.
    const { bars } = buildBars(96);
    const novelty = computeBarNovelty(bars);
    const segments = segmentBars(bars, novelty, 0);
    const fourBarSegments = segments.filter((segment) => segment.endBar - segment.startBar === 4);
    expect(fourBarSegments.length / segments.length).toBeLessThan(0.5);
    expect(segments.length).toBeLessThan(bars.barCount / 6);
  });

  it("puts every boundary on the phrase grid", () => {
    const { bars } = buildBars(96);
    const novelty = computeBarNovelty(bars);
    for (const originBar of [0, 2, 5, 7]) {
      const segments = segmentBars(bars, novelty, originBar);
      // The lead-in segment aside, boundaries sit at originBar + a multiple
      // of four bars, which is what keeps phrase changes on a downbeat.
      for (const segment of segments.slice(1)) {
        expect((segment.startBar - (originBar % 8)) % 4).toBe(0);
      }
    }
  });

  it("covers the whole track with contiguous segments", () => {
    const { bars } = buildBars(72);
    const segments = segmentBars(bars, computeBarNovelty(bars), 3);
    expect(segments[0].startBar).toBe(0);
    expect(segments[segments.length - 1].endBar).toBe(bars.barCount);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].startBar).toBe(segments[index - 1].endBar);
    }
  });
});

describe("computeBarFeatures", () => {
  it("normalises every column into 0-1", () => {
    const { samples, sampleRate } = synthesizeBeatTrack({
      bpm: 130,
      bars: 48,
      quietBars: (bar) => bar >= 16 && bar < 24
    });
    const analysis = analyzeTrack(samples, sampleRate);
    const bars = computeBarFeatures(analysis.beats, analysis.beatTimes, analysis.downbeatOffset);
    for (const value of bars.values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
