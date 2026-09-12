import { sampleAt, type OnsetEnvelope } from "./odf.js";
import { BAND_COUNT, type SpectralFeatures } from "./spectral.js";

/**
 * Beat and downbeat tracking.
 *
 * Beats come from Ellis-style dynamic programming over the onset envelope,
 * which finds the globally best regular beat sequence rather than chasing
 * local peaks. The tempo is then re-derived from the tracked beats, because a
 * regression over hundreds of beats is far more precise than any periodicity
 * estimate at this hop size.
 */

const DP_TIGHTNESS = 120;

/**
 * Dynamic-programming beat tracker.
 *
 * Scores every frame as a candidate beat, where the transition cost punishes
 * inter-beat intervals that deviate from the target period on a log scale.
 */
export function trackBeats(envelope: OnsetEnvelope, periodSeconds: number): Float64Array {
  const values = envelope.values;
  const count = values.length;
  const period = periodSeconds * envelope.frameRate;
  if (count < 4 || period < 2) {
    return new Float64Array(0);
  }

  const searchStart = Math.max(1, Math.round(period * 0.5));
  const searchEnd = Math.max(searchStart + 1, Math.round(period * 2));

  // Precompute the transition penalty for every candidate interval.
  const penalty = new Float32Array(searchEnd + 1);
  for (let interval = searchStart; interval <= searchEnd; interval += 1) {
    const ratio = Math.log(interval / period);
    penalty[interval] = -DP_TIGHTNESS * ratio * ratio;
  }

  const cumulative = new Float32Array(count);
  const backlink = new Int32Array(count).fill(-1);

  for (let index = 0; index < count; index += 1) {
    let bestScore = 0;
    let bestPrevious = -1;
    const from = Math.max(0, index - searchEnd);
    const to = index - searchStart;
    for (let previous = from; previous <= to; previous += 1) {
      const score = cumulative[previous] + penalty[index - previous];
      if (score > bestScore) {
        bestScore = score;
        bestPrevious = previous;
      }
    }
    cumulative[index] = values[index] + (bestPrevious >= 0 ? bestScore : 0);
    backlink[index] = bestPrevious;
  }

  // Start the backtrace from the best scoring frame in the final period, so a
  // loud fade-out cannot pull the chain off the grid.
  let endIndex = count - 1;
  let endScore = -Infinity;
  for (let index = Math.max(0, count - Math.round(period * 2)); index < count; index += 1) {
    if (cumulative[index] > endScore) {
      endScore = cumulative[index];
      endIndex = index;
    }
  }

  const reversed: number[] = [];
  for (let index = endIndex; index >= 0; index = backlink[index]) {
    reversed.push(index);
    if (backlink[index] < 0) {
      break;
    }
  }
  reversed.reverse();

  const beatTimes = new Float64Array(reversed.length);
  for (let index = 0; index < reversed.length; index += 1) {
    beatTimes[index] = envelope.firstFrameSeconds + reversed[index] / envelope.frameRate;
  }
  return beatTimes;
}

/**
 * Robust period estimate from tracked beats.
 *
 * Uses the median of long-span differences rather than adjacent intervals, so
 * micro-timing jitter and the occasional misplaced beat do not move it.
 */
export function refinePeriodFromBeats(beatTimes: Float64Array, fallbackSeconds: number): number {
  if (beatTimes.length < 8) {
    return fallbackSeconds;
  }
  const span = Math.min(64, beatTimes.length - 1);
  const ratios: number[] = [];
  for (let index = 0; index + span < beatTimes.length; index += 1) {
    ratios.push((beatTimes[index + span] - beatTimes[index]) / span);
  }
  if (!ratios.length) {
    return fallbackSeconds;
  }
  ratios.sort((left, right) => left - right);
  return ratios[Math.floor(ratios.length / 2)];
}

export interface RegularGrid {
  /** Time of beat 0 of the emitted grid, seconds. */
  originSeconds: number;
  periodSeconds: number;
  bpm: number;
  beatTimes: Float64Array;
}

/**
 * Fits a perfectly regular beat grid to the tracked beats.
 *
 * The dynamic-programming tracker snaps each beat to a local onset peak and
 * quantises it to the analysis hop, which leaves several percent of jitter.
 * Produced dance music does not actually drift, so modelling the grid as a
 * single line is both more accurate and what downstream visuals need - a
 * jittering grid reads as stutter even when every beat is within tolerance.
 *
 * Phase and period are refined together against the onset envelope, because
 * over a six-minute track a 0.03 BPM period error accumulates into tens of
 * milliseconds of drift at the ends.
 */
