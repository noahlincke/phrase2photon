/**
 * Synthetic audio for analysis tests.
 *
 * Real tracks are validated by the offline Mixed In Key harness; these helpers
 * exist so the unit tests can assert exact, known-answer behaviour (a click at
 * a known tempo really is at that tempo) without shipping audio fixtures.
 */

export interface SynthesizeOptions {
  bpm: number;
  bars: number;
  sampleRate?: number;
  /** Bars where the bass drops out, to create a structural boundary. */
  quietBars?: (bar: number) => boolean;
  /** Add offbeat hats, which is what makes offbeat locking possible. */
  offbeatHats?: boolean;
  /** Seconds of silence before the first beat. */
  leadInSeconds?: number;
}

export function synthesizeBeatTrack(options: SynthesizeOptions): {
  samples: Float32Array;
  sampleRate: number;
  beatTimes: number[];
} {
  const sampleRate = options.sampleRate ?? 44100;
  const period = 60 / options.bpm;
  const leadIn = options.leadInSeconds ?? 0;
  const totalBeats = options.bars * 4;
  const duration = leadIn + totalBeats * period + 1;
  const samples = new Float32Array(Math.ceil(duration * sampleRate));
  const beatTimes: number[] = [];

  // Deterministic noise so tests do not depend on Math.random.
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x3fffffff) - 1;
  };

  const addKick = (startSeconds: number, gain: number): void => {
    const start = Math.floor(startSeconds * sampleRate);
    const length = Math.floor(0.12 * sampleRate);
    for (let index = 0; index < length; index += 1) {
      const target = start + index;
      if (target < 0 || target >= samples.length) {
        continue;
      }
      const time = index / sampleRate;
      const envelope = Math.exp(-time * 32);
      // Pitch-dropping sine: the standard shape of a dance-music kick.
      const frequency = 55 + 90 * Math.exp(-time * 55);
      samples[target] += gain * envelope * Math.sin(2 * Math.PI * frequency * time);
    }
  };

  const addHat = (startSeconds: number, gain: number): void => {
    const start = Math.floor(startSeconds * sampleRate);
    const length = Math.floor(0.03 * sampleRate);
    for (let index = 0; index < length; index += 1) {
      const target = start + index;
      if (target < 0 || target >= samples.length) {
        continue;
      }
      samples[target] += gain * Math.exp(-(index / sampleRate) * 260) * noise() * 0.5;
    }
  };

  for (let beat = 0; beat < totalBeats; beat += 1) {
    const time = leadIn + beat * period;
    beatTimes.push(time);
    const bar = Math.floor(beat / 4);
    const quiet = options.quietBars?.(bar) ?? false;
    if (!quiet) {
      addKick(time, 0.9);
    }
    // A clap on beats 2 and 4 gives the bar phase a real signature.
    if (beat % 4 === 1 || beat % 4 === 3) {
      addHat(time, quiet ? 0.5 : 0.8);
    }
    addHat(time + period / 2, options.offbeatHats ? 0.85 : 0.25);
  }

  return { samples, sampleRate, beatTimes };
}
