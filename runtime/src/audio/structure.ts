import { BAND_COUNT } from "./spectral.js";
import type { BeatFeatures } from "./beats.js";

/**
 * Bar-synchronous structural analysis.
 *
 * House and techno are written on an 8-bar grid, so this never proposes a
 * boundary off that grid. Segmentation is a dynamic program over bar indices
 * whose only legal segment lengths are musical phrase lengths, scored by
 * Foote novelty at the boundary and timbral homogeneity inside the segment.
 * That constraint is what makes the output usable for visuals: a boundary is
 * always on a downbeat that a dancer would also feel.
 */

export type PhraseKind = "intro" | "build" | "drop" | "groove" | "breakdown" | "outro";

/** Band index ranges over the 24 log-spaced bands from `spectral.ts`. */
const BAND_RANGES = {
  sub: [0, 5],
  bass: [3, 9],
  body: [9, 14],
  mid: [13, 19],
  air: [18, BAND_COUNT]
} as const;

export const BAR_FEATURE_COUNT = 8;

export interface BarFeatures {
  barCount: number;
  /** Time of each bar's downbeat, seconds. */
  times: Float64Array;
  /** `barCount * BAR_FEATURE_COUNT`, row-major, each column track-normalised 0-1. */
  values: Float32Array;
  /** Convenience columns, all track-normalised 0-1. */
  sub: Float32Array;
  bass: Float32Array;
  body: Float32Array;
  mid: Float32Array;
  air: Float32Array;
  rms: Float32Array;
  kick: Float32Array;
  hats: Float32Array;
}

export interface PhraseSegment {
  startBar: number;
  endBar: number;
  startSeconds: number;
  endSeconds: number;
  kind: PhraseKind;
  /** 1-10, aligned with the Mixed In Key energy scale. */
  energy: number;
  /** Normalised 0-1 descriptors, useful for driving visuals directly. */
  levels: {
    bass: number;
    air: number;
    rms: number;
    density: number;
  };
}

export function computeBarFeatures(
  beats: BeatFeatures,
  beatTimes: Float64Array,
  downbeatOffset: number
): BarFeatures {
  const barCount = Math.max(0, Math.floor((beats.count - downbeatOffset) / 4));
  const times = new Float64Array(barCount);
  const raw = {
    sub: new Float32Array(barCount),
    bass: new Float32Array(barCount),
    body: new Float32Array(barCount),
    mid: new Float32Array(barCount),
    air: new Float32Array(barCount),
    rms: new Float32Array(barCount),
    kick: new Float32Array(barCount),
    hats: new Float32Array(barCount)
  };

  for (let bar = 0; bar < barCount; bar += 1) {
    const firstBeat = downbeatOffset + bar * 4;
    times[bar] = beatTimes[firstBeat];
    let kick = 0;
    let hats = 0;
    let rms = 0;
    const bandTotals = new Float64Array(BAND_COUNT);
    for (let offset = 0; offset < 4; offset += 1) {
      const beat = firstBeat + offset;
      kick += beats.lowOnset[beat];
      hats += beats.highOnset[beat];
      rms += beats.rms[beat];
      const base = beat * BAND_COUNT;
      for (let band = 0; band < BAND_COUNT; band += 1) {
        bandTotals[band] += beats.bands[base + band];
      }
    }
    raw.kick[bar] = kick / 4;
    raw.hats[bar] = hats / 4;
    raw.rms[bar] = rms / 4;
    for (const [name, [start, end]] of Object.entries(BAND_RANGES)) {
      let total = 0;
      for (let band = start; band < end; band += 1) {
        total += bandTotals[band];
      }
      raw[name as keyof typeof BAND_RANGES][bar] = total / (4 * (end - start));
    }
  }

  const columns = [raw.sub, raw.bass, raw.body, raw.mid, raw.air, raw.rms, raw.kick, raw.hats];
  const normalized = columns.map((column) => normalizeByPercentile(column));
  const values = new Float32Array(barCount * BAR_FEATURE_COUNT);
  for (let bar = 0; bar < barCount; bar += 1) {
    for (let column = 0; column < BAR_FEATURE_COUNT; column += 1) {
      values[bar * BAR_FEATURE_COUNT + column] = normalized[column][bar];
    }
  }

  return {
    barCount,
    times,
    values,
    sub: normalized[0],
    bass: normalized[1],
    body: normalized[2],
    mid: normalized[3],
    air: normalized[4],
    rms: normalized[5],
    kick: normalized[6],
    hats: normalized[7]
  };
}

