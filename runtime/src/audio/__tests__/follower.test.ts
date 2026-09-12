import { describe, expect, it } from "vitest";

import { PositionFollower, buildFollowPrint, snapLoopBeats } from "../follower.js";
import { SpectralAnalyzer, analyzeBuffer } from "../spectral.js";

const SAMPLE_RATE = 44100;
const BPM = 128;
const BEAT_SECONDS = 60 / BPM;
const BARS = 24;

/**
 * A track whose every bar sounds different.
 *
 * A plain four-to-the-floor loop is self-similar by construction, so no
 * follower could tell bar 3 from bar 11 - and one that claimed to would be
 * lying. Giving each bar its own chord and its own hat pattern is what real
 * arrangements do, and is the thing position matching actually keys off.
 */
function synthesizeVariedTrack(bars: number): Float32Array {
  const duration = bars * 4 * BEAT_SECONDS + 1;
  const samples = new Float32Array(Math.ceil(duration * SAMPLE_RATE));

  let seed = 987654321;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };

  const addKick = (startSeconds: number): void => {
    const start = Math.floor(startSeconds * SAMPLE_RATE);
    const length = Math.floor(0.12 * SAMPLE_RATE);
    for (let index = 0; index < length; index += 1) {
      const target = start + index;
      if (target < 0 || target >= samples.length) continue;
      const time = index / SAMPLE_RATE;
      const frequency = 55 + 90 * Math.exp(-time * 55);
      samples[target] += 0.9 * Math.exp(-time * 32) * Math.sin(2 * Math.PI * frequency * time);
    }
  };

  const addTone = (startSeconds: number, frequency: number, seconds: number, gain: number): void => {
    const start = Math.floor(startSeconds * SAMPLE_RATE);
    const length = Math.floor(seconds * SAMPLE_RATE);
    for (let index = 0; index < length; index += 1) {
      const target = start + index;
      if (target < 0 || target >= samples.length) continue;
      const time = index / SAMPLE_RATE;
      const envelope = Math.min(1, time * 40) * Math.exp(-time * 1.5);
      samples[target] += gain * envelope * Math.sin(2 * Math.PI * frequency * time);
    }
  };

  const addHat = (startSeconds: number, gain: number): void => {
    const start = Math.floor(startSeconds * SAMPLE_RATE);
    const length = Math.floor(0.03 * SAMPLE_RATE);
    for (let index = 0; index < length; index += 1) {
      const target = start + index;
      if (target < 0 || target >= samples.length) continue;
      samples[target] += gain * Math.exp(-(index / SAMPLE_RATE) * 260) * noise() * 0.5;
    }
  };

  // Every bar gets its own chord, drawn so that no two bars in the track share
  // one, plus a hat pattern keyed to the bar. Position matching has nothing to
  // work with otherwise, and neither would a human listener.
  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * 4 * BEAT_SECONDS;
    const root = 90 * Math.pow(2, ((bar * 5) % 12) / 12) * (1 + 0.25 * (bar % 4));
    addTone(barStart, root, 4 * BEAT_SECONDS, 0.35);
    addTone(barStart, root * (bar % 2 === 0 ? 1.5 : 1.26), 4 * BEAT_SECONDS, 0.3);
    addTone(barStart + 2 * BEAT_SECONDS, root * (2 + (bar % 5) * 0.3), 2 * BEAT_SECONDS, 0.28);
    addTone(barStart + BEAT_SECONDS, root * (3 + (bar % 7) * 0.4), BEAT_SECONDS, 0.22);
    for (let beat = 0; beat < 4; beat += 1) {
      addKick(barStart + beat * BEAT_SECONDS);
      for (let sixteenth = 0; sixteenth < 4; sixteenth += 1) {
        if ((bar * 4 + beat + sixteenth) % 3 === 0) {
          continue;
        }
        addHat(
          barStart + beat * BEAT_SECONDS + (sixteenth * BEAT_SECONDS) / 4,
          0.15 + 0.12 * ((bar + sixteenth) % 4)
        );
      }
    }
  }
  return samples;
}

/** Feeds a slice of the track through the follower and returns every status. */
function feed(
  follower: PositionFollower,
  analyzer: SpectralAnalyzer,
  samples: Float32Array,
  fromSeconds: number,
  toSeconds: number
): ReturnType<PositionFollower["pushColumn"]>[] {
  const start = Math.max(0, Math.floor(fromSeconds * SAMPLE_RATE));
  const end = Math.min(samples.length, Math.floor(toSeconds * SAMPLE_RATE));
  const statuses: ReturnType<PositionFollower["pushColumn"]>[] = [];
  analyzer.push(samples.subarray(start, end), (frame) => {
    statuses.push(follower.pushFrame(frame.bands));
  });
  return statuses;
}

function makeFollower(samples: Float32Array): {
  follower: PositionFollower;
  analyzer: SpectralAnalyzer;
} {
  const print = buildFollowPrint(analyzeBuffer(samples, SAMPLE_RATE), { tempo: BPM });
  return { follower: new PositionFollower(print), analyzer: new SpectralAnalyzer(SAMPLE_RATE) };
}