export function fitRegularGrid(
  trackedBeats: Float64Array,
  envelope: OnsetEnvelope,
  periodSeconds: number,
  durationSeconds: number,
  kickEnvelope: OnsetEnvelope | null = null,
  halfBeatMargin = 1
): RegularGrid {
  let period = periodSeconds;
  let origin = trackedBeats[0] ?? 0;

  if (trackedBeats.length >= 8) {
    // Two rounds of least squares with outlier rejection: beat indices come
    // from the current fit, so rejecting bad beats improves the next fit.
    for (let pass = 0; pass < 2; pass += 1) {
      let sumIndex = 0;
      let sumTime = 0;
      let sumIndexSquared = 0;
      let sumProduct = 0;
      let used = 0;
      for (const time of trackedBeats) {
        const index = Math.round((time - origin) / period);
        const residual = Math.abs(time - (origin + index * period));
        if (pass > 0 && residual > period * 0.25) {
          continue;
        }
        sumIndex += index;
        sumTime += time;
        sumIndexSquared += index * index;
        sumProduct += index * time;
        used += 1;
      }
      if (used < 4) {
        break;
      }
      const denominator = used * sumIndexSquared - sumIndex * sumIndex;
      if (Math.abs(denominator) < 1e-9) {
        break;
      }
      const slope = (used * sumProduct - sumIndex * sumTime) / denominator;
      const intercept = (sumTime - slope * sumIndex) / used;
      // Guard against a degenerate fit collapsing the tempo.
      if (slope > period * 0.8 && slope < period * 1.25) {
        period = slope;
        origin = intercept;
      }
    }
  }

  // Polish phase and period against the onset envelope by coordinate ascent.
  const combStrength = (candidateOrigin: number, candidatePeriod: number): number => {
    let total = 0;
    let count = 0;
    for (let time = candidateOrigin; time <= durationSeconds; time += candidatePeriod) {
      if (time < 0) {
        continue;
      }
      total += sampleAt(envelope.values, (time - envelope.firstFrameSeconds) * envelope.frameRate);
      count += 1;
    }
    return count ? total / Math.sqrt(count) : 0;
  };

  for (let pass = 0; pass < 3; pass += 1) {
    let bestOrigin = origin;
    let bestScore = combStrength(origin, period);
    // Polish only: search a small neighbourhood of the least-squares phase.
    // A full-period sweep would be free to relocate onto the offbeat, which
    // scores well in techno because of open hats, and the tracker has already
    // resolved the on-beat phase correctly.
    const phaseStep = period / 400;
    for (let step = -50; step <= 50; step += 1) {
      const candidate = origin + step * phaseStep;
      const score = combStrength(candidate, period);
      if (score > bestScore) {
        bestScore = score;
        bestOrigin = candidate;
      }
    }
    origin = bestOrigin;

    let bestPeriod = period;
    for (let step = -120; step <= 120; step += 1) {
      const candidate = period * (1 + step * 0.00004);
      const score = combStrength(origin, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestPeriod = candidate;
      }
    }
    if (bestPeriod === period) {
      break;
    }
    period = bestPeriod;
  }

  // Resolve the on-beat / offbeat ambiguity against the kick band.
  //
  // Open hats and offbeat basslines can make the offbeat the stronger
  // broadband onset, and the tracker then locks half a beat late. The kick is
  // what a listener hears as beat 1, so it gets the deciding vote - but only
  // with a margin, so genres without a kick on every beat are left alone.
  if (kickEnvelope) {
    const kickStrength = (candidateOrigin: number): number => {
      let total = 0;
      let count = 0;
      for (let time = candidateOrigin; time <= durationSeconds; time += period) {
        if (time < 0) {
          continue;
        }
        total += sampleAt(kickEnvelope.values, (time - kickEnvelope.firstFrameSeconds) * kickEnvelope.frameRate);
        count += 1;
      }
      return count ? total / count : 0;
    };
    const onBeat = kickStrength(origin);
    const offBeat = kickStrength(origin + period / 2);
    if (offBeat > onBeat * halfBeatMargin) {
      origin += period / 2;
    }
  }

  // Emit the grid from the first beat at or after zero.
  const firstIndex = Math.ceil(-origin / period);
  const start = origin + firstIndex * period;
  const count = Math.max(0, Math.floor((durationSeconds - start) / period) + 1);
  const beatTimes = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    beatTimes[index] = start + index * period;
  }

  return { originSeconds: start, periodSeconds: period, bpm: 60 / period, beatTimes };
}