/**
 * Scales a feature column into 0-1 using the 5th and 95th percentiles.
 *
 * Absolute thresholds do not transfer between a quiet deep-house record and a
 * loud techno master, so every structural decision downstream is made against
 * within-track percentiles instead.
 */
function normalizeByPercentile(column: Float32Array): Float32Array {
  if (!column.length) {
    return new Float32Array(0);
  }
  const sorted = [...column].sort((left, right) => left - right);
  const low = sorted[Math.floor(sorted.length * 0.05)];
  const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const range = high - low;
  const output = new Float32Array(column.length);
  if (range <= 1e-9) {
    return output;
  }
  for (let index = 0; index < column.length; index += 1) {
    output[index] = Math.max(0, Math.min(1, (column[index] - low) / range));
  }
  return output;
}

const NOVELTY_KERNEL_BARS = 8;

/**
 * Foote checkerboard novelty over the bar self-similarity matrix.
 *
 * For each candidate boundary this contrasts how self-similar the preceding
 * and following blocks are against how similar they are to each other. A real
 * phrase change makes both blocks internally coherent and mutually different,
 * which is exactly what this maximises.
 */
export function computeBarNovelty(bars: BarFeatures): Float32Array {
  const count = bars.barCount;
  const novelty = new Float32Array(count);
  if (count < 4) {
    return novelty;
  }

  const similarity = new Float32Array(count * count);
  for (let row = 0; row < count; row += 1) {
    for (let column = row; column < count; column += 1) {
      const value = barSimilarity(bars, row, column);
      similarity[row * count + column] = value;
      similarity[column * count + row] = value;
    }
  }

  const kernel = NOVELTY_KERNEL_BARS;
  // Bars nearest the boundary carry the most evidence about it.
  const taper = new Float32Array(kernel);
  for (let index = 0; index < kernel; index += 1) {
    const position = (index + 0.5) / kernel;
    taper[index] = Math.exp(-2 * position * position);
  }

  for (let bar = 0; bar < count; bar += 1) {
    const pastStart = bar - kernel;
    const futureEnd = bar + kernel;
    if (pastStart < 0 || futureEnd > count) {
      novelty[bar] = 0;
      continue;
    }

    let withinPast = 0;
    let withinPastWeight = 0;
    let withinFuture = 0;
    let withinFutureWeight = 0;
    let across = 0;
    let acrossWeight = 0;

    for (let left = 0; left < kernel; left += 1) {
      for (let right = 0; right < kernel; right += 1) {
        const weight = taper[left] * taper[right];
        const pastLeft = bar - 1 - left;
        const pastRight = bar - 1 - right;
        const futureLeft = bar + left;
        const futureRight = bar + right;

        withinPast += weight * similarity[pastLeft * count + pastRight];
        withinPastWeight += weight;
        withinFuture += weight * similarity[futureLeft * count + futureRight];
        withinFutureWeight += weight;
        across += weight * similarity[pastLeft * count + futureRight];
        acrossWeight += weight;
      }
    }

    const coherence =
      withinPast / Math.max(1e-9, withinPastWeight) / 2 + withinFuture / Math.max(1e-9, withinFutureWeight) / 2;
    novelty[bar] = coherence - across / Math.max(1e-9, acrossWeight);
  }

  return normalizeByPercentile(novelty);
}

