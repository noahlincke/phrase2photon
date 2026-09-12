import { describe, expect, it } from "vitest";

import { Fft, hannWindow } from "../fft.js";
import { FRAME_SIZE, HOP_SIZE, BAND_COUNT, analyzeBuffer } from "../spectral.js";
import { normalizeOnsetEnvelope, sampleAt } from "../odf.js";
import { estimateTempo } from "../tempo.js";

describe("Fft", () => {
  it("matches a naive DFT", () => {
    const size = 64;
    const fft = new Fft(size);
    const input = Float32Array.from({ length: size }, (_, index) =>
      Math.sin((2 * Math.PI * 5 * index) / size) + 0.4 * Math.cos((2 * Math.PI * 11 * index) / size)
    );

    const real = new Float32Array(size);
    const imag = new Float32Array(size);
    const magnitudes = new Float32Array(size / 2 + 1);
    fft.magnitudes(input, real, imag, magnitudes);

    for (let bin = 0; bin <= size / 2; bin += 1) {
      let expectedReal = 0;
      let expectedImag = 0;
      for (let index = 0; index < size; index += 1) {
        const angle = (-2 * Math.PI * bin * index) / size;
        expectedReal += input[index] * Math.cos(angle);
        expectedImag += input[index] * Math.sin(angle);
      }
      expect(magnitudes[bin]).toBeCloseTo(Math.hypot(expectedReal, expectedImag), 2);
    }
  });

  it("rejects non-power-of-two sizes", () => {
    expect(() => new Fft(100)).toThrow(/power of two/);
  });

  it("builds a periodic Hann window", () => {
    const window = hannWindow(8);
    expect(window[0]).toBeCloseTo(0, 6);
    expect(window[4]).toBeCloseTo(1, 6);
  });
});

describe("analyzeBuffer", () => {
  const sampleRate = 44100;

  it("centres frame timestamps on their window", () => {
    const features = analyzeBuffer(new Float32Array(sampleRate), sampleRate);
    // Frame 0 covers the first FRAME_SIZE samples, so its centre is half a
    // window in. Getting this wrong put every tracked beat 23 ms early.
    expect(features.times[0]).toBeCloseTo(FRAME_SIZE / 2 / sampleRate, 6);
    expect(features.times[1] - features.times[0]).toBeCloseTo(HOP_SIZE / sampleRate, 6);
    expect(features.frameRate).toBeCloseTo(sampleRate / HOP_SIZE, 6);
  });

  it("emits one band row per frame", () => {
    const features = analyzeBuffer(new Float32Array(sampleRate * 2), sampleRate);
    expect(features.bands.length).toBe(features.frameCount * BAND_COUNT);
    expect(features.flux.length).toBe(features.frameCount);
  });

  it("places energy in the band containing the tone", () => {
    const tone = Float32Array.from({ length: sampleRate }, (_, index) =>
      Math.sin((2 * Math.PI * 60 * index) / sampleRate)
    );
    const features = analyzeBuffer(tone, sampleRate);
    const frame = Math.floor(features.frameCount / 2);
    const row = features.bands.subarray(frame * BAND_COUNT, (frame + 1) * BAND_COUNT);
    let loudest = 0;
    for (let band = 1; band < BAND_COUNT; band += 1) {
      if (row[band] > row[loudest]) {
        loudest = band;
      }
    }
    // 60 Hz falls in the third of 24 log-spaced bands from 30 Hz.
    expect(loudest).toBeLessThanOrEqual(4);
  });
});

describe("normalizeOnsetEnvelope", () => {
  it("removes a slow loudness trend", () => {
    const frameRate = 86;
    const count = frameRate * 20;
    // Impulses of constant height on a rising background.
    const raw = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      raw[index] = (index / count) * 10;
      if (index % 40 === 0) {
        raw[index] += 5;
      }
    }
    const envelope = normalizeOnsetEnvelope(raw, frameRate, 0);
    // Sample actual impulse frames, which sit on multiples of 40.
    const early = envelope.values[240];
    const late = envelope.values[1360];
    // Both are impulse frames; after normalisation they should be comparable
    // rather than the later one dominating because the track got louder.
    expect(early).toBeGreaterThan(0.5);
    expect(Math.abs(early - late) / Math.max(early, late)).toBeLessThan(0.35);
  });

  it("interpolates between frames", () => {
    const values = Float32Array.from([0, 1, 2]);
    expect(sampleAt(values, 0.5)).toBeCloseTo(0.5, 6);
    expect(sampleAt(values, -3)).toBe(0);
    expect(sampleAt(values, 99)).toBe(2);
  });
});

describe("estimateTempo", () => {
  it("finds the pulse rate of a synthetic onset train", () => {
    const frameRate = 86.13;
    const bpm = 128;
    const period = (60 / bpm) * frameRate;
    const count = Math.round(frameRate * 60);
    const values = new Float32Array(count);
    for (let beat = 0; beat * period < count; beat += 1) {
      const index = Math.round(beat * period);
      if (index < count) {
        values[index] = 1;
      }
    }
    const estimate = estimateTempo({ frameRate, firstFrameSeconds: 0, values });
    expect(estimate.bpm).toBeGreaterThan(bpm - 1);
    expect(estimate.bpm).toBeLessThan(bpm + 1);
  });

  it("prefers the beat rate over the eighth-note rate", () => {
    const frameRate = 86.13;
    const bpm = 124;
    const period = (60 / bpm) * frameRate;
    const count = Math.round(frameRate * 60);
    const values = new Float32Array(count);
    for (let half = 0; (half * period) / 2 < count; half += 1) {
      const index = Math.round((half * period) / 2);
      if (index < count) {
        // Offbeats present but weaker, as with hats under a kick.
        values[index] = half % 2 === 0 ? 1 : 0.45;
      }
    }
    const estimate = estimateTempo({ frameRate, firstFrameSeconds: 0, values });
    expect(estimate.bpm).toBeGreaterThan(bpm - 1.5);
    expect(estimate.bpm).toBeLessThan(bpm + 1.5);
  });
});