export interface BeatFeatures {
  count: number;
  /** Kick-band onset strength at each beat. */
  lowOnset: Float32Array;
  /** Air-band onset strength at each beat. */
  highOnset: Float32Array;
  /** Mid-band onset strength at each beat. */
  midOnset: Float32Array;
  /** Mean loudness across each beat. */
  rms: Float32Array;
  /** `count * BAND_COUNT` mean band energies per beat, row-major. */
  bands: Float32Array;
}

export function computeBeatFeatures(
  features: SpectralFeatures,
  beatTimes: Float64Array,
  periodSeconds: number
): BeatFeatures {
  const count = beatTimes.length;
  const lowOnset = new Float32Array(count);
  const highOnset = new Float32Array(count);
  const midOnset = new Float32Array(count);
  const rms = new Float32Array(count);
  const bands = new Float32Array(count * BAND_COUNT);
  const frameRate = features.frameRate;

  // Onsets are sampled in a short window bracketing the beat; band energies
  // average the whole beat so they describe timbre rather than transients.
  const onsetBefore = Math.round(0.04 * frameRate);
  const onsetAfter = Math.round(0.09 * frameRate);

  for (let beat = 0; beat < count; beat += 1) {
    const center = Math.round(beatTimes[beat] * frameRate);
    let low = 0;
    let mid = 0;
    let high = 0;
    for (
      let frame = Math.max(0, center - onsetBefore);
      frame <= Math.min(features.frameCount - 1, center + onsetAfter);
      frame += 1
    ) {
      low = Math.max(low, features.lowFlux[frame]);
      mid = Math.max(mid, features.midFlux[frame]);
      high = Math.max(high, features.highFlux[frame]);
    }
    lowOnset[beat] = low;
    midOnset[beat] = mid;
    highOnset[beat] = high;

    const start = Math.max(0, center);
    const end = Math.min(features.frameCount, Math.round((beatTimes[beat] + periodSeconds) * frameRate));
    const span = Math.max(1, end - start);
    let loudness = 0;
    for (let frame = start; frame < end; frame += 1) {
      loudness += features.rms[frame];
      const offset = frame * BAND_COUNT;
      const target = beat * BAND_COUNT;
      for (let band = 0; band < BAND_COUNT; band += 1) {
        bands[target + band] += features.bands[offset + band];
      }
    }
    rms[beat] = loudness / span;
    const target = beat * BAND_COUNT;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      bands[target + band] /= span;
    }
  }

  return { count, lowOnset, highOnset, midOnset, rms, bands };
}

function cosineSimilarity(
  left: Float32Array,
  leftOffset: number,
  right: Float32Array,
  rightOffset: number,
  length: number
): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[leftOffset + index];
    const b = right[rightOffset + index];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 1e-12 || rightNorm <= 1e-12) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Band index ranges over the 24 log-spaced bands from `spectral.ts`. */
const BASS_BAND_END = 9;
/** Upper band index for the chord/harmony range, roughly 250 Hz to 3 kHz. */
const HARMONY_BAND_END = 19;

export type DownbeatCueName =
  | "change"
  | "bassChange"
  | "backbeat"
  | "kick"
  | "barRepeat"
  | "twoBarRepeat";

export const DOWNBEAT_CUE_NAMES: DownbeatCueName[] = [
  "change",
  "bassChange",
  "backbeat",
  "kick",
  "barRepeat",
  "twoBarRepeat"
];

/**
 * Per-cue bar-phase scores, each normalised to 0-1 across the four phases.
 *
 * Exposed separately from `estimateDownbeat` so the offline study can measure
 * each cue's accuracy in isolation.
 */