function barSimilarity(bars: BarFeatures, left: number, right: number): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let column = 0; column < BAR_FEATURE_COUNT; column += 1) {
    const a = bars.values[left * BAR_FEATURE_COUNT + column];
    const b = bars.values[right * BAR_FEATURE_COUNT + column];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 1e-9 || rightNorm <= 1e-9) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Legal phrase lengths in bars, with a prior favouring 8, 16 and 32. */
const SEGMENT_LENGTHS: Array<{ bars: number; prior: number }> = [
  { bars: 4, prior: -0.35 },
  { bars: 8, prior: 0.05 },
  { bars: 12, prior: -0.3 },
  { bars: 16, prior: 0.1 },
  { bars: 24, prior: -0.25 },
  { bars: 32, prior: 0.05 },
  { bars: 48, prior: -0.3 },
  { bars: 64, prior: -0.15 }
];

export interface SegmentationOptions {
  /** Reward for a boundary, scaled by the novelty there. */
  boundaryWeight: number;
  /**
   * Fixed cost per boundary.
   *
   * This is what stops the segmentation shattering: a boundary has to be
   * worth more in novelty than it costs, so this directly sets the
   * precision/recall trade-off.
   */
  boundaryCost: number;
  /** Reward for within-segment similarity, per 8 bars of segment length. */
  homogeneityWeight: number;
  /** Extra reward for a boundary that falls on the 8-bar phrase grid. */
  phraseGridBonus: number;
}

/** Fitted by the segmentation sweep in `scripts/analysis/phaseStudy.ts`. */
export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  boundaryWeight: 1,
  boundaryCost: 0.3,
  homogeneityWeight: 1,
  phraseGridBonus: 0.15
};

export interface BarSegment {
  startBar: number;
  endBar: number;
}

/**
 * Segments the bar grid into phrases with a dynamic program.
 *
 * Boundaries are confined to the estimated phrase grid, so this cannot emit
 * the off-grid boundaries a raw novelty peak-picker produces.
 * `phraseOriginBar` is the bar at which the 8-bar grid starts; bars before it
 * become a lead-in segment rather than being forced onto the grid.
 *
 * The homogeneity reward is scaled by segment length. Without that, the total
 * score grows with the *number* of segments and the optimum degenerates to
 * the shortest legal phrase everywhere.
 */
export function segmentBars(
  bars: BarFeatures,
  novelty: Float32Array,
  phraseOriginBar = 0,
  options: SegmentationOptions = DEFAULT_SEGMENTATION_OPTIONS
): BarSegment[] {
  const count = bars.barCount;
  if (count < 8) {
    return count ? [{ startBar: 0, endBar: count }] : [];
  }

  const head = Math.max(0, Math.min(count, phraseOriginBar % 8));
  const gridBars = count - head;
  if (gridBars < 8) {
    return [{ startBar: 0, endBar: count }];
  }

  // Work in 4-bar steps from the grid origin so every boundary is on grid.
  const steps = Math.floor(gridBars / 4);
  const best = new Float64Array(steps + 1).fill(-Infinity);
  const chosenSteps = new Int32Array(steps + 1);
  best[0] = 0;

  for (let end = 1; end <= steps; end += 1) {
    for (const option of SEGMENT_LENGTHS) {
      const lengthSteps = option.bars / 4;
      const start = end - lengthSteps;
      if (start < 0 || best[start] === -Infinity) {
        continue;
      }
      const startBar = head + start * 4;
      const onPhraseGrid = start % 2 === 0;
      const boundaryReward =
        start === 0
          ? 0
          : options.boundaryWeight * (novelty[startBar] ?? 0) -
            options.boundaryCost +
            (onPhraseGrid ? options.phraseGridBonus : 0);
      const score =
        best[start] +
        boundaryReward +
        options.homogeneityWeight * segmentHomogeneity(bars, startBar, head + end * 4) * (option.bars / 8) +
        option.prior;
      if (score > best[end]) {
        best[end] = score;
        chosenSteps[end] = lengthSteps;
      }
    }
  }

  const segments: BarSegment[] = [];
  let cursor = steps;
  while (cursor > 0) {
    const lengthSteps = Math.max(1, chosenSteps[cursor]);
    const start = Math.max(0, cursor - lengthSteps);
    segments.push({ startBar: head + start * 4, endBar: head + cursor * 4 });
    cursor = start;
  }
  segments.reverse();

  if (head > 0) {
    segments.unshift({ startBar: 0, endBar: head });
  }
  // Absorb any trailing bars that did not fill a 4-bar step.
  const tail = head + steps * 4;
  if (tail < count && segments.length) {
    segments[segments.length - 1].endBar = count;
  }
  return segments;
}

