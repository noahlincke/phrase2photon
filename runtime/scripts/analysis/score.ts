/**
 * Scoring of our analysis against Mixed In Key's static analysis.
 *
 * Kept separate from the runner so the metric definitions are reviewable on
 * their own, and so a scoring change cannot silently be confused with an
 * algorithm change.
 */

export interface TruthSong {
  songId: number;
  title: string;
  artist: string;
  path: string;
  bpm: number;
  key: string | null;
  energy: number | null;
  beatTimes: number[];
  energySegments: Array<{ start: number; length: number; energy: number }>;
  cuePoints: Array<{ time: number; energy: number }>;
}

export interface TempoScore {
  bpm: number;
  truthBpm: number;
  absoluteError: number;
  relativeError: number;
  /** True when within 0.1 BPM: indistinguishable from the reference. */
  exact: boolean;
  /** True when within 0.5 BPM: inaudible for beat-matched visuals. */
  tight: boolean;
  /** Standard MIREX tolerance. */
  within2Percent: boolean;
  /** True when the error is explained by a half/double/third relationship. */
  octaveError: boolean;
}

export function scoreTempo(bpm: number, truthBpm: number): TempoScore {
  const absoluteError = Math.abs(bpm - truthBpm);
  const relativeError = absoluteError / truthBpm;
  const ratios = [0.5, 2, 1 / 3, 3, 2 / 3, 1.5];
  const octaveError =
    relativeError > 0.02 &&
    ratios.some((ratio) => Math.abs(bpm - truthBpm * ratio) / (truthBpm * ratio) <= 0.02);
  return {
    bpm,
    truthBpm,
    absoluteError,
    relativeError,
    exact: absoluteError <= 0.1,
    tight: absoluteError <= 0.5,
    within2Percent: relativeError <= 0.02,
    octaveError
  };
}

export interface BeatScore {
  /** F-measure against the reference beat grid at a 70 ms tolerance. */
  fMeasure: number;
  /** Median absolute error of matched beats, milliseconds. */
  medianErrorMs: number;
  /**
   * Our downbeat position relative to the reference grid origin, in beats,
   * wrapped to [0, 4). Zero means our bar phase agrees with the reference.
   */
  barPhaseOffset: number;
  barPhaseAligned: boolean;
  /**
   * Signed offset of our grid from the reference, in beats, wrapped to
   * [-0.5, 0.5). Near zero means the grids coincide; near +/-0.5 means we
   * locked onto the offbeat.
   */
  signedPhaseBeats: number;
}

const BEAT_TOLERANCE_SECONDS = 0.07;

export function scoreBeats(
  beatTimes: Float64Array,
  firstDownbeatSeconds: number,
  periodSeconds: number,
  truthBeats: number[]
): BeatScore {
  if (!beatTimes.length || truthBeats.length < 4) {
    return {
      fMeasure: 0,
      medianErrorMs: Infinity,
      barPhaseOffset: 0,
      barPhaseAligned: false,
      signedPhaseBeats: 0
    };
  }

  // Restrict to the overlapping span; trackers legitimately differ about how
  // far into silent lead-in and fade-out a grid should extend.
  const start = Math.max(beatTimes[0], truthBeats[0]) - BEAT_TOLERANCE_SECONDS;
  const end = Math.min(beatTimes[beatTimes.length - 1], truthBeats[truthBeats.length - 1]) + BEAT_TOLERANCE_SECONDS;
  const ours = [...beatTimes].filter((time) => time >= start && time <= end);
  const truth = truthBeats.filter((time) => time >= start && time <= end);
  if (!ours.length || !truth.length) {
    return {
      fMeasure: 0,
      medianErrorMs: Infinity,
      barPhaseOffset: 0,
      barPhaseAligned: false,
      signedPhaseBeats: 0
    };
  }

  const usedOurs = new Set<number>();
  const errors: number[] = [];
  for (const reference of truth) {
    let bestIndex = -1;
    let bestError = Infinity;
    for (let index = 0; index < ours.length; index += 1) {
      if (usedOurs.has(index)) {
        continue;
      }
      const error = Math.abs(ours[index] - reference);
      if (error < bestError) {
        bestError = error;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestError <= BEAT_TOLERANCE_SECONDS) {
      usedOurs.add(bestIndex);
      errors.push(bestError);
    }
  }

  const matched = errors.length;
  const precision = matched / ours.length;
  const recall = matched / truth.length;
  const fMeasure = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  errors.sort((left, right) => left - right);
  const medianErrorMs = matched ? errors[Math.floor(matched / 2)] * 1000 : Infinity;

  const rawPhase = (firstDownbeatSeconds - truthBeats[0]) / periodSeconds;
  const barPhaseOffset = ((rawPhase % 4) + 4) % 4;
  const distanceToGrid = Math.min(barPhaseOffset, 4 - barPhaseOffset);
  const beatPhase = ((rawPhase % 1) + 1) % 1;
  const signedPhaseBeats = beatPhase > 0.5 ? beatPhase - 1 : beatPhase;

  return {
    fMeasure,
    medianErrorMs,
    barPhaseOffset,
    barPhaseAligned: distanceToGrid <= 0.25,
    signedPhaseBeats
  };
}

export interface BoundaryScore {
  fMeasure: number;
  precision: number;
  recall: number;
  toleranceSeconds: number;
}

/**
 * Boundary F-measure against the points where Mixed In Key's energy changes.
 *
 * Its energy segments sit on a regular 8-bar grid, so only the boundaries
 * where the energy value actually changes represent a structural decision that
 * is meaningful to compare against.
 */
export function referenceBoundaries(song: TruthSong): number[] {
  const boundaries: number[] = [];
  const segments = song.energySegments;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].energy !== segments[index - 1].energy) {
      boundaries.push(segments[index].start);
    }
  }
  return boundaries;
}