export function downbeatCueScores(beats: BeatFeatures): Record<DownbeatCueName, number[]> {
  const empty = () => [0, 0, 0, 0];
  if (beats.count < 16) {
    return {
      change: empty(),
      bassChange: empty(),
      backbeat: empty(),
      kick: empty(),
      barRepeat: empty(),
      twoBarRepeat: empty()
    };
  }

  const change = new Float64Array(beats.count);
  const bassChange = new Float64Array(beats.count);
  for (let beat = 1; beat < beats.count; beat += 1) {
    change[beat] =
      1 - cosineSimilarity(beats.bands, beat * BAND_COUNT, beats.bands, (beat - 1) * BAND_COUNT, BAND_COUNT);
    bassChange[beat] =
      1 - cosineSimilarity(beats.bands, beat * BAND_COUNT, beats.bands, (beat - 1) * BAND_COUNT, BASS_BAND_END);
  }

  const raw: Record<DownbeatCueName, Float64Array> = {
    change: new Float64Array(4),
    bassChange: new Float64Array(4),
    backbeat: new Float64Array(4),
    kick: new Float64Array(4),
    barRepeat: new Float64Array(4),
    twoBarRepeat: new Float64Array(4)
  };

  for (let phase = 0; phase < 4; phase += 1) {
    let changeTotal = 0;
    let bassChangeTotal = 0;
    let kickTotal = 0;
    let onPhaseHigh = 0;
    let offPhaseHigh = 0;
    let samples = 0;
    for (let beat = phase; beat < beats.count; beat += 4) {
      changeTotal += change[beat];
      bassChangeTotal += bassChange[beat];
      kickTotal += beats.lowOnset[beat];
      onPhaseHigh += beats.highOnset[beat];
      offPhaseHigh += (beats.highOnset[beat + 1] ?? 0) + (beats.highOnset[beat + 3] ?? 0);
      samples += 1;
    }
    raw.change[phase] = samples ? changeTotal / samples : 0;
    raw.bassChange[phase] = samples ? bassChangeTotal / samples : 0;
    raw.kick[phase] = samples ? kickTotal / samples : 0;
    // Claps and open hats sit on beats 2 and 4, so the correct phase is the
    // one whose neighbours carry more air-band energy than it does.
    raw.backbeat[phase] = samples ? (offPhaseHigh / 2 - onPhaseHigh) / samples : 0;

    raw.barRepeat[phase] = blockSimilarity(beats, phase, 4);
    raw.twoBarRepeat[phase] = blockSimilarity(beats, phase, 8);
  }

  return {
    change: [...normalizePhases(raw.change)],
    bassChange: [...normalizePhases(raw.bassChange)],
    backbeat: [...normalizePhases(raw.backbeat)],
    kick: [...normalizePhases(raw.kick)],
    barRepeat: [...normalizePhases(raw.barRepeat)],
    twoBarRepeat: [...normalizePhases(raw.twoBarRepeat)]
  };
}

/**
 * Mean similarity between consecutive blocks of `length` beats starting at a
 * given phase. Loops line up with bars, so the true phase maximises this.
 */
function blockSimilarity(beats: BeatFeatures, phase: number, length: number): number {
  let total = 0;
  let blocks = 0;
  for (let beat = phase; beat + length * 2 <= beats.count; beat += length) {
    total += cosineSimilarity(
      beats.bands,
      beat * BAND_COUNT,
      beats.bands,
      (beat + length) * BAND_COUNT,
      BAND_COUNT * length
    );
    blocks += 1;
  }
  return blocks ? total / blocks : 0;
}

/**
 * Mean dissimilarity between consecutive `length`-beat blocks over a band
 * range, scored per bar phase and normalised across the four phases.
 */
function blockChangeByPhase(
  beats: BeatFeatures,
  length: number,
  bandStart: number,
  bandEnd: number
): Float64Array {
  const raw = new Float64Array(4);
  for (let phase = 0; phase < 4; phase += 1) {
    let total = 0;
    let blocks = 0;
    for (let beat = phase; beat + length * 2 <= beats.count; beat += length) {
      let similarity = 0;
      for (let offset = 0; offset < length; offset += 1) {
        similarity += cosineSimilarity(
          beats.bands,
          (beat + offset) * BAND_COUNT + bandStart,
          beats.bands,
          (beat + length + offset) * BAND_COUNT + bandStart,
          bandEnd - bandStart
        );
      }
      total += 1 - similarity / length;
      blocks += 1;
    }
    raw[phase] = blocks ? total / blocks : 0;
  }
  return normalizePhases(raw);
}

/** Scales four phase scores to zero minimum and unit range. */
function normalizePhases(scores: Float64Array): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (const score of scores) {
    min = Math.min(min, score);
    max = Math.max(max, score);
  }
  const range = max - min;
  const normalized = new Float64Array(4);
  if (range <= 1e-12) {
    return normalized;
  }
  for (let phase = 0; phase < 4; phase += 1) {
    normalized[phase] = (scores[phase] - min) / range;
  }
  return normalized;
}

/**
 * Block-contrast novelty at beat resolution.
 *
 * `kernelBeats` sets the scale: 16 beats (four bars) responds to phrase-scale
 * change, which is the scale at which house and techno actually reorganise.
 */