function segmentHomogeneity(bars: BarFeatures, start: number, end: number): number {
  const span = end - start;
  if (span <= 1) {
    return 0;
  }
  let total = 0;
  let pairs = 0;
  const stride = span > 16 ? Math.ceil(span / 16) : 1;
  for (let left = start; left < end; left += stride) {
    for (let right = left + stride; right < end; right += stride) {
      total += barSimilarity(bars, left, right);
      pairs += 1;
    }
  }
  return pairs ? total / pairs : 0;
}

/**
 * Assigns a musical role and a 1-10 energy value to each segment.
 *
 * All thresholds are within-track percentiles produced by
 * `computeBarFeatures`, so the same rules hold for a sparse minimal record and
 * a wall-of-sound techno master.
 */
export function labelSegments(
  bars: BarFeatures,
  boundaries: BarSegment[],
  barSeconds: number
): PhraseSegment[] {
  const summaries = boundaries.map((boundary) => summarizeSegment(bars, boundary.startBar, boundary.endBar));

  return boundaries.map((boundary, index) => {
    const summary = summaries[index];
    const previous = summaries[index - 1] ?? null;
    const next = summaries[index + 1] ?? null;
    const isFirst = index === 0;
    const isLast = index === boundaries.length - 1;
    const hasBass = summary.bass > 0.42;
    const loud = summary.rms > 0.6;

    let kind: PhraseKind;
    if (!hasBass && summary.rms < 0.55 && next && next.bass > 0.5 && summary.airTrend > 0.12) {
      kind = "build";
    } else if (!hasBass && !isFirst && !isLast) {
      kind = "breakdown";
    } else if (isFirst && !loud) {
      kind = "intro";
    } else if (isLast && summary.rmsTrend < -0.08) {
      kind = "outro";
    } else if (hasBass && loud && previous && (previous.bass <= 0.42 || previous.rms < summary.rms - 0.18)) {
      kind = "drop";
    } else if (hasBass) {
      kind = "groove";
    } else {
      kind = isFirst ? "intro" : "outro";
    }

    return {
      startBar: boundary.startBar,
      endBar: boundary.endBar,
      startSeconds: bars.times[boundary.startBar] ?? 0,
      endSeconds: (bars.times[boundary.endBar] ?? (bars.times[bars.barCount - 1] ?? 0) + barSeconds),
      kind,
      energy: meanBarEnergy(bars, boundary.startBar, boundary.endBar),
      levels: {
        bass: summary.bass,
        air: summary.air,
        rms: summary.rms,
        density: summary.density
      }
    };
  });
}

/** Mean of the per-bar energy curve across a bar span, rounded to 1-10. */
function meanBarEnergy(bars: BarFeatures, start: number, end: number): number {
  const span = Math.max(1, end - start);
  let total = 0;
  for (let bar = start; bar < end; bar += 1) {
    total += energyFromFeatures(bars.values, bar * BAR_FEATURE_COUNT);
  }
  return Math.max(1, Math.min(10, Math.round(total / span)));
}

