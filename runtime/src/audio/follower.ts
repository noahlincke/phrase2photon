import { BAND_COUNT, type SpectralFeatures } from "./spectral.js";

/**
 * Audio-to-reference position following, so the visuals can follow a DJ
 * through loops, cue jumps and scrubs.
 *
 * Now Playing knows *which* track is playing and has already analysed it, but
 * it only learns the playhead position from whatever the DJ application
 * reports - which is coarse, laggy, and in rekordbox's case inferred from file
 * read offsets that do not move backwards when a loop does. Projecting that
 * position forward assumes the track plays start to finish, which is exactly
 * the assumption a DJ breaks.
 *
 * So instead of asking the application where the playhead is, this listens to
 * the audio and matches it against the analysed track. A loop is then not a
 * special case to be told about: it is simply the matched position going
 * backwards by a musically round number of beats.
 *
 * Matching runs on a two-level pyramid. A coarse level is cheap enough to
 * rescan the whole track every column, which is what makes jumps detectable
 * within about a tenth of a second rather than whenever a rescan happens to
 * come round. The best coarse candidates are then refined against the fine
 * level for position accuracy.
 */

/** Spectral frames averaged into one fine column. */
export const FOLLOW_DECIMATION = 4;
/** Fine columns per coarse column. */
export const FOLLOW_COARSE_STRIDE = 4;
/** Feature dimensions folded into one coarse dimension. */
const COARSE_FOLD = 3;

/**
 * Feature layout: whitened band energies, then half-wave-rectified deltas.
 *
 * Raw band energies are a poor match feature because every moment of a track
 * shares the same broad spectral tilt, so everything correlates with
 * everything at around 0.75 and nothing is distinguishable. Whitening each
 * band by its own mean and spread across the track removes that shared shape
 * and leaves only what is actually varying. The rectified delta half adds
 * where the onsets are, which is the most position-specific thing in a mix.
 */
const FEATURE_BANDS = BAND_COUNT;
export const FOLLOW_FEATURE_DIM = FEATURE_BANDS * 2;
const FOLLOW_COARSE_DIM = FOLLOW_FEATURE_DIM / COARSE_FOLD;
/** Weight on the delta half relative to the whitened-energy half. */
const DELTA_WEIGHT = 1;
/** Floor on a band's spread, so a silent band cannot blow up when whitened. */
const MIN_BAND_DEVIATION = 1e-3;

/** Fine columns compared per match, ~2.2 s at 44.1 kHz. */
export const FOLLOW_WINDOW_COLUMNS = 48;
/**
 * Shortest suffix of the window that may be matched on its own, ~0.7 s.
 *
 * A loop shorter than the window means the newest audio and the audio from
 * just before the loop point are not contiguous in the reference, so no full
 * window ever matches cleanly. Scoring every suffix length and keeping the
 * best is what lets a 1- or 4-beat loop be recognised at all.
 */
const MIN_MATCH_COLUMNS = 16;
/**
 * Shrinkage constant, in columns, biasing the choice towards longer suffixes.
 *
 * Short suffixes match spuriously all over a track, so their mean similarity
 * is divided by `length + SUFFIX_PRIOR` rather than `length`. A long window
 * with real evidence then beats a short window that got lucky.
 */
const SUFFIX_PRIOR = 10;
/** Fine columns searched either side of the predicted position while tracking. */
const TRACK_SEARCH_RADIUS = 10;
/** Coarse candidates refined per column. */
const COARSE_CANDIDATES = 6;
/** Coarse columns suppressed either side of an accepted coarse peak. */
const COARSE_SUPPRESSION = 3;

/**
 * Below this the match is not trusted at all.
 *
 * On the shrunk scale, so a full window of similarity `raw` scores
 * `raw * windowColumns / (windowColumns + SUFFIX_PRIOR)`.
 */
const SCORE_FLOOR = 0.16;
/** A rival position must beat the tracked one by this much to take over. */
const JUMP_SCORE_MARGIN = 0.04;
/** Consecutive columns a rival must win before the jump is accepted. */
const JUMP_CONFIRM_COLUMNS = 2;
/** Columns of sub-floor scoring before tracking is declared lost. */
const LOST_COLUMNS = 12;
/** Position changes smaller than this are drift, not a jump. */
const JUMP_MIN_SECONDS = 0.35;
/**
 * Seconds of audio the live whitening statistics average over.
 *
 * Long enough to describe the track rather than the current bar, so it lands
 * near the whole-track statistics the reference was whitened with.
 */
const LIVE_STATS_SECONDS = 20;

/**
 * Seconds of live feature history kept for loop detection.
 *
 * Has to cover the longest loop worth detecting plus the window compared
 * against it, so 32 beats at a slow tempo still fits.
 */
const LOOP_HISTORY_SECONDS = 36;
/** Columns compared when testing a candidate loop lag. */
const LOOP_MATCH_COLUMNS = 16;
/**
 * Self-similarity a candidate lag must reach to count as a loop.
 *
 * This is the whole trick. Four-to-the-floor music repeats itself musically -
 * bar 9 sounds much like bar 8 - which is why matching against the reference
 * alone produces far more phantom loops than real ones. But a deck in a loop
 * replays the *same samples*, so the live signal correlates with its own past
 * at the loop lag far more strongly than mere musical repetition ever does.
 * The gap between those two cases is real but its tails overlap, which is why
 * this is measured rather than assumed. Over 24 Mixed In Key tracks
 * (`npm run bench:loopsep`), live self-similarity ran at a median of 0.978
 * while a deck looped and 0.791 while a track merely played:
 *
 *     threshold   loop recall   false positives
 *       0.86         95.0%          32.1%
 *       0.90         85.5%          20.1%
 *       0.94         76.9%           9.3%
 *       0.96         67.9%           5.9%
 *
 * 0.94 is the knee. The per-column false-positive rate there is further cut by
 * requiring consecutive columns and by discounting repetition the reference
 * already has, which is what brings it down to roughly one spurious loop per
 * six tracks end to end.
 */
