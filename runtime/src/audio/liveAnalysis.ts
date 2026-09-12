import {
  downbeatCueScores,
  estimateMetricGrid,
  type BeatFeatures
} from "./beats.js";
import { blendOnsetEnvelopes, normalizeOnsetEnvelope, sampleAt } from "./odf.js";
import { RingBuffer, RingMatrix } from "./ring.js";
import { BAND_COUNT, SpectralAnalyzer } from "./spectral.js";
import {
  energyFromFeatures,
  BAR_FEATURE_COUNT,
  type PhraseKind
} from "./structure.js";
import { estimateTempo } from "./tempo.js";

/**
 * Real-time musical analysis of a live audio feed.
 *
 * Shares its entire front end with the offline analyser: the same
 * `SpectralAnalyzer`, the same onset definitions, the same bar features and
 * the same energy composite fitted against Mixed In Key. What differs is only
 * what has to differ when there is no future context - tempo comes from a
 * rolling window and locks with hysteresis, beats are followed by a
 * phase-locked loop rather than a global dynamic program, and phrase state is
 * a causal state machine.
 *
 * Everything is expressed in the audio clock (`AudioContext.currentTime`) so
 * the renderer can ask for the musical position at any instant without
 * accumulating drift against `performance.now()`.
 */

export interface LiveAnalysisOptions {
  /** Seconds of onset history used for tempo estimation. */
  tempoWindowSeconds?: number;
  /** How often tempo is re-estimated, in seconds. */
  tempoIntervalSeconds?: number;
  minBpm?: number;
  maxBpm?: number;
}

const DEFAULTS: Required<LiveAnalysisOptions> = {
  tempoWindowSeconds: 16,
  tempoIntervalSeconds: 0.5,
  minBpm: 90,
  maxBpm: 180
};

/** Successive estimates must agree within this fraction to reach a lock. */
const LOCK_TOLERANCE = 0.015;
const LOCK_REQUIRED_AGREEMENTS = 4;
const UNLOCK_REQUIRED_DISAGREEMENTS = 8;
/** Comb teeth usable from a 16 s window; the offline path uses far more. */
const LIVE_COMB_TEETH = 10;

const BEAT_HISTORY = 256;
const BAR_HISTORY = 64;
/**
 * Beats of observed onsets used for the rolling grid fit.
 *
 * A longer baseline gives a more precise period; the observations are cleared
 * whenever the tempo relocks, so this does not slow down a track change.
 */
const GRID_FIT_BEATS = 128;
const MIN_OBSERVATIONS_FOR_FIT = 12;
/**
 * A rolling feature column must vary by at least this fraction of its own
 * level before it is rescaled; below it, the column counts as flat.
 */
const FLAT_COLUMN_FRACTION = 0.12;

/** Bars of history before phrase transitions are trusted. */
const PHRASE_WARMUP_BARS = 8;
/** Minimum bars a phrase must hold before any change, including a drop. */
const MIN_PHRASE_BARS = 2;
/** Minimum bars before a non-drop change; drops may interrupt sooner. */
const PHRASE_DWELL_BARS = 4;

/** Beats of history before the bar phase is worth estimating at all. */
const MIN_BEATS_FOR_BAR_PHASE = 32;
/** Beats of history before the full offline grid estimator becomes usable. */
const MIN_BEATS_FOR_METRIC_GRID = 128;

export type LiveTempoState = "idle" | "listening" | "locked";

export interface LivePhraseState {
  kind: PhraseKind;
  /** Bar index at which this phrase began. */
  startBar: number;
  /** Bars elapsed since it began. */
  bars: number;
  /** 1-10 on the Mixed In Key scale. */
  energy: number;
}

export interface LiveMusicalState {
  tempoState: LiveTempoState;
  bpm: number;
  tempoConfidence: number;
  /** Beat index since capture began; the fraction is the position in the beat. */
  beatPosition: number;
  /** 0-1 within the current beat. */
  beatPhase: number;
  /** 1-4. */
  beatInBar: number;
  /** Bar index since capture began. */
  bar: number;
  /** 0-1 within the current bar. */
  barPhase: number;
  /** 0-7: which bar of the 8-bar phrase. */
  phraseBar: number;
  /** 0-1 through the current 8-bar phrase. */
  phrasePhase: number;
  downbeatConfidence: number;
  phrase: LivePhraseState;
  /** 1-10 for the current bar. */
  energy: number;
  /** Smoothed band levels for reactive visuals, each 0-1. */
  bands: { low: number; mid: number; high: number };
  level: number;
  status: string;
}

/** Normalised bar descriptors, 0-1, in the offline column order. */
interface BarRow {
  sub: number;
  bass: number;
  body: number;
  mid: number;
  air: number;
  rms: number;
  kick: number;
  hats: number;
}

const BAND_RANGES: Array<[keyof BarRow, number, number]> = [
  ["sub", 0, 5],
  ["bass", 3, 9],
  ["body", 9, 14],
  ["mid", 13, 19],
  ["air", 18, BAND_COUNT]
];