export function computeBeatNovelty(beats: BeatFeatures, kernelBeats = 16): Float32Array {
  const count = beats.count;
  const novelty = new Float32Array(count);
  if (count < kernelBeats * 2) {
    return novelty;
  }

  for (let beat = kernelBeats; beat + kernelBeats <= count; beat += 1) {
    let withinPast = 0;
    let withinFuture = 0;
    let across = 0;
    let pairs = 0;
    // Compare whole bars rather than single beats so a busy fill inside a bar
    // does not read as a section change.
    for (let left = 0; left < kernelBeats; left += 4) {
      for (let right = 0; right < kernelBeats; right += 4) {
        const pastLeft = beat - kernelBeats + left;
        const pastRight = beat - kernelBeats + right;
        const futureLeft = beat + left;
        const futureRight = beat + right;
        withinPast += cosineSimilarity(
          beats.bands, pastLeft * BAND_COUNT, beats.bands, pastRight * BAND_COUNT, BAND_COUNT * 4
        );
        withinFuture += cosineSimilarity(
          beats.bands, futureLeft * BAND_COUNT, beats.bands, futureRight * BAND_COUNT, BAND_COUNT * 4
        );
        across += cosineSimilarity(
          beats.bands, pastLeft * BAND_COUNT, beats.bands, futureRight * BAND_COUNT, BAND_COUNT * 4
        );
        pairs += 1;
      }
    }
    if (!pairs) {
      continue;
    }
    novelty[beat] = (withinPast + withinFuture) / (2 * pairs) - across / pairs;
  }

  return novelty;
}

export interface MetricGrid {
  /** Beat index at which bar 1 of phrase 1 begins. */
  originBeat: number;
  /** `originBeat % 4`: which beat phase starts a bar. */
  downbeatOffset: number;
  confidence: number;
}

const PHRASE_BEATS = 32;

export type GridWeights = Record<GridTermName, number>;

/**
 * Weights for the joint grid search, fitted by
 * `scripts/analysis/phaseStudy.ts` against the Mixed In Key phrase grids.
 */
/**
 * Weights fitted by `scripts/analysis/gridStudy.ts` against 149 Mixed In Key
 * beat grids. Re-run that study after changing any term definition.
 *
 * `startPrior` is zero here: it encodes "a file begins on bar 1 of phrase 1",
 * which is true of produced tracks but meaningless for live capture. The
 * offline path opts into it explicitly.
 */
export const DEFAULT_GRID_WEIGHTS: GridWeights = {
  phrase: 1,
  halfPhrase: 0.5,
  bar: 0.33,
  bassChange: 1,
  barBassChange: 0.17,
  harmonyChange: 0.33,
  twoBarRepeat: 0.17,
  startPrior: 0
};

/**
 * Jointly estimates the bar phase and the 8-bar phrase phase.
 *
 * Classifying the bar phase on its own is unreliable in four-to-the-floor
 * music: the kick is on every beat, so beat 1 has no local signature. The
 * phrase grid does have an unmistakable signature - arrangements reorganise
 * every 8 bars - so searching all 32 beat offsets at once lets the strong
 * phrase-scale evidence determine the weak bar phase for free.
 */
export type GridTermName =
  | "phrase"
  | "halfPhrase"
  | "bar"
  | "bassChange"
  | "barBassChange"
  | "harmonyChange"
  | "twoBarRepeat"
  | "startPrior";

export const GRID_TERM_NAMES: GridTermName[] = [
  "phrase",
  "halfPhrase",
  "bar",
  "bassChange",
  "barBassChange",
  "harmonyChange",
  "twoBarRepeat",
  "startPrior"
];

/**
 * Per-term scores for all 32 candidate grid origins.
 *
 * Exposed separately from `estimateMetricGrid` so `phaseStudy.ts` can fit the
 * weights against Mixed In Key's phrase grids without re-running audio
 * analysis for every candidate weighting.
 */