const LOOP_SELF_SIMILARITY = 0.86;
/**
 * How much a shorter lag may score below the best one and still be preferred.
 *
 * A four-beat loop repeats at eight and sixteen beats too, so without this the
 * detector would report whichever multiple happened to score highest.
 */
const LOOP_SHORTER_LAG_SLACK = 0.04;
/** Columns of failing self-similarity before an established loop is released. */
const LOOP_RELEASE_COLUMNS = 4;
/**
 * How far self-similarity may fall before an established loop is released.
 *
 * Small on purpose: a loop that has been released keeps forcing wraps until it
 * is noticed, and each of those is a wrong event and a wrong position.
 */
const LOOP_RELEASE_SLACK = 0.04;
/**
 * How much more the live signal must repeat than the reference already does.
 *
 * Without this, any track with a copy-pasted drum bar reads as a permanent
 * four-beat loop.
 */
const LOOP_EXCESS_MARGIN = 0.06;

/** Loop lengths a DJ can actually dial in, in beats. */
const LOOP_BEAT_LENGTHS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
/** Fraction of the loop length a measured jump may differ by and still count. */
const LOOP_BEAT_TOLERANCE = 0.12;

export interface FollowPrint {
  sampleRate: number;
  /** Fine columns per second. */
  columnRate: number;
  /**
   * Reference time of column zero, in seconds.
   *
   * Spectral frames are timed at their centre, so frame zero already sits
   * `FRAME_SIZE / 2` samples in, and a column spans several frames on top of
   * that. Treating column index as time directly left every reported position
   * about 60 ms early - most of the budget of a 100 ms accuracy target spent
   * on an off-by-one.
   */
  columnOffsetSeconds: number;
  columnCount: number;
  featureDim: number;
  /** `columnCount * featureDim`, mean-removed and L2-normalised per column. */
  fine: Float32Array;
  coarseCount: number;
  coarseDim: number;
  coarseStride: number;
  coarse: Float32Array;
  /**
   * How much the reference repeats itself at each candidate loop lag.
   *
   * `columnCount * LOOP_BEAT_LENGTHS.length`, row-major by column. Dance music
   * is built out of copy-pasted bars, so a track can repeat at a four-beat lag
   * almost as exactly as a looping deck does. Knowing where the track already
   * does that is what stops the arrangement being mistaken for a DJ.
   */
  selfSimilarity: Float32Array;
  loopLagBeats: readonly number[];
  durationSeconds: number;
  /** Reference tempo, used to read jump sizes in beats. */
  tempo: number;
  /** Seconds of the first downbeat, carried through for grid alignment. */
  firstDownbeatSeconds: number;
}

export type FollowState = "searching" | "tracking" | "lost";
export type FollowJumpKind = "loop" | "seek" | "restart";

export interface FollowJump {
  kind: FollowJumpKind;
  fromSeconds: number;
  toSeconds: number;
  /** Signed jump size in reference beats; negative means backwards. */
  beats: number;
}

export interface FollowLoop {
  /** Loop length in beats, snapped to a length a DJ can dial in. */
  beats: number;
  startSeconds: number;
  endSeconds: number;
  /** How many times round; 1 on the first repeat. */
  repeats: number;
}

export interface FollowStatus {
  state: FollowState;
  /** Best estimate of the playhead in the reference track, in seconds. */
  positionSeconds: number;
  /** Match quality of the current position, 0-1. */
  confidence: number;
  /** Playback rate relative to the reference, from the pitch fader. */
  rate: number;
  loop: FollowLoop | null;
  /** Set only on the column a jump was accepted, so callers can react once. */
  jump: FollowJump | null;
}

const IDLE_STATUS: FollowStatus = {
  state: "searching",
  positionSeconds: 0,
  confidence: 0,
  rate: 1,
  loop: null,
  jump: null
};

/** Mean-removes and L2-normalises one column in place. */
function normaliseColumn(data: Float32Array, offset: number, width: number): void {
  let mean = 0;
  for (let index = 0; index < width; index += 1) {
    mean += data[offset + index];
  }
  mean /= width;

  let sumSquares = 0;
  for (let index = 0; index < width; index += 1) {
    const centred = data[offset + index] - mean;
    data[offset + index] = centred;
    sumSquares += centred * centred;
  }

  // A flat column carries no shape information - silence, or a single
  // sustained tone. Zeroing it makes it score zero everywhere rather than
  // matching every other flat column in the track.
  const norm = Math.sqrt(sumSquares);
  if (norm < 1e-6) {
    data.fill(0, offset, offset + width);
    return;
  }
  for (let index = 0; index < width; index += 1) {
    data[offset + index] /= norm;
  }
}

/** Averages runs of `COARSE_FOLD` dimensions into the coarse feature. */
function foldFeature(source: Float32Array, sourceOffset: number, target: Float32Array, targetOffset: number): void {
  for (let group = 0; group < FOLLOW_COARSE_DIM; group += 1) {
    let total = 0;
    for (let step = 0; step < COARSE_FOLD; step += 1) {
      total += source[sourceOffset + group * COARSE_FOLD + step];
    }
    target[targetOffset + group] = total / COARSE_FOLD;
  }
}