export interface LiveBeatEvent {
  index: number;
  /** Audio-clock time of the beat. */
  time: number;
  /** 1-4. */
  beatInBar: number;
  bar: number;
}

export class LiveAnalyzer {
  readonly sampleRate: number;
  /**
   * Called as each beat is confirmed, slightly after it sounded.
   *
   * Use `snapshot()` for anything that must be frame-accurate on screen; this
   * is for discrete events such as flashes, cue output and instrumentation.
   */
  onBeat: ((beat: LiveBeatEvent) => void) | null = null;
  private readonly options: Required<LiveAnalysisOptions>;
  private readonly analyzer: SpectralAnalyzer;
  private readonly frameRate: number;

  private readonly frameFlux: RingBuffer;
  private readonly frameLowFlux: RingBuffer;
  private readonly frameHighFlux: RingBuffer;
  private readonly frameRms: RingBuffer;
  private readonly frameBands: RingMatrix;

  private readonly beatBands: RingMatrix;
  private readonly beatOnsets: RingMatrix;
  private readonly beatTimes: RingBuffer;
  private readonly rawBars: RingMatrix;
  /** Observed onset times paired with their beat index, for the grid fit. */
  private readonly observations: RingMatrix;

  private streamStartTime: number | null = null;
  private latestFrameTime = 0;
  private framesSeen = 0;

  private smoothedBands = { low: 0, mid: 0, high: 0 };
  private smoothedLevel = 0;

  private tempoState: LiveTempoState = "idle";
  private bpm = 126;
  private periodSeconds = 60 / 126;
  private tempoConfidence = 0;
  private lastTempoEvalTime = -Infinity;
  private readonly recentEstimates: number[] = [];
  private disagreements = 0;
  private fixedBpm: number | null = null;

  private beatAnchorTime: number | null = null;
  private beatAnchorIndex = 0;
  private pendingBeatIndex = 0;
  private beatsEmitted = 0;
  private phaseError = 0;

  private barOffsetBeats = 0;
  private downbeatConfidence = 0;
  private downbeatTapped = false;
  private phraseOffsetBars = 0;

  private barsSeen = 0;
  private currentEnergy = 1;
  private phrase: LivePhraseState = { kind: "intro", startBar: 0, bars: 0, energy: 1 };
  private status = "Waiting for audio.";

  constructor(sampleRate: number, options: LiveAnalysisOptions = {}) {
    this.sampleRate = sampleRate;
    this.options = { ...DEFAULTS, ...options };
    this.analyzer = new SpectralAnalyzer(sampleRate);
    this.frameRate = this.analyzer.frameRate;

    const frames = Math.ceil(this.options.tempoWindowSeconds * this.frameRate) + 8;
    this.frameFlux = new RingBuffer(frames);
    this.frameLowFlux = new RingBuffer(frames);
    this.frameHighFlux = new RingBuffer(frames);
    this.frameRms = new RingBuffer(frames);
    this.frameBands = new RingMatrix(frames, BAND_COUNT);

    this.beatBands = new RingMatrix(BEAT_HISTORY, BAND_COUNT);
    this.beatOnsets = new RingMatrix(BEAT_HISTORY, 3);
    this.beatTimes = new RingBuffer(BEAT_HISTORY);
    this.rawBars = new RingMatrix(BAR_HISTORY, BAR_FEATURE_COUNT);
    this.observations = new RingMatrix(GRID_FIT_BEATS, 2);
  }

  get running(): boolean {
    return this.streamStartTime !== null;
  }

  get currentBpm(): number {
    if (this.fixedBpm !== null) {
      return this.fixedBpm;
    }
    // Once locked the fitted period is the more precise figure; before that
    // the rolling estimate is all there is.
    return this.tempoState === "locked" ? 60 / this.periodSeconds : this.bpm;
  }

  get hasFixedBpm(): boolean {
    return this.fixedBpm !== null;
  }

  get fixedBpmValue(): number | null {
    return this.fixedBpm;
  }

  setFixedBpm(bpm: number): void {
    this.fixedBpm = clampBpm(bpm, this.options);
    this.bpm = this.fixedBpm;
    this.periodSeconds = 60 / this.fixedBpm;
    this.tempoState = "locked";
    this.tempoConfidence = 1;
    this.recentEstimates.length = 0;
    this.status = `Fixed at ${this.fixedBpm} BPM.`;
    if (this.running) {
      this.seedPhase();
    }
  }

  clearFixedBpm(): void {
    this.fixedBpm = null;
    this.tempoState = this.running ? "listening" : "idle";
    this.recentEstimates.length = 0;
    this.status = "Listening for tempo.";
  }