export function scoreBoundaries(
  ourBoundaries: number[],
  truthBoundaries: number[],
  toleranceSeconds: number
): BoundaryScore {
  if (!truthBoundaries.length || !ourBoundaries.length) {
    return { fMeasure: 0, precision: 0, recall: 0, toleranceSeconds };
  }
  const used = new Set<number>();
  let matched = 0;
  for (const reference of truthBoundaries) {
    let bestIndex = -1;
    let bestError = Infinity;
    for (let index = 0; index < ourBoundaries.length; index += 1) {
      if (used.has(index)) {
        continue;
      }
      const error = Math.abs(ourBoundaries[index] - reference);
      if (error < bestError) {
        bestError = error;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestError <= toleranceSeconds) {
      used.add(bestIndex);
      matched += 1;
    }
  }
  const precision = matched / ourBoundaries.length;
  const recall = matched / truthBoundaries.length;
  return {
    fMeasure: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    precision,
    recall,
    toleranceSeconds
  };
}

export interface GridScore {
  /** Fraction of our boundaries landing on the reference 8-bar phrase grid. */
  onGridFraction: number;
  /** Median distance from our boundaries to that grid, in bars. */
  medianOffsetBars: number;
}

/**
 * How well our phrase boundaries sit on Mixed In Key's phrase grid.
 *
 * Its energy segments are a regular 8-bar grid anchored at the first downbeat,
 * so this measures whether we agree about where bars and phrases *start* -
 * independently of whether we agree that a given boundary is interesting. For
 * beat-locked visuals this matters more than boundary recall: a phrase change
 * fired half a bar late reads as a mistake even if the section was correct.
 */
export function scorePhraseGrid(
  ourBoundaries: number[],
  song: TruthSong,
  barSeconds: number
): GridScore {
  const segments = song.energySegments;
  if (segments.length < 2 || !ourBoundaries.length || !(barSeconds > 0)) {
    return { onGridFraction: 0, medianOffsetBars: Infinity };
  }
  const origin = segments[0].start;
  const phraseSeconds = segments[0].length;
  if (!(phraseSeconds > 0)) {
    return { onGridFraction: 0, medianOffsetBars: Infinity };
  }

  const offsets = ourBoundaries.map((boundary) => {
    const phase = ((boundary - origin) / phraseSeconds) % 1;
    const wrapped = Math.min(((phase % 1) + 1) % 1, 1 - (((phase % 1) + 1) % 1));
    return (wrapped * phraseSeconds) / barSeconds;
  });
  const onGrid = offsets.filter((offset) => offset <= 0.25).length;
  return {
    onGridFraction: onGrid / offsets.length,
    medianOffsetBars: percentile(offsets, 0.5)
  };
}

/** Pearson correlation between our energy contour and the reference one. */
export function scoreEnergyContour(
  sampleEnergyAt: (seconds: number) => number | null,
  song: TruthSong
): number {
  const ours: number[] = [];
  const truth: number[] = [];
  for (const segment of song.energySegments) {
    const value = sampleEnergyAt(segment.start + segment.length / 2);
    if (value === null) {
      continue;
    }
    ours.push(value);
    truth.push(segment.energy);
  }
  return pearson(ours, truth);
}

export function pearson(left: number[], right: number[]): number {
  const count = Math.min(left.length, right.length);
  if (count < 3) {
    return 0;
  }
  let meanLeft = 0;
  let meanRight = 0;
  for (let index = 0; index < count; index += 1) {
    meanLeft += left[index];
    meanRight += right[index];
  }
  meanLeft /= count;
  meanRight /= count;

  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < count; index += 1) {
    const a = left[index] - meanLeft;
    const b = right[index] - meanRight;
    covariance += a * b;
    varianceLeft += a * a;
    varianceRight += b * b;
  }
  if (varianceLeft <= 1e-12 || varianceRight <= 1e-12) {
    return 0;
  }
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) {
    return NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index];
}
