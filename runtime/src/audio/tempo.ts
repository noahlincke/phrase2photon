import { Fft } from "./fft.js";
import { sampleAt, type OnsetEnvelope } from "./odf.js";

/**
 * Tempo estimation by harmonic-comb scoring of the onset autocorrelation.
 *
 * A plain autocorrelation peak cannot give sub-BPM precision at this hop size
 * (one lag frame is ~3 BPM at 128 BPM), so the comb sums correlation at many
 * multiples of the candidate period. An error in the period is multiplied by
 * the comb order at the far teeth, which sharpens the peak by roughly that
 * factor and simultaneously resolves the half/double ambiguity.
 */

export const MIN_BPM = 60;
export const MAX_BPM = 200;

/** Tempo range that dominates house and techno, used only to break ties. */
const PRIOR_CENTER_BPM = 126;
const PRIOR_WIDTH_OCTAVES = 0.9;

const COMB_TEETH = 24;
const COMB_HARMONIC_WEIGHTS = [1, 0.62, 0.42, 0.3];

export interface TempoCandidate {
  bpm: number;
  score: number;
}

export interface TempoEstimate {
  bpm: number;
  /** 0-1 confidence: how far the winner stands above the runner-up octave. */
  confidence: number;
  candidates: TempoCandidate[];
}

/** Biased autocorrelation of an onset envelope, computed via FFT. */
export function onsetAutocorrelation(envelope: OnsetEnvelope, maxLagFrames: number): Float32Array {
  const values = envelope.values;
  const count = values.length;
  if (!count) {
    return new Float32Array(0);
  }

  const size = nextPowerOfTwo(Math.max(2, count + maxLagFrames + 1) * 2);
  const fft = new Fft(size);
  const real = new Float32Array(size);
  const imag = new Float32Array(size);

  let mean = 0;
  for (let index = 0; index < count; index += 1) {
    mean += values[index];
  }
  mean /= count;
  for (let index = 0; index < count; index += 1) {
    real[index] = values[index] - mean;
  }

  fft.transform(real, imag);
  for (let index = 0; index < size; index += 1) {
    const power = real[index] * real[index] + imag[index] * imag[index];
    real[index] = power;
    imag[index] = 0;
  }
  // The power spectrum is real and even, so its forward transform already
  // equals the (unnormalised) circular autocorrelation. Normalising by lag 0
  // cancels the missing 1/N factor.
  fft.transform(real, imag);

  const lagCount = Math.min(maxLagFrames + 1, count);
  const correlation = new Float32Array(lagCount);
  const normalizer = real[0] !== 0 ? real[0] : 1;
  for (let lag = 0; lag < lagCount; lag += 1) {
    correlation[lag] = real[lag] / normalizer;
  }
  return correlation;
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) {
    size <<= 1;
  }
  return size;
}

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
}

/** Comb score for a candidate beat period expressed in frames. */
export function combScore(correlation: Float32Array, periodFrames: number, teeth = COMB_TEETH): number {
  if (periodFrames < 2) {
    return 0;
  }
  let total = 0;
  let weight = 0;
  for (let tooth = 1; tooth <= teeth; tooth += 1) {
    const lag = periodFrames * tooth;
    if (lag >= correlation.length - 1) {
      break;
    }
    // Later teeth carry more positional information but less energy; weight
    // them so the sharp long-lag agreement still drives the peak location.
    const toothWeight = 1 / Math.sqrt(tooth);
    total += toothWeight * sampleAt(correlation, lag);
    weight += toothWeight;
  }
  if (weight <= 0) {
    return 0;
  }
  let score = total / weight;

  // Reward candidates whose sub-multiples are *not* equally strong: a true
  // beat period has a strong bar-level structure above it, whereas a doubled
  // (eighth-note) candidate has an equally strong half-period.
  for (let harmonic = 1; harmonic < COMB_HARMONIC_WEIGHTS.length; harmonic += 1) {
    const lag = periodFrames / (harmonic + 1);
    if (lag < 2) {
      break;
    }
    score -= COMB_HARMONIC_WEIGHTS[harmonic] * 0.25 * Math.max(0, sampleAt(correlation, lag));
  }
  return score;
}

export function estimateTempo(
  envelope: OnsetEnvelope,
  options: { minBpm?: number; maxBpm?: number; combTeeth?: number } = {}
): TempoEstimate {
  const minBpm = options.minBpm ?? MIN_BPM;
  const maxBpm = options.maxBpm ?? MAX_BPM;
  // Live analysis works from a short rolling window, where the far comb teeth
  // would sit at lags with too little overlap to be meaningful.
  const teeth = Math.max(4, Math.min(COMB_TEETH, options.combTeeth ?? COMB_TEETH));
  const frameRate = envelope.frameRate;
  const maxLagFrames = Math.ceil((60 / minBpm) * frameRate * (teeth + 1));
  const correlation = onsetAutocorrelation(envelope, maxLagFrames);
  if (correlation.length < 4) {
    return { bpm: PRIOR_CENTER_BPM, confidence: 0, candidates: [] };
  }

  // Coarse sweep at 0.25 BPM, then a fine local sweep around each peak.
  const coarse: TempoCandidate[] = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const periodFrames = (60 / bpm) * frameRate;
    coarse.push({ bpm, score: combScore(correlation, periodFrames, teeth) * tempoPrior(bpm) });
  }

  const peaks = coarse
    .filter((candidate, index) => {
      const previous = coarse[index - 1];
      const next = coarse[index + 1];
      return (!previous || candidate.score >= previous.score) && (!next || candidate.score >= next.score);
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const refined = peaks.map((peak) => {
    let best = peak;
    for (let bpm = peak.bpm - 0.3; bpm <= peak.bpm + 0.3; bpm += 0.01) {
      if (bpm < minBpm || bpm > maxBpm) {
        continue;
      }
      const periodFrames = (60 / bpm) * frameRate;
      const score = combScore(correlation, periodFrames, teeth) * tempoPrior(bpm);
      if (score > best.score) {
        best = { bpm, score };
      }
    }
    return best;
  });

  refined.sort((left, right) => right.score - left.score);
  const winner = refined[0] ?? { bpm: PRIOR_CENTER_BPM, score: 0 };
  const runnerUp = refined.find((candidate) => Math.abs(Math.log2(candidate.bpm / winner.bpm)) > 0.08);
  const confidence = runnerUp && winner.score > 0
    ? Math.max(0, Math.min(1, 1 - runnerUp.score / winner.score))
    : winner.score > 0
      ? 1
      : 0;

  return { bpm: winner.bpm, confidence, candidates: refined };
}