  /**
   * Declares the given moment to be beat 1 of a phrase.
   *
   * An operator tapping a downbeat is more reliable than any detector, so this
   * overrides the estimated bar and phrase phase and keeps them pinned.
   */
  tapDownbeat(atTime: number): void {
    if (this.beatAnchorTime === null) {
      this.beatAnchorTime = atTime;
      this.beatAnchorIndex = 0;
      this.pendingBeatIndex = 0;
    }
    const position = this.beatPositionAt(atTime);
    const nearest = Math.round(position);
    this.barOffsetBeats = ((nearest % 4) + 4) % 4;
    this.phraseOffsetBars = ((Math.floor((nearest - this.barOffsetBeats) / 4) % 8) + 8) % 8;
    this.downbeatConfidence = 1;
    this.downbeatTapped = true;
    this.status = "Downbeat set by tap.";
  }

  reset(): void {
    for (const ring of [this.frameFlux, this.frameLowFlux, this.frameHighFlux, this.frameRms, this.beatTimes]) {
      ring.clear();
    }
    for (const matrix of [this.frameBands, this.beatBands, this.beatOnsets, this.rawBars, this.observations]) {
      matrix.clear();
    }
    this.streamStartTime = null;
    this.framesSeen = 0;
    this.tempoState = "idle";
    this.tempoConfidence = 0;
    this.lastTempoEvalTime = -Infinity;
    this.recentEstimates.length = 0;
    this.disagreements = 0;
    this.beatAnchorTime = null;
    this.beatAnchorIndex = 0;
    this.pendingBeatIndex = 0;
    this.beatsEmitted = 0;
    this.phaseError = 0;
    this.barOffsetBeats = 0;
    this.downbeatConfidence = 0;
    this.downbeatTapped = false;
    this.phraseOffsetBars = 0;
    this.barsSeen = 0;
    this.currentEnergy = 1;
    this.phraseHadBass = null;
    this.phrase = { kind: "intro", startBar: 0, bars: 0, energy: 1 };
    this.status = "Waiting for audio.";
  }

  /**
   * Feeds captured mono samples.
   *
   * `firstSampleTime` is the audio-clock time of `samples[0]`. Frame times are
   * derived from the stream start plus the sample count, not from the arrival
   * time of each block, so irregular capture callbacks cannot shift the grid.
   */
  push(samples: Float32Array, firstSampleTime: number): void {
    if (this.streamStartTime === null) {
      this.streamStartTime = firstSampleTime;
      this.tempoState = this.fixedBpm === null ? "listening" : "locked";
      this.status = this.fixedBpm === null ? "Listening for tempo." : this.status;
    }
    const streamStart = this.streamStartTime;
    this.analyzer.push(samples, (frame) => {
      this.onFrame(frame, streamStart + frame.timeSeconds);
    });
  }

  private onFrame(
    frame: {
      flux: number;
      lowFlux: number;
      highFlux: number;
      rms: number;
      bands: Float32Array;
    },
    frameTime: number
  ): void {
    this.latestFrameTime = frameTime;
    this.framesSeen += 1;
    this.frameFlux.push(frame.flux);
    this.frameLowFlux.push(frame.lowFlux);
    this.frameHighFlux.push(frame.highFlux);
    this.frameRms.push(frame.rms);
    this.frameBands.push(frame.bands);

    // Smoothed band levels drive reactive visuals. Kept separate from the
    // onset functions, which must stay sharp to be useful for tracking.
    const blend = (previous: number, next: number): number =>
      previous + (next > previous ? 0.45 : 0.12) * (next - previous);
    this.smoothedBands = {
      low: blend(this.smoothedBands.low, bandAverage(frame.bands, 0, 6)),
      mid: blend(this.smoothedBands.mid, bandAverage(frame.bands, 6, 16)),
      high: blend(this.smoothedBands.high, bandAverage(frame.bands, 16, BAND_COUNT))
    };
    this.smoothedLevel = blend(this.smoothedLevel, Math.min(1, frame.rms * 6));

    this.maybeEstimateTempo(frameTime);
    this.advanceBeats(frameTime);
  }

  // ---------------------------------------------------------------- tempo