/**
 * Writes the match feature for one column into `target`.
 *
 * Shared by the reference print and the live follower so the two sides cannot
 * drift apart - the same failure the analysis core avoids by construction.
 */
function writeFeature(
  raw: Float32Array,
  previousRaw: Float32Array | null,
  mean: Float32Array,
  deviation: Float32Array,
  target: Float32Array,
  targetOffset: number
): void {
  for (let band = 0; band < FEATURE_BANDS; band += 1) {
    const spread = Math.max(MIN_BAND_DEVIATION, deviation[band]);
    target[targetOffset + band] = (raw[band] - mean[band]) / spread;
    const rise = previousRaw === null ? 0 : Math.max(0, raw[band] - previousRaw[band]);
    target[targetOffset + FEATURE_BANDS + band] = (DELTA_WEIGHT * rise) / spread;
  }
  normaliseColumn(target, targetOffset, FOLLOW_FEATURE_DIM);
}

/**
 * Builds the reference print a follower matches against.
 *
 * Takes already-computed spectral features so the print costs nothing extra
 * when the track has just been analysed.
 */
export function buildFollowPrint(
  features: SpectralFeatures,
  options: { tempo: number; firstDownbeatSeconds?: number }
): FollowPrint {
  const columnCount = Math.max(1, Math.floor(features.frameCount / FOLLOW_DECIMATION));

  // Decimate to fine columns of raw band energy first; whitening needs the
  // statistics of the columns actually being matched, not of the frames.
  const raw = new Float32Array(columnCount * FEATURE_BANDS);
  for (let column = 0; column < columnCount; column += 1) {
    const target = column * FEATURE_BANDS;
    for (let step = 0; step < FOLLOW_DECIMATION; step += 1) {
      const frame = column * FOLLOW_DECIMATION + step;
      if (frame >= features.frameCount) {
        break;
      }
      const source = frame * FEATURE_BANDS;
      for (let band = 0; band < FEATURE_BANDS; band += 1) {
        raw[target + band] += features.bands[source + band];
      }
    }
    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      raw[target + band] /= FOLLOW_DECIMATION;
    }
  }

  const mean = new Float32Array(FEATURE_BANDS);
  const deviation = new Float32Array(FEATURE_BANDS);
  for (let column = 0; column < columnCount; column += 1) {
    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      mean[band] += raw[column * FEATURE_BANDS + band];
    }
  }
  for (let band = 0; band < FEATURE_BANDS; band += 1) {
    mean[band] /= columnCount;
  }
  for (let column = 0; column < columnCount; column += 1) {
    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      const centred = raw[column * FEATURE_BANDS + band] - mean[band];
      deviation[band] += centred * centred;
    }
  }
  for (let band = 0; band < FEATURE_BANDS; band += 1) {
    deviation[band] = Math.sqrt(deviation[band] / columnCount);
  }

  const fine = new Float32Array(columnCount * FOLLOW_FEATURE_DIM);
  for (let column = 0; column < columnCount; column += 1) {
    writeFeature(
      raw.subarray(column * FEATURE_BANDS, (column + 1) * FEATURE_BANDS),
      column === 0 ? null : raw.subarray((column - 1) * FEATURE_BANDS, column * FEATURE_BANDS),
      mean,
      deviation,
      fine,
      column * FOLLOW_FEATURE_DIM
    );
  }

  const coarseCount = Math.max(1, Math.floor(columnCount / FOLLOW_COARSE_STRIDE));
  const coarse = new Float32Array(coarseCount * FOLLOW_COARSE_DIM);
  const scratch = new Float32Array(FOLLOW_COARSE_DIM);
  for (let column = 0; column < coarseCount; column += 1) {
    const target = column * FOLLOW_COARSE_DIM;
    for (let step = 0; step < FOLLOW_COARSE_STRIDE; step += 1) {
      const fineColumn = column * FOLLOW_COARSE_STRIDE + step;
      if (fineColumn >= columnCount) {
        break;
      }
      foldFeature(fine, fineColumn * FOLLOW_FEATURE_DIM, scratch, 0);
      for (let index = 0; index < FOLLOW_COARSE_DIM; index += 1) {
        coarse[target + index] += scratch[index] / FOLLOW_COARSE_STRIDE;
      }
    }
    normaliseColumn(coarse, target, FOLLOW_COARSE_DIM);
  }

  const columnRate = features.frameRate / FOLLOW_DECIMATION;
  // Align a column with the newest frame it contains, which is the frame the
  // caller has just handed over, so the reported position means "now".
  const columnOffsetSeconds = (features.times[0] ?? 0) + (FOLLOW_DECIMATION - 1) / features.frameRate;
  const beatColumns = (60 / options.tempo) * columnRate;
  const selfSimilarity = new Float32Array(columnCount * LOOP_BEAT_LENGTHS.length);
  for (let lagIndex = 0; lagIndex < LOOP_BEAT_LENGTHS.length; lagIndex += 1) {
    const lag = Math.round(LOOP_BEAT_LENGTHS[lagIndex] * beatColumns);
    for (let column = 0; column < columnCount; column += 1) {
      const span = Math.min(LOOP_MATCH_COLUMNS, lag);
      if (lag < 4 || column - lag - span < 0) {
        continue;
      }
      let total = 0;
      for (let age = 0; age < span; age += 1) {
        const recent = (column - age) * FOLLOW_FEATURE_DIM;
        const past = (column - age - lag) * FOLLOW_FEATURE_DIM;
        let dot = 0;
        for (let index = 0; index < FOLLOW_FEATURE_DIM; index += 1) {
          dot += fine[recent + index] * fine[past + index];
        }
        total += dot;
      }
      selfSimilarity[column * LOOP_BEAT_LENGTHS.length + lagIndex] = total / span;
    }
  }

  return {
    sampleRate: features.sampleRate,
    columnRate,
    columnOffsetSeconds,
    columnCount,
    featureDim: FOLLOW_FEATURE_DIM,
    fine,
    coarseCount,
    coarseDim: FOLLOW_COARSE_DIM,
    coarseStride: FOLLOW_COARSE_STRIDE,
    coarse,
    selfSimilarity,
    loopLagBeats: LOOP_BEAT_LENGTHS,
    durationSeconds: columnCount / columnRate,
    tempo: options.tempo,
    firstDownbeatSeconds: options.firstDownbeatSeconds ?? 0
  };
}

