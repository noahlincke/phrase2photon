import type { LiveMusicalState } from "../audio/liveAnalysis.js";
import type { NowPlayingClockSample } from "./types.js";

/**
 * The on-air deck's Rekordbox beat grid, served by /api/now-playing/grid.
 *
 * Rekordbox analysed every deck track, and Noah fixes those grids by hand, so
 * whenever an exact deck sample and a grid describe the same deck track the
 * grid outranks the live analyser's bar phase: the PQTZ beat times place the
 * playhead inside the bar exactly, where the room-audio estimate is wrong
 * about half the time. Energy, bands and phrase state keep coming from the
 * live analyser.
 */

export interface NowPlayingDeckGrid {
  deck: number;
  anlzPath: string;
  title: string | null;
  artist: string | null;
  /** Track seconds of every analysed beat, in track order. */
  beatSeconds: number[];
  /** Indexes into `beatSeconds` of the beats Rekordbox marked as beat 1. */
  downbeatIndexes: number[];
}

/** The grid's musical position at one track second. */
export interface DeckGridPhase {
  /** Absolute beat position in the grid; the fraction is the beat phase. */
  beatPosition: number;
  /** 0-1 within the current beat. */
  beatPhase: number;
  /** 1-4. */
  beatInBar: number;
  /** Bar index in the track, counted from the first downbeat. */
  bar: number;
}

export function validateDeckGridPayload(payload: unknown): NowPlayingDeckGrid | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const deck = record.deck;
  const anlzPath = record.anlzPath ?? record.anlz_path;
  const beatSeconds = readNumberArray(record.beatSeconds ?? record.beat_seconds);
  const downbeatIndexes = readNumberArray(record.downbeatIndexes ?? record.downbeat_indexes);
  if (
    typeof deck !== "number" ||
    !Number.isInteger(deck) ||
    typeof anlzPath !== "string" ||
    !beatSeconds ||
    !downbeatIndexes
  ) {
    return null;
  }
  return {
    deck,
    anlzPath,
    title: typeof record.title === "string" ? record.title : null,
    artist: typeof record.artist === "string" ? record.artist : null,
    beatSeconds,
    downbeatIndexes
  };
}

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : null;
}

/**
 * Whether a grid and an exact clock sample describe the same deck track.
 *
 * This is the fallback-clock identity check's counterpart for shows that were
 * never resolved: deck number plus the ANLZ path pin both to one track.
 */
export function deckGridMatchesSample(
  candidate: NowPlayingDeckGrid,
  sample: NowPlayingClockSample
): boolean {
  return sample.deck !== null && candidate.deck === sample.deck && candidate.anlzPath === sample.anlzPath;
}

export interface DeckGridClockInput {
  grid: NowPlayingDeckGrid | null;
  /** The exact deck sample the playhead rides; null when none is fresh. */
  deck: number | null;
  anlzPath: string | null;
  /** The status observation gating the exact clock. */
  observationDeck: number | null;
  positionSource: string | null;
  playbackPositionSeconds: number | null;
  /** Projected track position right now, or null without an exact anchor. */
  trackSeconds: number | null;
}

/**
 * The grid phase for an exact deck clock, or null whenever any part of the
 * identity chain does not hold: the observation must be an exact deck clock,
 * the sample must carry an ANLZ path, and the grid must belong to that same
 * deck track.
 */
export function deckGridPhaseForClock(input: DeckGridClockInput): DeckGridPhase | null {
  if (
    input.trackSeconds === null ||
    input.positionSource !== "exact" ||
    input.observationDeck === null ||
    input.playbackPositionSeconds === null ||
    input.deck === null ||
    input.anlzPath === null ||
    input.grid === null
  ) {
    return null;
  }
  // The observation and the clock sample must describe the same deck, or the
  // playhead and the status it is gated on belong to different tracks.
  if (
    input.grid.deck !== input.deck ||
    input.observationDeck !== input.deck ||
    input.grid.anlzPath !== input.anlzPath
  ) {
    return null;
  }
  return deckGridPhaseAt(input.grid, input.trackSeconds);
}

/**
 * The grid's beat and bar position at one track second.
 *
 * Returns null while the playhead sits before the first downbeat: the grid
 * cannot say which beat of a bar that lead-in belongs to, so the live estimate
 * keeps the phase until the grid can.
 */
export function deckGridPhaseAt(candidate: NowPlayingDeckGrid, trackSeconds: number): DeckGridPhase | null {
  const beats = candidate.beatSeconds;
  const downbeats = candidate.downbeatIndexes;
  if (beats.length < 2 || downbeats.length === 0 || trackSeconds < beats[0]) {
    return null;
  }

  // Last analysed beat at or before the playhead; past the end the grid
  // extrapolates on its final beat interval.
  let index = beats.length - 1;
  while (index > 0 && beats[index] > trackSeconds) {
    index -= 1;
  }
  const interval = index + 1 < beats.length ? beats[index + 1] - beats[index] : beats[index] - beats[index - 1];
  if (!(interval > 0)) {
    return null;
  }
  const beatPosition = index + (trackSeconds - beats[index]) / interval;
  const beatFloor = Math.floor(beatPosition);

  const lastDownbeat = downbeats[downbeats.length - 1];
  if (beatFloor < downbeats[0]) {
    return null;
  }
  if (beatFloor <= lastDownbeat) {
    let downbeat = downbeats.length - 1;
    while (downbeats[downbeat] > beatFloor) {
      downbeat -= 1;
    }
    return {
      beatPosition,
      beatPhase: beatPosition - beatFloor,
      beatInBar: beatFloor - downbeats[downbeat] + 1,
      bar: downbeat
    };
  }

  // Past the last downbeat the bar pattern continues at its final length.
  const barLength = downbeats.length > 1 ? lastDownbeat - downbeats[downbeats.length - 2] : 4;
  const barsPast = Math.floor((beatFloor - lastDownbeat) / barLength);
  return {
    beatPosition,
    beatPhase: beatPosition - beatFloor,
    beatInBar: ((beatFloor - lastDownbeat) % barLength) + 1,
    bar: downbeats.length - 1 + barsPast
  };
}

/**
 * Overrides a live analyser snapshot's beat and bar position with the grid's.
 *
 * Everything else - phrase state, energy, bands - stays as the live analyser
 * read it. With no grid phase the live snapshot passes through untouched.
 */
export function applyDeckGridPhase(
  state: LiveMusicalState,
  phase: DeckGridPhase | null
): LiveMusicalState {
  if (phase === null) {
    return state;
  }
  return {
    ...state,
    beatPosition: phase.beatPosition,
    beatPhase: phase.beatPhase,
    beatInBar: phase.beatInBar,
    bar: phase.bar,
    barPhase: (phase.beatInBar - 1 + phase.beatPhase) / 4
  };
}