interface SegmentSummary {
  bass: number;
  air: number;
  rms: number;
  density: number;
  rmsTrend: number;
  airTrend: number;
}

function summarizeSegment(bars: BarFeatures, start: number, end: number): SegmentSummary {
  const span = Math.max(1, end - start);
  let bass = 0;
  let air = 0;
  let rms = 0;
  let density = 0;
  for (let bar = start; bar < end; bar += 1) {
    bass += (bars.bass[bar] + bars.sub[bar]) / 2;
    air += bars.air[bar];
    rms += bars.rms[bar];
    density += (bars.hats[bar] + bars.mid[bar]) / 2;
  }
  return {
    bass: bass / span,
    air: air / span,
    rms: rms / span,
    density: density / span,
    rmsTrend: trend(bars.rms, start, end),
    airTrend: trend(bars.air, start, end)
  };
}

/** Difference between the last and first thirds of a column over a span. */
function trend(column: Float32Array, start: number, end: number): number {
  const span = end - start;
  if (span < 3) {
    return 0;
  }
  const third = Math.max(1, Math.floor(span / 3));
  let head = 0;
  let tail = 0;
  for (let index = 0; index < third; index += 1) {
    head += column[start + index];
    tail += column[end - 1 - index];
  }
  return (tail - head) / third;
}

/**
 * Weights over the bar feature columns for the 1-10 energy scale, fitted by
 * `scripts/analysis/energyStudy.ts` against 1340 Mixed In Key energy segments.
 *
 * Worth noting what the fit found: brightness (`air`) and midrange predict
 * perceived energy better than loudness does. A busy hi-hat pattern reads as
 * high energy even at modest level, which is why `rms` ends up with a small
 * weight and `air` a large one.
 */
const ENERGY_WEIGHTS: Record<keyof typeof BAND_RANGES | "rms" | "kick" | "hats", number> = {
  sub: 0.13,
  bass: -0.026,
  body: -0.052,
  mid: 0.26,
  air: 0.26,
  rms: 0.052,
  kick: 0.195,
  hats: -0.026
};

/** Column order must match `computeBarFeatures`. */
const ENERGY_WEIGHT_VECTOR = [
  ENERGY_WEIGHTS.sub,
  ENERGY_WEIGHTS.bass,
  ENERGY_WEIGHTS.body,
  ENERGY_WEIGHTS.mid,
  ENERGY_WEIGHTS.air,
  ENERGY_WEIGHTS.rms,
  ENERGY_WEIGHTS.kick,
  ENERGY_WEIGHTS.hats
];

const ENERGY_POSITIVE_TOTAL = ENERGY_WEIGHT_VECTOR.reduce(
  (total, weight) => total + Math.max(0, weight),
  0
);

/** Maps one bar feature vector onto the 1-10 Mixed In Key energy scale. */
export function energyFromFeatures(values: Float32Array, offset: number): number {
  let composite = 0;
  for (let column = 0; column < BAR_FEATURE_COUNT; column += 1) {
    composite += values[offset + column] * ENERGY_WEIGHT_VECTOR[column];
  }
  const scaled = composite / ENERGY_POSITIVE_TOTAL;
  return Math.max(1, Math.min(10, 1 + scaled * 9));
}

/**
 * Energy per bar on the 1-10 scale.
 *
 * Phrase-level energy is deliberately flat across a phrase, which is right for
 * driving a visual preset but hides the arc inside a long section. This gives
 * the finer curve, and lets the benchmark separate "do we read the energy
 * correctly" from "do we place boundaries the same way".
 */
export function computeBarEnergy(bars: BarFeatures): Float32Array {
  const energy = new Float32Array(bars.barCount);
  for (let bar = 0; bar < bars.barCount; bar += 1) {
    energy[bar] = energyFromFeatures(bars.values, bar * BAR_FEATURE_COUNT);
  }
  return energy;
}