  private maybeEstimateTempo(frameTime: number): void {
    if (this.fixedBpm !== null) {
      return;
    }
    if (this.frameFlux.length < Math.ceil(6 * this.frameRate)) {
      return;
    }
    if (frameTime - this.lastTempoEvalTime < this.options.tempoIntervalSeconds) {
      return;
    }
    this.lastTempoEvalTime = frameTime;

    const estimate = estimateTempo(this.tempoEnvelope(), {
      minBpm: this.options.minBpm,
      maxBpm: this.options.maxBpm,
      combTeeth: LIVE_COMB_TEETH
    });

    this.recentEstimates.push(estimate.bpm);
    if (this.recentEstimates.length > LOCK_REQUIRED_AGREEMENTS) {
      this.recentEstimates.shift();
    }

    if (this.tempoState !== "locked") {
      this.bpm = estimate.bpm;
      this.periodSeconds = 60 / estimate.bpm;
      this.tempoConfidence = estimate.confidence * 0.6;
      this.status = `Listening: ${estimate.bpm.toFixed(1)} BPM`;
      const agreed =
        this.recentEstimates.length >= LOCK_REQUIRED_AGREEMENTS &&
        this.recentEstimates.every(
          (candidate) => Math.abs(candidate - estimate.bpm) / estimate.bpm <= LOCK_TOLERANCE
        );
      if (agreed) {
        this.tempoState = "locked";
        this.tempoConfidence = Math.max(0.7, estimate.confidence);
        this.seedPhase();
        this.status = `Locked at ${this.bpm.toFixed(1)} BPM`;
      }
      return;
    }

    // Once locked, only a sustained disagreement relocks - which is what a DJ
    // transition into a different tempo looks like, as opposed to a breakdown
    // briefly starving the estimator of onsets.
    if (Math.abs(estimate.bpm - this.bpm) / this.bpm > 0.03) {
      this.disagreements += 1;
      if (this.disagreements >= UNLOCK_REQUIRED_DISAGREEMENTS) {
        this.disagreements = 0;
        this.bpm = estimate.bpm;
        this.periodSeconds = 60 / estimate.bpm;
        this.recentEstimates.length = 0;
        this.seedPhase();
        this.status = `Relocked at ${this.bpm.toFixed(1)} BPM`;
      }
    } else {
      this.disagreements = Math.max(0, this.disagreements - 1);
    }
  }

  private tempoEnvelope() {
    // Broadband-weighted: the offline sweep showed tempo estimation benefits
    // from every onset in the mix, while beat phase wants the kick.
    return blendOnsetEnvelopes(
      normalizeOnsetEnvelope(this.frameFlux.toArray(), this.frameRate, 0),
      normalizeOnsetEnvelope(this.frameLowFlux.toArray(), this.frameRate, 0),
      0.4
    );
  }

  // ---------------------------------------------------------------- beats