describe("snapLoopBeats", () => {
  it("recognises the loop lengths a DJ can dial in", () => {
    expect(snapLoopBeats(-4)).toBe(4);
    expect(snapLoopBeats(-8.4)).toBe(8);
    expect(snapLoopBeats(-1.03)).toBe(1);
    expect(snapLoopBeats(-0.26)).toBe(0.25);
    expect(snapLoopBeats(-32)).toBe(32);
  });

  it("rejects jumps that are not a loop length", () => {
    expect(snapLoopBeats(-5.5)).toBeNull();
    expect(snapLoopBeats(-13)).toBeNull();
    expect(snapLoopBeats(-100)).toBeNull();
  });
});

describe("PositionFollower", () => {
  it("finds where in the track the audio is coming from", () => {
    const samples = synthesizeVariedTrack(BARS);
    const { follower, analyzer } = makeFollower(samples);

    // Start playback part-way in; the follower is told nothing about where.
    const entrySeconds = 20;
    const statuses = feed(follower, analyzer, samples, entrySeconds, entrySeconds + 8);
    const final = statuses[statuses.length - 1];

    expect(final.state).toBe("tracking");
    expect(final.confidence).toBeGreaterThan(0.5);
    expect(final.positionSeconds).toBeCloseTo(entrySeconds + 8, 0);
  });

  it("stays locked while the track plays through", () => {
    const samples = synthesizeVariedTrack(BARS);
    const { follower, analyzer } = makeFollower(samples);

    const statuses = feed(follower, analyzer, samples, 10, 30);
    const tracked = statuses.filter((status) => status.state === "tracking");
    expect(tracked.length).toBeGreaterThan(statuses.length * 0.6);

    const final = statuses[statuses.length - 1];
    expect(final.positionSeconds).toBeCloseTo(30, 0);
    expect(final.loop).toBeNull();
  });

  it("reports a four-beat loop when the deck loops", () => {
    const samples = synthesizeVariedTrack(BARS);
    const { follower, analyzer } = makeFollower(samples);

    const loopStart = 16;
    const loopEnd = loopStart + 4 * BEAT_SECONDS;

    // Play in, then repeat the same four beats the way a looping deck would.
    feed(follower, analyzer, samples, 8, loopEnd);
    const statuses = [
      ...feed(follower, analyzer, samples, loopStart, loopEnd),
      ...feed(follower, analyzer, samples, loopStart, loopEnd)
    ];

    const loopJump = statuses.find((status) => status.jump?.kind === "loop");
    expect(loopJump).toBeDefined();
    expect(loopJump?.jump?.beats).toBeCloseTo(-4, 0);

    const looping = statuses.filter((status) => status.loop !== null);
    expect(looping.length).toBeGreaterThan(0);
    expect(looping[looping.length - 1].loop?.beats).toBe(4);
  });

  it("calls a jump to an unrelated part of the track a seek, not a loop", () => {
    const samples = synthesizeVariedTrack(BARS);
    const { follower, analyzer } = makeFollower(samples);

    feed(follower, analyzer, samples, 8, 20);
    const statuses = feed(follower, analyzer, samples, 38, 46);

    const jump = statuses.find((status) => status.jump !== null);
    expect(jump).toBeDefined();
    expect(jump?.jump?.kind).toBe("seek");
    expect(statuses[statuses.length - 1].loop).toBeNull();
  });

  it("does not invent a position from audio that is not the track", () => {
    const samples = synthesizeVariedTrack(BARS);
    const { follower, analyzer } = makeFollower(samples);

    let seed = 24680;
    const unrelated = new Float32Array(SAMPLE_RATE * 8);
    for (let index = 0; index < unrelated.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      unrelated[index] = (seed / 0x3fffffff - 1) * 0.4;
    }

    const statuses = feed(follower, analyzer, unrelated, 0, 8);
    const final = statuses[statuses.length - 1];
    expect(final.state).not.toBe("tracking");
  });

  it("survives a pitch fader", () => {
    const samples = synthesizeVariedTrack(BARS);
    const print = buildFollowPrint(analyzeBuffer(samples, SAMPLE_RATE), { tempo: BPM });
    const follower = new PositionFollower(print);
    const analyzer = new SpectralAnalyzer(SAMPLE_RATE);

    // Resample by 4% to stand in for a deck running fast, and tell the
    // follower the rate the way the live tempo estimate would.
    const rate = 1.04;
    const fast = new Float32Array(Math.floor(samples.length / rate));
    for (let index = 0; index < fast.length; index += 1) {
      const source = index * rate;
      const lower = Math.floor(source);
      const fraction = source - lower;
      fast[index] = (samples[lower] ?? 0) * (1 - fraction) + (samples[lower + 1] ?? 0) * fraction;
    }
    follower.setRateHint(rate);

    const statuses = feed(follower, analyzer, fast, 12 / rate, 26 / rate);
    const final = statuses[statuses.length - 1];
    expect(final.state).toBe("tracking");
    expect(final.positionSeconds).toBeCloseTo(26, 0);
  });
});