/**
 * Snaps a measured jump to a loop length, or returns null if it is not one.
 *
 * DJ loops are set in powers of two beats, so a backwards jump of very nearly
 * 4 beats is a 4-beat loop and a backwards jump of 5.5 beats is someone
 * dragging the needle.
 */
export function snapLoopBeats(beats: number): number | null {
  const magnitude = Math.abs(beats);
  for (const candidate of LOOP_BEAT_LENGTHS) {
    if (Math.abs(magnitude - candidate) <= candidate * LOOP_BEAT_TOLERANCE) {
      return candidate;
    }
  }
  return null;
}

export interface PositionFollowerOptions {
  /** Fine columns compared per match. Shorter reacts faster, matches worse. */
  windowColumns?: number;
  /** Override the self-similarity threshold, for studies. */
  loopSimilarity?: number;
}

interface MatchResult {
  column: number;
  /** Length-shrunk score, for ranking candidates against each other. */
  score: number;
  /** Plain mean similarity of the winning suffix, for reporting. */
  confidence: number;
}

const NO_MATCH: MatchResult = { column: -1, score: -1, confidence: 0 };

export class PositionFollower {
  private readonly print: FollowPrint;
  private readonly windowColumns: number;
  private readonly coarseWindow: number;
  private readonly minCoarseColumns: number;

  /** Live feature columns as a ring of `windowColumns` rows, newest last. */
  private readonly window: Float32Array;
  private readonly coarseWindowData: Float32Array;
  private windowWrite = 0;
  private windowFilled = 0;

  /** Decimation accumulator, and the previous column's raw energies. */
  private readonly accumulator = new Float32Array(FEATURE_BANDS);
  private readonly rawColumn = new Float32Array(FEATURE_BANDS);
  private readonly previousRawColumn = new Float32Array(FEATURE_BANDS);
  private hasPreviousRaw = false;
  private accumulated = 0;

  /** Rolling per-band statistics mirroring the reference whitening. */
  private readonly liveMean = new Float32Array(FEATURE_BANDS);
  private readonly liveVariance = new Float32Array(FEATURE_BANDS);
  private readonly liveDeviation = new Float32Array(FEATURE_BANDS);
  private readonly featureScratch = new Float32Array(FOLLOW_FEATURE_DIM);

  private state: FollowState = "searching";
  private positionColumn = 0;
  private confidence = 0;
  private rate = 1;
  private rateHint = 1;
  private lostColumns = 0;
  private columnsSeen = 0;

  private rivalColumn = -1;
  private rivalStreak = 0;

  /** Rolling history of live feature columns, for self-similarity. */
  private readonly history: Float32Array;
  private readonly historyCapacity: number;
  private historyWrite = 0;
  private historyFilled = 0;
  private readonly loopSimilarity: number;
  private loopLagColumns = 0;
  private loopBeats = 0;
  private loopStreak = 0;
  private loopMissStreak = 0;
  /** Columns until another wrap is allowed; a loop wraps once per round. */
  private wrapCooldown = 0;

  private loop: FollowLoop | null = null;
  private pendingJump: FollowJump | null = null;
  private lastPositionSeconds = 0;

  constructor(print: FollowPrint, options: PositionFollowerOptions = {}) {
    this.print = print;
    this.windowColumns = Math.max(MIN_MATCH_COLUMNS, options.windowColumns ?? FOLLOW_WINDOW_COLUMNS);
    this.coarseWindow = Math.max(2, Math.floor(this.windowColumns / print.coarseStride));
    this.minCoarseColumns = Math.max(2, Math.floor(MIN_MATCH_COLUMNS / print.coarseStride));
    this.window = new Float32Array(this.windowColumns * FOLLOW_FEATURE_DIM);
    this.coarseWindowData = new Float32Array(this.windowColumns * FOLLOW_COARSE_DIM);
    this.loopSimilarity = options.loopSimilarity ?? LOOP_SELF_SIMILARITY;
    this.historyCapacity = Math.ceil(LOOP_HISTORY_SECONDS * print.columnRate) + LOOP_MATCH_COLUMNS;
    this.history = new Float32Array(this.historyCapacity * FOLLOW_FEATURE_DIM);
  }

  /** Reference time of a fine column, including the front-end frame offset. */
  private columnSeconds(column: number): number {
    return this.print.columnOffsetSeconds + column / this.print.columnRate;
  }

