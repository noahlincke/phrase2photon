import {
  computeBeatFeatures,
  estimateMetricGrid,
  fitRegularGrid,
  refinePeriodFromBeats,
  trackBeats,
  DEFAULT_GRID_WEIGHTS,
  type BeatFeatures,
  type GridWeights
} from "./beats.js";
import { blendOnsetEnvelopes, normalizeOnsetEnvelope, type OnsetEnvelope } from "./odf.js";
import { analyzeBuffer, type SpectralFeatures } from "./spectral.js";
import {
  computeBarFeatures,
  computeBarEnergy,
  computeBarNovelty,
  labelSegments,
  segmentBars,
  DEFAULT_SEGMENTATION_OPTIONS,
  type BarFeatures,
  type PhraseSegment,
  type SegmentationOptions
} from "./structure.js";
import { estimateTempo } from "./tempo.js";

/**
 * Whole-track offline analysis.
 *
 * This is the reference implementation: `scripts/analysis/mikBenchmark.ts`
 * scores it against the Mixed In Key database, and the live microphone
 * tracker is held to the same feature definitions so that improving one
 * improves the other.
 */

export interface AnalysisOptions {
  /**
   * Kick weight in the envelope used for tempo estimation.
   *
   * Periodicity estimation benefits from every onset in the mix, so this stays
   * low; weighting it toward the kick measurably degrades tempo accuracy.
   */
  tempoKickWeight?: number;
  /**
   * Kick weight in the envelope used for beat tracking and phase.
   *
   * The opposite trade-off: the kick is what defines where beat 1 sits, so
   * this runs high to stop the tracker latching onto offbeat hats.
   */
  trackingKickWeight?: number;
  /**
   * Which band decides the on-beat / offbeat question.
   *
   * Onset flux, not energy: a sustained bassline keeps sub-band *energy* high
   * between kicks, which measured 52% offbeat locks against 13% for flux.
   */
  halfBeatBand?: "kick" | "low";
  /**
   * How much stronger the offbeat has to be before the grid is shifted.
   * Above 1 this biases toward keeping the tracker's on-beat choice.
   */
  halfBeatMargin?: number;
  gridWeights?: GridWeights;
  segmentation?: SegmentationOptions;
}

export const DEFAULT_ANALYSIS_OPTIONS: Required<AnalysisOptions> = {
  tempoKickWeight: 0.4,
  trackingKickWeight: 0.9,
  halfBeatBand: "low",
  halfBeatMargin: 0.95,
  gridWeights: DEFAULT_GRID_WEIGHTS,
  segmentation: DEFAULT_SEGMENTATION_OPTIONS
};

export interface TrackAnalysis {
  bpm: number;
  tempoConfidence: number;
  periodSeconds: number;
  beatTimes: Float64Array;
  /** Which beat index (0-3) starts a bar. */
  downbeatOffset: number;
  downbeatConfidence: number;
  firstDownbeatSeconds: number;
  /** Bar index, relative to the bar grid, where the 8-bar phrase grid starts. */
  phraseOriginBar: number;
  barSeconds: number;
  phrases: PhraseSegment[];
  features: SpectralFeatures;
  beats: BeatFeatures;
  bars: BarFeatures;
  novelty: Float32Array;
  /** Energy per bar, 1-10, on the Mixed In Key scale. */
  barEnergy: Float32Array;
  /** Time of each bar's downbeat, seconds. */
  barTimes: Float64Array;
}

export function analyzeTrack(
  samples: Float32Array,
  sampleRate: number,
  options: AnalysisOptions = {}
): TrackAnalysis {
  return analyzeSpectralFeatures(analyzeBuffer(samples, sampleRate), samples.length / sampleRate, options);
}

/**
 * Analysis from precomputed spectral features.
 *
 * Split out so parameter sweeps can reuse one expensive STFT pass across many
 * configurations instead of re-decoding and re-transforming every time.
 */
export function analyzeSpectralFeatures(
  features: SpectralFeatures,
  durationSeconds: number,
  options: AnalysisOptions = {}
): TrackAnalysis {
  const settings = { ...DEFAULT_ANALYSIS_OPTIONS, ...options };
  const firstFrameSeconds = features.times[0] ?? 0;
  const envelopeFor = (raw: Float32Array): OnsetEnvelope =>
    normalizeOnsetEnvelope(raw, features.frameRate, firstFrameSeconds);

  const broadband = envelopeFor(features.flux);
  const low = envelopeFor(features.lowFlux);
  const kickDrum = envelopeFor(features.kickFlux);
  const tempoEnvelope = blendOnsetEnvelopes(broadband, low, settings.tempoKickWeight);
  const trackingEnvelope = blendOnsetEnvelopes(broadband, low, settings.trackingKickWeight);

  const tempo = estimateTempo(tempoEnvelope);

  // Track, re-derive the period from the tracked beats, then re-track. One
  // iteration is enough to converge well inside a millisecond per beat.
  let trackingPeriod = 60 / tempo.bpm;
  let trackedBeats = trackBeats(trackingEnvelope, trackingPeriod);
  for (let pass = 0; pass < 2; pass += 1) {
    const refined = refinePeriodFromBeats(trackedBeats, trackingPeriod);
    if (Math.abs(refined - trackingPeriod) < 1e-6) {
      break;
    }
    trackingPeriod = refined;
    trackedBeats = trackBeats(trackingEnvelope, trackingPeriod);
  }

  const grid = fitRegularGrid(
    trackedBeats,
    trackingEnvelope,
    trackingPeriod,
    durationSeconds,
    settings.halfBeatBand === "kick" ? kickDrum : low,
    settings.halfBeatMargin
  );
  const periodSeconds = grid.periodSeconds;
  const beatTimes = grid.beatTimes;

  const beats = computeBeatFeatures(features, beatTimes, periodSeconds);
  const metric = estimateMetricGrid(beats, settings.gridWeights);
  const bars = computeBarFeatures(beats, beatTimes, metric.downbeatOffset);
  const novelty = computeBarNovelty(bars);
  const barSeconds = periodSeconds * 4;
  const phraseOriginBar = Math.floor(metric.originBeat / 4) % 8;
  const phrases = labelSegments(
    bars,
    segmentBars(bars, novelty, phraseOriginBar, settings.segmentation),
    barSeconds
  );

  return {
    bpm: 60 / periodSeconds,
    tempoConfidence: tempo.confidence,
    periodSeconds,
    beatTimes,
    downbeatOffset: metric.downbeatOffset,
    downbeatConfidence: metric.confidence,
    firstDownbeatSeconds: beatTimes[metric.downbeatOffset] ?? 0,
    phraseOriginBar,
    barSeconds,
    phrases,
    features,
    beats,
    bars,
    novelty,
    barEnergy: computeBarEnergy(bars),
    barTimes: bars.times
  };
}