  /**
   * Seeds the beat phase by comb search over the recent window.
   *
   * Letting the phase-locked loop converge from an arbitrary start takes
   * several bars and reads as broken on screen, so the phase is seeded the
   * same way the offline path fits it, including the kick-band on-beat check.
   */
  private seedPhase(): void {
    const available = this.frameFlux.length;
    if (available < Math.ceil(4 * this.frameRate)) {
      return;
    }
    const windowStart = this.latestFrameTime - (available - 1) / this.frameRate;
    const tracking = blendOnsetEnvelopes(
      normalizeOnsetEnvelope(this.frameFlux.toArray(), this.frameRate, 0),
      normalizeOnsetEnvelope(this.frameLowFlux.toArray(), this.frameRate, 0),
      0.9
    );
    const kick = normalizeOnsetEnvelope(this.frameLowFlux.toArray(), this.frameRate, 0);
    const span = (available - 1) / this.frameRate;

    const combAt = (values: Float32Array, offset: number): number => {
      let total = 0;
      let count = 0;
      for (let time = offset; time <= span; time += this.periodSeconds) {
        total += sampleAt(values, time * this.frameRate);
        count += 1;
      }
      return count ? total / count : 0;
    };

    let bestOffset = 0;
    let bestScore = -Infinity;
    const steps = 160;
    for (let step = 0; step < steps; step += 1) {
      const offset = (step / steps) * this.periodSeconds;
      const score = combAt(tracking.values, offset);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    const half = (bestOffset + this.periodSeconds / 2) % this.periodSeconds;
    if (combAt(kick.values, half) > combAt(kick.values, bestOffset) * 0.95) {
      bestOffset = half;
    }

    // Re-anchor on the next beat after the newest frame, keeping the existing
    // beat numbering so bar and phrase phase survive a relock.
    const anchor = windowStart + bestOffset;
    const beatsAhead = Math.ceil((this.latestFrameTime - anchor) / this.periodSeconds);
    const previousIndex = this.beatAnchorTime === null ? beatsAhead : this.pendingBeatIndex;
    this.beatAnchorTime = anchor + beatsAhead * this.periodSeconds;
    this.beatAnchorIndex = previousIndex;
    this.pendingBeatIndex = previousIndex;
    this.phaseError = 0;
    // Observations were made against the previous grid; they would drag the
    // new fit back toward the tempo we just abandoned.
    this.observations.clear();
  }

  private beatPositionAt(atTime: number): number {
    if (this.beatAnchorTime === null) {
      return 0;
    }
    return this.beatAnchorIndex + (atTime - this.beatAnchorTime) / this.periodSeconds;
  }

  private timeOfBeat(index: number): number {
    return (this.beatAnchorTime ?? 0) + (index - this.beatAnchorIndex) * this.periodSeconds;
  }

  private advanceBeats(frameTime: number): void {
    if (this.beatAnchorTime === null) {
      return;
    }
    // Wait a full beat past each beat before recording it, so its band
    // energies cover the whole beat exactly as the offline path defines them.
    // This delays `onBeat` and the grid corrections by one beat, which costs
    // nothing on screen: `snapshot()` extrapolates from the fitted grid and is
    // therefore predictive, not reactive.
    const settle = this.periodSeconds * 1.15;
    let guard = 0;
    while (guard < 64) {
      guard += 1;
      const beatTime = this.timeOfBeat(this.pendingBeatIndex);
      if (beatTime + settle > frameTime) {
        break;
      }
      this.observeBeat(this.pendingBeatIndex, beatTime);
      this.recordBeat(this.pendingBeatIndex, this.timeOfBeat(this.pendingBeatIndex));
      this.pendingBeatIndex += 1;
    }
  }

  /**
   * Records where the onset for this beat actually landed.
   *
   * The grid itself is not moved here. A per-beat correction chases the local
   * onset peak, which is quantised to the analysis hop and carries real
   * micro-timing, so the anchor random-walks and the grid ends up looser than
   * the music. Instead the observation is stored and the whole grid is refit.
   */
  private observeBeat(index: number, predictedTime: number): void {
    const available = this.frameLowFlux.length;
    if (available < 8) {
      return;
    }
    const values = this.frameLowFlux.toArray();
    const windowStart = this.latestFrameTime - (available - 1) / this.frameRate;
    const radius = this.periodSeconds * 0.22;
    const step = 1 / this.frameRate / 2;

    let bestTime = predictedTime;
    let bestValue = -Infinity;
    for (let time = predictedTime - radius; time <= predictedTime + radius; time += step) {
      const value = sampleAt(values, (time - windowStart) * this.frameRate);
      if (value > bestValue) {
        bestValue = value;
        bestTime = time;
      }
    }

    // With no real onset to lock to - a breakdown with the kick dropped out -
    // the grid should coast on its existing fit rather than chase noise.
    const mean = arrayMean(values);
    if (bestValue < mean * 1.2) {
      return;
    }

    this.observations.push([index, bestTime]);
    this.phaseError = this.phaseError * 0.8 + Math.abs((bestTime - predictedTime) / this.periodSeconds) * 0.2;
    this.tempoConfidence = Math.max(0, Math.min(1, 1 - this.phaseError * 4));
    this.refitGrid();
  }

  /**
   * Refits anchor and period by least squares over recent observations.
   *
   * This is the live equivalent of the offline regular-grid fit: averaging
   * dozens of beats is far more accurate than following any single one, and it
   * yields a grid that is smooth enough to drive visuals without stutter.
   */
  private refitGrid(): void {
    const count = this.observations.length;
    if (count < MIN_OBSERVATIONS_FOR_FIT || this.beatAnchorTime === null) {
      return;
    }

    let anchor = this.beatAnchorTime;
    let period = this.periodSeconds;
    const target = this.fixedBpm !== null ? 60 / this.fixedBpm : 60 / this.bpm;

    for (let pass = 0; pass < 2; pass += 1) {
      let sumIndex = 0;
      let sumTime = 0;
      let sumIndexSquared = 0;
      let sumProduct = 0;
      let used = 0;
      for (let age = 0; age < count; age += 1) {
        const offset = this.observations.offsetFromEnd(age);
        const index = this.observations.data[offset];
        const time = this.observations.data[offset + 1];
        const predicted = anchor + (index - this.beatAnchorIndex) * period;
        // Second pass rejects outliers against the first pass's line.
        if (pass > 0 && Math.abs(time - predicted) > period * 0.2) {
          continue;
        }
        sumIndex += index;
        sumTime += time;
        sumIndexSquared += index * index;
        sumProduct += index * time;
        used += 1;
      }
      if (used < MIN_OBSERVATIONS_FOR_FIT) {
        return;
      }
      const denominator = used * sumIndexSquared - sumIndex * sumIndex;
      if (Math.abs(denominator) < 1e-9) {
        return;
      }
      const slope = (used * sumProduct - sumIndex * sumTime) / denominator;
      const intercept = (sumTime - slope * sumIndex) / used;
      if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
        return;
      }
      period = slope;
      anchor = intercept + this.beatAnchorIndex * slope;
    }

    // A fixed BPM is a promise to the operator; honour the period exactly and
    // let the fit supply only the phase.
    if (this.fixedBpm !== null) {
      period = target;
    } else {
      period = Math.min(target * 1.03, Math.max(target * 0.97, period));
    }
    this.periodSeconds = period;
    this.beatAnchorTime = anchor;
  }