  get status(): FollowStatus {
    if (this.state === "searching" && this.columnsSeen === 0) {
      return { ...IDLE_STATUS };
    }
    return {
      state: this.state,
      positionSeconds: this.columnSeconds(this.positionColumn),
      confidence: this.confidence,
      rate: this.rate,
      loop: this.loop === null ? null : { ...this.loop },
      jump: this.pendingJump === null ? null : { ...this.pendingJump }
    };
  }

  /**
   * Tells the follower how fast the deck is running relative to the reference.
   *
   * The live tempo estimate divided by the reference tempo is a far better
   * source for this than anything recoverable from the match itself, so the
   * caller passes it in rather than the follower guessing.
   */
  setRateHint(rate: number): void {
    if (Number.isFinite(rate) && rate > 0.5 && rate < 2) {
      this.rateHint = rate;
    }
  }

  reset(): void {
    this.window.fill(0);
    this.coarseWindowData.fill(0);
    this.windowWrite = 0;
    this.windowFilled = 0;
    this.accumulator.fill(0);
    this.rawColumn.fill(0);
    this.previousRawColumn.fill(0);
    this.hasPreviousRaw = false;
    this.accumulated = 0;
    this.liveMean.fill(0);
    this.liveVariance.fill(0);
    this.liveDeviation.fill(0);
    this.state = "searching";
    this.positionColumn = 0;
    this.confidence = 0;
    this.rate = 1;
    this.lostColumns = 0;
    this.columnsSeen = 0;
    this.rivalColumn = -1;
    this.rivalStreak = 0;
    this.history.fill(0);
    this.historyWrite = 0;
    this.historyFilled = 0;
    this.loopLagColumns = 0;
    this.loopBeats = 0;
    this.loopStreak = 0;
    this.loopMissStreak = 0;
    this.wrapCooldown = 0;
    this.loop = null;
    this.pendingJump = null;
    this.lastPositionSeconds = 0;
  }