export function metricGridTerms(beats: BeatFeatures): Record<GridTermName, number[]> {
  const empty = (): number[] => new Array<number>(PHRASE_BEATS).fill(0);
  const terms: Record<GridTermName, number[]> = {
    phrase: empty(),
    halfPhrase: empty(),
    bar: empty(),
    bassChange: empty(),
    barBassChange: empty(),
    harmonyChange: empty(),
    twoBarRepeat: empty(),
    startPrior: empty()
  };
  if (beats.count < PHRASE_BEATS * 3) {
    return terms;
  }

  // Three novelty scales, each resolving a different ambiguity: 32 beats
  // (8 bars) fixes the phrase phase, 16 beats the 4-bar phase, 8 beats the bar
  // phase. Scoring all 32 offsets against all three at once lets the strong
  // phrase-scale evidence settle the weak bar-level question.
  const phraseNovelty = computeBeatNovelty(beats, 32);
  const halfPhraseNovelty = computeBeatNovelty(beats, 16);
  const barNovelty = computeBeatNovelty(beats, 8);
  const cues = downbeatCueScores(beats);

  const meanAtStride = (novelty: Float32Array, origin: number, stride: number): number => {
    let total = 0;
    let count = 0;
    for (let beat = origin; beat < beats.count; beat += stride) {
      total += novelty[beat];
      count += 1;
    }
    return count ? total / count : 0;
  };

  // Bar-scale movement: a whole bar of bass or harmony compared against the
  // previous bar. Beat-to-beat change alone is noisy in music where the bass
  // moves on every beat, whereas the bassline *pattern* restarts on bar 1.
  const barBassChange = blockChangeByPhase(beats, 4, 0, BASS_BAND_END);
  const harmonyChange = blockChangeByPhase(beats, 4, BASS_BAND_END, HARMONY_BAND_END);

  for (let origin = 0; origin < PHRASE_BEATS; origin += 1) {
    terms.phrase[origin] = meanAtStride(phraseNovelty, origin, PHRASE_BEATS);
    terms.halfPhrase[origin] = meanAtStride(halfPhraseNovelty, origin, 16);
    terms.bar[origin] = meanAtStride(barNovelty, origin, 4);
    terms.bassChange[origin] = cues.bassChange[origin % 4];
    terms.barBassChange[origin] = barBassChange[origin % 4];
    terms.harmonyChange[origin] = harmonyChange[origin % 4];
    terms.twoBarRepeat[origin] = cues.twoBarRepeat[origin % 4];
    // Produced tracks begin on bar 1 of phrase 1, so a grid origin close to
    // the first tracked beat is a priori likely. Only meaningful for whole
    // files: live capture starts wherever the listener pressed record, so the
    // live tracker leaves this weight at zero.
    terms.startPrior[origin] = Math.exp(-origin / 6);
  }
  return terms;
}

/**
 * Jointly estimates the bar phase and the 8-bar phrase phase.
 *
 * Classifying the bar phase on its own is unreliable in four-to-the-floor
 * music: the kick is on every beat, so beat 1 has no local signature. The
 * phrase grid does have an unmistakable signature - arrangements reorganise
 * every 8 bars - so searching all 32 beat offsets at once lets the strong
 * phrase-scale evidence determine the weak bar phase for free.
 */
export function estimateMetricGrid(
  beats: BeatFeatures,
  weights: GridWeights = DEFAULT_GRID_WEIGHTS
): MetricGrid {
  if (beats.count < PHRASE_BEATS * 3) {
    return { originBeat: 0, downbeatOffset: 0, confidence: 0 };
  }
  return selectMetricGrid(metricGridTerms(beats), weights);
}

/** Combines grid terms under a weighting and picks the best origin. */
export function selectMetricGrid(
  terms: Record<GridTermName, number[]>,
  weights: GridWeights
): MetricGrid {
  const scores = new Float64Array(PHRASE_BEATS);
  for (let origin = 0; origin < PHRASE_BEATS; origin += 1) {
    let score = 0;
    for (const name of GRID_TERM_NAMES) {
      score += weights[name] * terms[name][origin];
    }
    scores[origin] = score;
  }

  let originBeat = 0;
  for (let origin = 1; origin < PHRASE_BEATS; origin += 1) {
    if (scores[origin] > scores[originBeat]) {
      originBeat = origin;
    }
  }

  // Confidence compares the winner against the best offset in a different bar
  // phase, since an offset that is only 8 bars out still yields correct bars.
  let rival = -Infinity;
  for (let origin = 0; origin < PHRASE_BEATS; origin += 1) {
    if (origin % 4 !== originBeat % 4) {
      rival = Math.max(rival, scores[origin]);
    }
  }
  const weightTotal = GRID_TERM_NAMES.reduce((total, name) => total + Math.abs(weights[name]), 0);
  const spread = weightTotal > 0 ? (scores[originBeat] - rival) / weightTotal : 0;
  return {
    originBeat,
    downbeatOffset: originBeat % 4,
    confidence: Math.max(0, Math.min(1, spread * 4))
  };
}