  private recordBeat(index: number, beatTime: number): void {
    const available = this.frameBands.length;
    if (!available) {
      return;
    }
    const newestFrameTime = this.latestFrameTime;
    const ageOf = (time: number): number => Math.round((newestFrameTime - time) * this.frameRate);

    // Mean band energies across the beat, matching the offline definition.
    const startAge = Math.min(available - 1, Math.max(0, ageOf(beatTime)));
    const endAge = Math.min(available - 1, Math.max(0, ageOf(beatTime + this.periodSeconds)));
    const row = new Float32Array(BAND_COUNT);
    let frames = 0;
    for (let age = endAge; age <= startAge; age += 1) {
      const offset = this.frameBands.offsetFromEnd(age);
      for (let band = 0; band < BAND_COUNT; band += 1) {
        row[band] += this.frameBands.data[offset + band];
      }
      frames += 1;
    }
    if (frames > 0) {
      for (let band = 0; band < BAND_COUNT; band += 1) {
        row[band] /= frames;
      }
    }
    this.beatBands.push(row);
    this.beatTimes.push(beatTime);

    // Peak onset strength in a short window bracketing the beat, as offline:
    // a single frame misses the transient whenever the grid is a few
    // milliseconds off.
    const firstAge = Math.min(available - 1, Math.max(0, ageOf(beatTime + 0.09)));
    const lastAge = Math.min(available - 1, Math.max(0, ageOf(beatTime - 0.04)));
    let lowPeak = 0;
    let rmsPeak = 0;
    let highPeak = 0;
    for (let age = firstAge; age <= lastAge; age += 1) {
      lowPeak = Math.max(lowPeak, this.frameLowFlux.fromEnd(age));
      rmsPeak = Math.max(rmsPeak, this.frameRms.fromEnd(age));
      highPeak = Math.max(highPeak, this.frameHighFlux.fromEnd(age));
    }
    this.beatOnsets.push([lowPeak, rmsPeak, highPeak]);
    this.beatsEmitted += 1;

    if (this.onBeat) {
      const relative = index - this.barOffsetBeats;
      this.onBeat({
        index,
        time: beatTime,
        beatInBar: (((relative % 4) + 4) % 4) + 1,
        bar: Math.floor(relative / 4)
      });
    }

    if (this.beatsEmitted % 4 === 0) {
      this.updateBarPhase();
    }
    if (((index - this.barOffsetBeats) % 4 + 4) % 4 === 0) {
      this.onBarComplete();
    }
  }

  // ------------------------------------------------------------ bar phase