  /**
   * Pushes one spectral frame's band energies.
   *
   * Returns the status after every frame, but only does matching work once
   * `FOLLOW_DECIMATION` frames have accumulated into a column.
   */
  pushFrame(bands: Float32Array): FollowStatus {
    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      this.accumulator[band] += bands[band];
    }
    this.accumulated += 1;
    if (this.accumulated < FOLLOW_DECIMATION) {
      // Jumps are reported on the column that accepted them and not again, so
      // a caller polling every frame sees each one once.
      return { ...this.status, jump: null };
    }

    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      this.accumulator[band] /= FOLLOW_DECIMATION;
    }
    const result = this.pushColumn(this.accumulator);
    this.accumulator.fill(0);
    this.accumulated = 0;
    return result;
  }

  /** Pushes one already-decimated column of band energies. */
  pushColumn(bands: Float32Array): FollowStatus {
    this.pendingJump = null;
    this.columnsSeen += 1;
    this.rate = this.rateHint;
    this.updateLiveStatistics(bands);
    this.appendColumn(bands);
    this.updateLoopLag();
    if (this.wrapCooldown > 0) {
      this.wrapCooldown -= 1;
    }

    if (this.windowFilled < MIN_MATCH_COLUMNS) {
      return this.status;
    }

    const predicted = this.state === "tracking" ? this.positionColumn + this.rate : this.positionColumn;
    const tracked =
      this.state === "tracking"
        ? this.bestFineMatch(
            Math.round(predicted) - TRACK_SEARCH_RADIUS,
            Math.round(predicted) + TRACK_SEARCH_RADIUS
          )
        : NO_MATCH;

    const rival = this.bestGlobalMatch(tracked.column);

    if (this.state !== "tracking") {
      return this.acquire(rival);
    }
    return this.continueTracking(tracked, rival);
  }

  /**
   * Updates the rolling per-band mean and spread used to whiten live columns.
   *
   * Averaged over `LIVE_STATS_SECONDS` so it converges on something close to
   * the whole-track statistics the reference was whitened with; a short window
   * would describe the current bar instead and the two sides would not be
   * comparable. Early on the running average is used instead, because an
   * exponential estimate seeded from one column claims a spread of zero.
   */
  private updateLiveStatistics(bands: Float32Array): void {
    const timeConstant = Math.max(1, LIVE_STATS_SECONDS * this.print.columnRate);
    const alpha = Math.max(1 / this.columnsSeen, 1 / timeConstant);
    for (let band = 0; band < FEATURE_BANDS; band += 1) {
      const delta = bands[band] - this.liveMean[band];
      this.liveMean[band] += alpha * delta;
      this.liveVariance[band] += alpha * (delta * delta - this.liveVariance[band]);
      this.liveDeviation[band] = Math.sqrt(this.liveVariance[band]);
    }
  }

  private acquire(rival: MatchResult): FollowStatus {
    if (rival.score < SCORE_FLOOR) {
      this.confidence = Math.max(0, rival.confidence);
      this.lostColumns += 1;
      if (this.lostColumns > LOST_COLUMNS && this.state === "searching" && this.columnsSeen > this.windowColumns) {
        this.state = "lost";
      }
      return this.status;
    }
    // Require the same candidate twice so a single lucky column does not
    // latch the follower onto the wrong part of the track.
    if (this.rivalColumn >= 0 && Math.abs(rival.column - (this.rivalColumn + this.rate)) <= 3) {
      this.rivalStreak += 1;
    } else {
      this.rivalStreak = 1;
    }
    this.rivalColumn = rival.column;
    if (this.rivalStreak < JUMP_CONFIRM_COLUMNS) {
      return this.status;
    }

    this.state = "tracking";
    this.positionColumn = rival.column;
    this.confidence = rival.confidence;
    this.lostColumns = 0;
    this.rivalStreak = 0;
    this.rivalColumn = -1;
    this.loop = null;
    this.lastPositionSeconds = this.columnSeconds(this.positionColumn);
    return this.status;
  }

  private continueTracking(tracked: MatchResult, rival: MatchResult): FollowStatus {
    // While a loop is running, the position going back by exactly the loop
    // length is not a rival hypothesis to be argued down - it is the expected
    // next thing to happen, so it only has to match better than carrying on.
    if (this.loopLagColumns > 0) {
      const wrapped = this.bestFineMatch(
        tracked.column - this.loopLagColumns - TRACK_SEARCH_RADIUS,
        tracked.column - this.loopLagColumns + TRACK_SEARCH_RADIUS
      );
      // Wrap when carrying on has stopped fitting the reference, which pins
      // the wrap to the real loop boundary. Forcing a wrap every L beats
      // regardless was tried instead and measured worse: it gained three
      // percentage points of recall for nine times the spurious reports,
      // because a loop that has been released keeps wrapping until noticed.
      if (wrapped.column >= 0 && wrapped.score > tracked.score + JUMP_SCORE_MARGIN && this.wrapCooldown <= 0) {
        this.applyLoopWrap(wrapped);
        return this.status;
      }
    }

    const takeover =
      rival.column >= 0 && rival.score >= SCORE_FLOOR && rival.score > tracked.score + JUMP_SCORE_MARGIN;

    if (takeover) {
      if (this.rivalColumn >= 0 && Math.abs(rival.column - (this.rivalColumn + this.rate)) <= 3) {
        this.rivalStreak += 1;
      } else {
        this.rivalStreak = 1;
      }
      this.rivalColumn = rival.column;
      if (this.rivalStreak >= JUMP_CONFIRM_COLUMNS) {
        this.applyJump(rival);
        return this.status;
      }
    } else {
      this.rivalStreak = 0;
      this.rivalColumn = -1;
    }

    if (tracked.score < SCORE_FLOOR) {
      this.lostColumns += 1;
      if (this.lostColumns > LOST_COLUMNS) {
        this.state = "searching";
        this.loop = null;
        this.confidence = 0;
      }
      // Keep coasting at the last known rate while the match is poor; a few
      // bad columns during a transition should not stall the visuals.
      this.positionColumn += this.rate;
      return this.status;
    }

    this.lostColumns = 0;
    this.confidence = tracked.confidence;
    this.positionColumn = tracked.column;
    this.updateLoopExit();
    this.lastPositionSeconds = this.columnSeconds(this.positionColumn);
    return this.status;
  }

  private applyJump(rival: MatchResult): void {
    const fromSeconds = this.lastPositionSeconds;
    const toSeconds = this.columnSeconds(rival.column);
    const deltaSeconds = toSeconds - fromSeconds;

    this.positionColumn = rival.column;
    this.confidence = rival.confidence;
    this.lostColumns = 0;
    this.rivalStreak = 0;
    this.rivalColumn = -1;
    this.lastPositionSeconds = toSeconds;

    if (Math.abs(deltaSeconds) < JUMP_MIN_SECONDS) {
      return;
    }

    const beats = (deltaSeconds * this.print.tempo) / 60;
    this.loop = null;
    this.pendingJump = {
      kind: toSeconds < JUMP_MIN_SECONDS ? "restart" : "seek",
      fromSeconds,
      toSeconds,
      beats
    };
  }

  /**
   * Tracks whether the deck is currently replaying audio it just played.
   *
   * Kept separate from reference matching on purpose: the reference cannot
   * distinguish a loop from the track's own musical repetition, and the live
   * signal can.
   */
  private updateLoopLag(): void {
    if (this.loopLagColumns > 0) {
      // An established loop only has to keep holding, which it is allowed to
      // stop doing for a moment during a filter sweep or an EQ move.
      const score = this.selfSimilarity(this.loopLagColumns);
      if (score >= this.loopSimilarity - LOOP_RELEASE_SLACK) {
        this.loopMissStreak = 0;
        return;
      }
      this.loopMissStreak += 1;
      if (this.loopMissStreak > LOOP_RELEASE_COLUMNS) {
        this.loopLagColumns = 0;
        this.loopBeats = 0;
        this.loopMissStreak = 0;
        this.loop = null;
      }
      return;
    }

    const detected = this.detectLoopLag();
    if (detected === null) {
      this.loopStreak = 0;
      return;
    }
    this.loopStreak += 1;
    if (this.loopStreak < JUMP_CONFIRM_COLUMNS) {
      return;
    }
    this.loopStreak = 0;
    this.loopLagColumns = detected.lagColumns;
    this.loopBeats = detected.beats;
    this.loopMissStreak = 0;
    this.wrapCooldown = 0;
  }

  /** Moves the playhead back round the loop and reports it once. */
  private applyLoopWrap(wrapped: MatchResult): void {
    const fromSeconds = this.columnSeconds(this.positionColumn);
    const toSeconds = this.columnSeconds(wrapped.column);

    this.positionColumn = wrapped.column;
    this.confidence = wrapped.confidence;
    this.lostColumns = 0;
    this.rivalStreak = 0;
    this.rivalColumn = -1;
    this.lastPositionSeconds = toSeconds;
    this.wrapCooldown = Math.max(1, this.loopLagColumns);

    const sameLoop = this.loop !== null && this.loop.beats === this.loopBeats;
    this.loop = {
      beats: this.loopBeats,
      startSeconds: toSeconds,
      endSeconds: fromSeconds,
      repeats: sameLoop ? (this.loop?.repeats ?? 0) + 1 : 1
    };
    this.pendingJump = {
      kind: "loop",
      fromSeconds,
      toSeconds,
      beats: -this.loopBeats
    };
  }

  /**
   * Clears the loop once the playhead runs past where the loop ended.
   *
   * A DJ releasing a loop is not an event we get told about; it shows up as
   * the position simply continuing past the loop-out point.
   */
  private updateLoopExit(): void {
    if (this.loop === null) {
      return;
    }
    const positionSeconds = this.columnSeconds(this.positionColumn);
    const slack = (60 / this.print.tempo) * 0.5;
    if (positionSeconds > this.loop.endSeconds + slack) {
      this.loop = null;
    }
  }

  private appendColumn(bands: Float32Array): void {
    this.rawColumn.set(bands);
    writeFeature(
      this.rawColumn,
      this.hasPreviousRaw ? this.previousRawColumn : null,
      this.liveMean,
      this.liveDeviation,
      this.featureScratch,
      0
    );
    this.previousRawColumn.set(this.rawColumn);
    this.hasPreviousRaw = true;

    const fineOffset = this.windowWrite * FOLLOW_FEATURE_DIM;
    this.window.set(this.featureScratch, fineOffset);
    const coarseOffset = this.windowWrite * FOLLOW_COARSE_DIM;
    foldFeature(this.window, fineOffset, this.coarseWindowData, coarseOffset);
    normaliseColumn(this.coarseWindowData, coarseOffset, FOLLOW_COARSE_DIM);

    this.history.set(this.featureScratch, this.historyWrite * FOLLOW_FEATURE_DIM);
    this.historyWrite = (this.historyWrite + 1) % this.historyCapacity;
    this.historyFilled = Math.min(this.historyCapacity, this.historyFilled + 1);

    this.windowWrite = (this.windowWrite + 1) % this.windowColumns;
    this.windowFilled = Math.min(this.windowColumns, this.windowFilled + 1);
  }

  /**
   * Live self-similarity at a candidate loop length, for threshold studies.
   *
   * Returns -1 when there is not yet enough history to judge.
   */
  selfSimilarityForBeats(beats: number): number {
    const lagColumns = Math.round((beats * 60 * this.print.columnRate) / this.print.tempo / this.rate);
    return this.selfSimilarity(lagColumns);
  }

  /** Ring index of the history column `age` back from the newest. */
  private historyIndex(age: number): number {
    return (this.historyWrite - 1 - age + this.historyCapacity * 2) % this.historyCapacity;
  }

  /**
   * Mean similarity between the newest live columns and the same columns
   * `lagColumns` earlier in the live signal.
   */
  private selfSimilarity(lagColumns: number): number {
    const span = Math.min(LOOP_MATCH_COLUMNS, lagColumns);
    if (span < 2 || this.historyFilled < lagColumns + span) {
      return -1;
    }
    let total = 0;
    for (let age = 0; age < span; age += 1) {
      const recent = this.historyIndex(age) * FOLLOW_FEATURE_DIM;
      const past = this.historyIndex(age + lagColumns) * FOLLOW_FEATURE_DIM;
      let dot = 0;
      for (let index = 0; index < FOLLOW_FEATURE_DIM; index += 1) {
        dot += this.history[recent + index] * this.history[past + index];
      }
      total += dot;
    }
    return total / span;
  }

  /**
   * Looks for the deck replaying audio it just played.
   *
   * Returns the loop length in beats, or null. Prefers the shortest lag that
   * explains the repetition, since a four-beat loop also repeats at eight.
   */
  private detectLoopLag(): { beats: number; lagColumns: number } | null {
    const beatSeconds = 60 / this.print.tempo / this.rate;
    let best: { beats: number; lagColumns: number; score: number } | null = null;
    for (let lagIndex = 0; lagIndex < LOOP_BEAT_LENGTHS.length; lagIndex += 1) {
      const beats = LOOP_BEAT_LENGTHS[lagIndex];
      const lagColumns = Math.round(beats * beatSeconds * this.print.columnRate);
      if (lagColumns < 4 || lagColumns + LOOP_MATCH_COLUMNS > this.historyFilled) {
        continue;
      }
      const score = this.selfSimilarity(lagColumns);
      if (score < this.loopSimilarity) {
        continue;
      }
      // The arrangement may already repeat at this lag, in which case the
      // live repetition is evidence of nothing.
      const excess = score - this.referenceSelfSimilarity(lagIndex);
      if (excess < LOOP_EXCESS_MARGIN) {
        continue;
      }
      if (best === null || score > best.score + LOOP_SHORTER_LAG_SLACK) {
        best = { beats, lagColumns, score };
      }
    }
    return best === null ? null : { beats: best.beats, lagColumns: best.lagColumns };
  }

  /** How much the reference itself repeats at `lagIndex`, around the playhead. */
  private referenceSelfSimilarity(lagIndex: number): number {
    const lagCount = this.print.loopLagBeats.length;
    const centre = Math.round(this.positionColumn);
    let best = 0;
    // Take the strongest repetition anywhere nearby, so a position estimate
    // that is a bar out cannot make the arrangement look unrepetitive.
    for (let offset = -LOOP_MATCH_COLUMNS; offset <= LOOP_MATCH_COLUMNS; offset += 4) {
      const column = centre + offset;
      if (column < 0 || column >= this.print.columnCount) {
        continue;
      }
      best = Math.max(best, this.print.selfSimilarity[column * lagCount + lagIndex]);
    }
    return best;
  }

  /** Ring index of the window column `age` back from the newest. */
  private windowIndex(age: number): number {
    return (this.windowWrite - 1 - age + this.windowColumns * 2) % this.windowColumns;
  }

  /**
   * Scores the live window against the reference ending at `endColumn`.
   *
   * The live window is walked backwards from newest and stepped through the
   * reference at `rate`, so a deck running off-tempo still lines up. Every
   * suffix length is scored as it goes and the best one wins: the newest audio
   * is the part guaranteed to be contiguous with the current position, whereas
   * anything older may sit on the far side of a loop or a cue jump.
   */
  private scoreFine(endColumn: number): { score: number; confidence: number } {
    if (endColumn < 0 || endColumn >= this.print.columnCount) {
      return { score: -1, confidence: 0 };
    }
    let running = 0;
    let best = -1;
    let bestConfidence = 0;
    const available = Math.min(this.windowColumns, this.windowFilled);
    for (let age = 0; age < available; age += 1) {
      const referenceColumn = Math.round(endColumn - age * this.rate);
      if (referenceColumn < 0) {
        break;
      }
      const referenceOffset = referenceColumn * FOLLOW_FEATURE_DIM;
      const liveOffset = this.windowIndex(age) * FOLLOW_FEATURE_DIM;
      let dot = 0;
      for (let index = 0; index < FOLLOW_FEATURE_DIM; index += 1) {
        dot += this.window[liveOffset + index] * this.print.fine[referenceOffset + index];
      }
      running += dot;

      const length = age + 1;
      if (length < MIN_MATCH_COLUMNS) {
        continue;
      }
      const shrunk = running / (length + SUFFIX_PRIOR);
      if (shrunk > best) {
        best = shrunk;
        bestConfidence = running / length;
      }
    }
    return { score: best, confidence: bestConfidence };
  }

  private scoreCoarse(endCoarseColumn: number): number {
    if (endCoarseColumn < 0 || endCoarseColumn >= this.print.coarseCount) {
      return -1;
    }
    const stride = this.print.coarseStride;
    let running = 0;
    let best = -1;
    const available = Math.min(this.coarseWindow, Math.floor(this.windowFilled / stride));
    for (let age = 0; age < available; age += 1) {
      const referenceColumn = Math.round(endCoarseColumn - age * this.rate);
      if (referenceColumn < 0) {
        break;
      }
      const referenceOffset = referenceColumn * FOLLOW_COARSE_DIM;
      // The live window is stored at fine resolution, so step it by the
      // coarse stride to line the two up.
      const liveOffset = this.windowIndex(age * stride) * FOLLOW_COARSE_DIM;
      let dot = 0;
      for (let index = 0; index < FOLLOW_COARSE_DIM; index += 1) {
        dot += this.coarseWindowData[liveOffset + index] * this.print.coarse[referenceOffset + index];
      }
      running += dot;

      const length = age + 1;
      if (length < this.minCoarseColumns) {
        continue;
      }
      const shrunk = running / (length + SUFFIX_PRIOR / stride);
      if (shrunk > best) {
        best = shrunk;
      }
    }
    return best;
  }

  private bestFineMatch(from: number, to: number): MatchResult {
    let best = NO_MATCH;
    const start = Math.max(0, from);
    const end = Math.min(this.print.columnCount - 1, to);
    for (let column = start; column <= end; column += 1) {
      const scored = this.scoreFine(column);
      if (scored.score > best.score) {
        best = { column, score: scored.score, confidence: scored.confidence };
      }
    }
    return best;
  }

  /**
   * Full-track rescan, excluding the neighbourhood already being tracked.
   *
   * Running this every column is what makes a loop detectable within about a
   * tenth of a second, which is why the coarse level exists at all.
   */
  private bestGlobalMatch(excludeFineColumn: number): MatchResult {
    const excludeCoarse = excludeFineColumn >= 0 ? Math.round(excludeFineColumn / this.print.coarseStride) : -1;
    const excludeRadius = Math.ceil((TRACK_SEARCH_RADIUS + 1) / this.print.coarseStride) + 1;

    const candidates: { column: number; score: number }[] = [];
    for (let column = 0; column < this.print.coarseCount; column += 1) {
      if (excludeCoarse >= 0 && Math.abs(column - excludeCoarse) <= excludeRadius) {
        continue;
      }
      const score = this.scoreCoarse(column);
      if (score <= 0) {
        continue;
      }
      candidates.push({ column, score });
    }
    candidates.sort((left, right) => right.score - left.score);

    const chosen: number[] = [];
    for (const candidate of candidates) {
      if (chosen.length >= COARSE_CANDIDATES) {
        break;
      }
      if (chosen.some((column) => Math.abs(column - candidate.column) <= COARSE_SUPPRESSION)) {
        continue;
      }
      chosen.push(candidate.column);
    }

    let best = NO_MATCH;
    for (const coarseColumn of chosen) {
      const centre = coarseColumn * this.print.coarseStride;
      const refined = this.bestFineMatch(centre - this.print.coarseStride * 2, centre + this.print.coarseStride * 2);
      if (refined.score > best.score) {
        best = refined;
      }
    }
    return best;
  }
}