  /**
   * Builds a `BeatFeatures` view over the beat ring.
   *
   * Copying the window lets the live path call the exact offline estimators,
   * which is the only way to be sure the two agree about what a downbeat is.
   */
  private beatFeaturesWindow(): BeatFeatures | null {
    const count = Math.min(this.beatBands.length, this.beatOnsets.length);
    if (count < MIN_BEATS_FOR_BAR_PHASE) {
      return null;
    }
    const bands = new Float32Array(count * BAND_COUNT);
    const lowOnset = new Float32Array(count);
    const rms = new Float32Array(count);
    const highOnset = new Float32Array(count);
    const midOnset = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const age = count - 1 - index;
      const source = this.beatBands.offsetFromEnd(age);
      bands.set(this.beatBands.data.subarray(source, source + BAND_COUNT), index * BAND_COUNT);
      const onsets = this.beatOnsets.offsetFromEnd(age);
      lowOnset[index] = this.beatOnsets.data[onsets];
      rms[index] = this.beatOnsets.data[onsets + 1];
      highOnset[index] = this.beatOnsets.data[onsets + 2];
      // The offline features carry a separate mid-band onset; the live rings
      // keep loudness instead, which is the closer stand-in of what we have.
      midOnset[index] = this.beatOnsets.data[onsets + 1];
    }
    return { count, lowOnset, highOnset, midOnset, rms, bands };
  }

  /**
   * Re-estimates which beat phase starts a bar.
   *
   * Uses the local cues from the offline study - bass movement and two-bar
   * loop repetition were the two that carried real signal - because the
   * phrase-scale novelty term needs more history than a live window holds.
   * A tapped downbeat outranks all of it.
   */
  private updateBarPhase(): void {
    if (this.downbeatTapped) {
      return;
    }
    const window = this.beatFeaturesWindow();
    if (!window) {
      return;
    }

    let windowPhase: number;
    let margin: number;
    let phraseBarInWindow: number | null = null;

    if (window.count >= MIN_BEATS_FOR_METRIC_GRID) {
      // Enough history for the full offline estimator, which resolves the bar
      // phase jointly with the 8-bar phrase phase. Its `startPrior` weight is
      // zero, which is exactly right here: live capture starts wherever the
      // operator pressed record, not at bar 1 of the track.
      const grid = estimateMetricGrid(window);
      windowPhase = grid.originBeat % 4;
      phraseBarInWindow = Math.floor(grid.originBeat / 4) % 8;
      margin = grid.confidence;
    } else {
      // Before that, fall back to the local cues that carried real signal in
      // the offline study: bass movement and two-bar loop repetition.
      const cues = downbeatCueScores(window);
      const scores = [0, 1, 2, 3].map(
        (phase) => cues.bassChange[phase] + cues.twoBarRepeat[phase] * 0.5 + cues.backbeat[phase] * 0.3
      );
      windowPhase = scores.indexOf(Math.max(...scores));
      const sorted = [...scores].sort((left, right) => right - left);
      margin = sorted[0] - sorted[1];
    }

    // Translate the window's phase into absolute beat numbering. The newest
    // beat in the window is the one just recorded.
    const newest = this.pendingBeatIndex;
    const shift = newest - (window.count - 1);
    const absolute = ((windowPhase + shift) % 4 + 4) % 4;

    // Hysteresis: only move bar 1 when the new answer is clearly ahead, so a
    // marginal call cannot make the visuals flip bar 1 back and forth.
    if (absolute !== this.barOffsetBeats && margin < 0.2 && this.downbeatConfidence > 0.3) {
      return;
    }
    this.barOffsetBeats = absolute;
    this.downbeatConfidence = Math.max(0, Math.min(1, margin * 3));

    if (phraseBarInWindow !== null) {
      const absoluteOriginBeat = phraseBarInWindow * 4 + windowPhase + shift;
      const originBar = Math.floor((absoluteOriginBeat - absolute) / 4);
      this.phraseOffsetBars = ((originBar % 8) + 8) % 8;
    }
  }

  // ------------------------------------------------------ bars and phrases

  private onBarComplete(): void {
    const row = this.collectBarRow();
    if (!row) {
      return;
    }
    this.rawBars.push(row);
    this.barsSeen += 1;

    const normalized = this.normalizedBarRow();
    if (!normalized) {
      return;
    }
    this.currentEnergy = Math.round(energyFromFeatures(normalized, 0));
    this.updatePhraseState(normalized);
  }

  /** Raw bar features from the last four beats, in the offline column order. */
  private collectBarRow(): Float32Array | null {
    if (this.beatBands.length < 4) {
      return null;
    }
    const bandTotals = new Float64Array(BAND_COUNT);
    let kick = 0;
    let rms = 0;
    let hats = 0;
    for (let age = 0; age < 4; age += 1) {
      const bandOffset = this.beatBands.offsetFromEnd(age);
      for (let band = 0; band < BAND_COUNT; band += 1) {
        bandTotals[band] += this.beatBands.data[bandOffset + band];
      }
      const onsetOffset = this.beatOnsets.offsetFromEnd(age);
      kick += this.beatOnsets.data[onsetOffset];
      rms += this.beatOnsets.data[onsetOffset + 1];
      hats += this.beatOnsets.data[onsetOffset + 2];
    }

    const row = new Float32Array(BAR_FEATURE_COUNT);
    BAND_RANGES.forEach(([, start, end], column) => {
      let total = 0;
      for (let band = start; band < end; band += 1) {
        total += bandTotals[band];
      }
      row[column] = total / (4 * (end - start));
    });
    row[5] = rms / 4;
    row[6] = kick / 4;
    row[7] = hats / 4;
    return row;
  }

  /**
   * Normalises the newest bar against a rolling window of recent bars.
   *
   * The offline path uses whole-track percentiles, which live capture cannot
   * see. A rolling window is the causal equivalent and has the side benefit of
   * adapting when the DJ moves to a differently mastered record.
   */
  private normalizedBarRow(): Float32Array | null {
    const count = this.rawBars.length;
    if (count < 4) {
      return null;
    }
    const normalized = new Float32Array(BAR_FEATURE_COUNT);
    const column = new Float64Array(count);
    for (let index = 0; index < BAR_FEATURE_COUNT; index += 1) {
      for (let age = 0; age < count; age += 1) {
        column[age] = this.rawBars.data[this.rawBars.offsetFromEnd(age) + index];
      }
      const sorted = Array.from(column).sort((left, right) => left - right);
      const low = sorted[Math.floor(sorted.length * 0.05)];
      const high = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      const range = high - low;
      const value = this.rawBars.data[this.rawBars.offsetFromEnd(0) + index];
      // Only stretch a column that genuinely varies. Over a steady groove the
      // window is nearly flat, and rescaling it to 0-1 would turn measurement
      // noise into apparent structure - which reads on screen as the phrase
      // detector changing its mind every bar for no reason.
      const meaningful = range > Math.max(1e-6, Math.abs(high) * FLAT_COLUMN_FRACTION);
      normalized[index] = meaningful ? Math.max(0, Math.min(1, (value - low) / range)) : 0.5;
    }
    return normalized;
  }

  /**
   * Advances the phrase state machine by one bar.
   *
   * Boundaries are only allowed on bar lines, and a state has to hold for four
   * bars before it can change - except a drop, which is allowed to fire
   * immediately because arriving late to a drop is the one error a VJ tool
   * cannot make.
   */
  private updatePhraseState(row: Float32Array): void {
    const bass = (row[0] + row[1]) / 2;
    const rms = row[5];
    const trend = this.recentTrend(4);
    const bassPresent = bass > 0.42;
    const loud = rms > 0.58;
    const dwell = this.barsSeen - this.phrase.startBar;

    // Bar features are normalised against a rolling window, so early bars are
    // measured against almost no context and their levels mean little. Watch
    // without acting until there is enough history to compare against.
    if (this.rawBars.length < PHRASE_WARMUP_BARS) {
      this.phraseHadBass = bassPresent;
      this.phrase = { ...this.phrase, kind: bassPresent ? "groove" : "intro", bars: dwell };
      return;
    }

    let next: PhraseKind = this.phrase.kind;
    // A drop is bass arriving where there was none. `phraseHadBass` starts
    // undefined rather than false: capture usually begins mid-track, and
    // treating "we have not looked yet" as "there was no bass" fires a drop on
    // the first loud bar, which is the worst possible thing to open on.
    const bassReturned = this.phraseHadBass === false && bassPresent;

    if (bassReturned && loud && dwell >= MIN_PHRASE_BARS) {
      // Drops are allowed to interrupt early - arriving late to a drop is the
      // one mistake a VJ tool cannot make - but not on consecutive bars.
      next = "drop";
    } else if (dwell < PHRASE_DWELL_BARS) {
      next = this.phrase.kind;
    } else if (!bassPresent && trend.air > 0.1 && trend.rms > 0.02) {
      next = "build";
    } else if (!bassPresent) {
      next = "breakdown";
    } else if (loud && this.phrase.kind === "build") {
      next = "drop";
    } else {
      next = this.phrase.kind === "drop" && dwell < 16 ? "drop" : "groove";
    }

    this.phraseHadBass = bassPresent;

    if (next === this.phrase.kind) {
      this.phrase = { ...this.phrase, bars: dwell, energy: this.currentEnergy };
      return;
    }

    this.phrase = { kind: next, startBar: this.barsSeen, bars: 0, energy: this.currentEnergy };
    // A detected phrase change is a phrase start by definition, which is a
    // stronger anchor for the 8-bar grid than any statistical estimate.
    if (next === "drop" || next === "breakdown" || next === "build") {
      this.phraseOffsetBars = ((this.barsSeen % 8) + 8) % 8;
    }
    this.status = `${capitalize(next)} at bar ${this.barsSeen}`;
  }

  /** `null` until the first bar has been classified. */
  private phraseHadBass: boolean | null = null;

  /** Change in air and loudness across the last `bars` bars. */
  private recentTrend(bars: number): { air: number; rms: number } {
    const count = Math.min(this.rawBars.length, bars);
    if (count < 2) {
      return { air: 0, rms: 0 };
    }
    const at = (age: number, column: number): number =>
      this.rawBars.data[this.rawBars.offsetFromEnd(age) + column];
    const newestAir = at(0, 4);
    const oldestAir = at(count - 1, 4);
    const newestRms = at(0, 5);
    const oldestRms = at(count - 1, 5);
    const scale = Math.max(1e-6, Math.abs(oldestAir) + Math.abs(oldestRms));
    return {
      air: (newestAir - oldestAir) / scale,
      rms: (newestRms - oldestRms) / scale
    };
  }

  // ------------------------------------------------------------- snapshot

  snapshot(atTime: number): LiveMusicalState {
    const beatPosition = this.beatPositionAt(atTime);
    const beatFloor = Math.floor(beatPosition);
    const beatPhase = beatPosition - beatFloor;
    const relative = beatFloor - this.barOffsetBeats;
    const beatInBar = ((relative % 4) + 4) % 4;
    const bar = Math.floor(relative / 4);
    const barPhase = (beatInBar + beatPhase) / 4;
    const phraseBar = (((bar - this.phraseOffsetBars) % 8) + 8) % 8;

    return {
      tempoState: this.tempoState,
      bpm: this.currentBpm,
      tempoConfidence: this.tempoConfidence,
      beatPosition,
      beatPhase,
      beatInBar: beatInBar + 1,
      bar,
      barPhase,
      phraseBar,
      phrasePhase: (phraseBar + barPhase) / 8,
      downbeatConfidence: this.downbeatConfidence,
      phrase: this.phrase,
      energy: this.currentEnergy,
      bands: { ...this.smoothedBands },
      level: this.smoothedLevel,
      status: this.status
    };
  }
}

function bandAverage(bands: Float32Array, start: number, end: number): number {
  let total = 0;
  for (let band = start; band < end; band += 1) {
    total += bands[band];
  }
  const count = Math.max(1, end - start);
  // Band energies are log-compressed; about 7 is full scale.
  return Math.max(0, Math.min(1, total / count / 7));
}

function arrayMean(values: Float32Array): number {
  if (!values.length) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

function clampBpm(value: number, options: Required<LiveAnalysisOptions>): number {
  if (!Number.isFinite(value)) {
    return 126;
  }
  return Math.max(options.minBpm, Math.min(options.maxBpm, Math.round(value)));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
