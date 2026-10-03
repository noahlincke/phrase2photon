import type { ShowPackage } from "./types.js";

export interface BeatGridSegment {
  start_seconds: number;
  bpm: number;
  downbeat_seconds: number;
}

export interface BeatGrid {
  segments: BeatGridSegment[];
  beatsPerBar: number;
}

/** The show's beat grid: its tempo map, or today's single-tempo behaviour. */
export function gridFor(show: ShowPackage): BeatGrid {
  return {
    segments: show.song.tempo_map ?? [
      { start_seconds: 0, bpm: show.song.tempo, downbeat_seconds: 0 }
    ],
    beatsPerBar: beatsPerBarFromSignature(show.song.time_signature)
  };
}

interface GridSpan {
  startSeconds: number;
  /** Continuous musical beats at startSeconds, counted from the first downbeat. */
  startBeats: number;
  bpm: number;
}

/** Tolerance for treating a downbeat as exactly bar-aligned despite float noise. */
const BAR_SNAP_BEATS = 1e-6;

function gridSpans(grid: BeatGrid): GridSpan[] {
  const spans: GridSpan[] = [];
  grid.segments.forEach((segment, index) => {
    const previous = spans[index - 1];
    let startBeats: number;
    if (previous) {
      // The incoming grid continues the count from where the previous one
      // left off, but its own downbeat must land on a whole bar - so the
      // count jumps forward to the next bar line, never backwards.
      const accumulated = previous.startBeats + (segment.start_seconds - previous.startSeconds) * (previous.bpm / 60);
      const downbeatOffset = (segment.downbeat_seconds - segment.start_seconds) * (segment.bpm / 60);
      const bars = Math.ceil((accumulated + downbeatOffset - BAR_SNAP_BEATS) / grid.beatsPerBar);
      startBeats = bars * grid.beatsPerBar - downbeatOffset;
    } else {
      startBeats = -segment.downbeat_seconds * (segment.bpm / 60);
    }
    spans.push({ startSeconds: segment.start_seconds, startBeats, bpm: segment.bpm });
  });
  return spans;
}

function spanForSeconds(spans: GridSpan[], seconds: number): GridSpan {
  let span = spans[0];
  for (const candidate of spans) {
    if (candidate.startSeconds <= seconds) {
      span = candidate;
    }
  }
  return span;
}

/** Musical beats at a time, counted from the grid's first downbeat ("1|1" is 0). */
export function secondsToBeats(grid: BeatGrid, seconds: number): number {
  const span = spanForSeconds(gridSpans(grid), seconds);
  return span.startBeats + (seconds - span.startSeconds) * (span.bpm / 60);
}

/** Inverse of secondsToBeats. */
export function beatsToSeconds(grid: BeatGrid, beats: number): number {
  const spans = gridSpans(grid);
  let span = spans[spans.length - 1];
  let next: GridSpan | undefined;
  for (let index = 0; index < spans.length - 1; index += 1) {
    if (beats < spans[index + 1].startBeats) {
      span = spans[index];
      next = spans[index + 1];
      break;
    }
  }
  if (beats < span.startBeats) {
    span = spans[0];
    next = spans[1];
  }
  const seconds = span.startSeconds + (beats - span.startBeats) * (60 / span.bpm);
  // A forward jump at a boundary leaves a band of beats that no time maps to;
  // they clamp to the boundary instead of spilling into the next segment.
  return next ? Math.min(seconds, next.startSeconds) : seconds;
}

/** The tempo governing a moment of the show. */
export function tempoAt(grid: BeatGrid, seconds: number): number {
  return spanForSeconds(gridSpans(grid), seconds).bpm;
}

export function barBeatToBeat(barBeat: string, beatsPerBar: number): number {
  const [barRaw, beatRaw] = barBeat.split("|");
  const bar = Number.parseInt(barRaw, 10);
  const beat = Number.parseFloat(beatRaw);
  if (!Number.isFinite(bar) || !Number.isFinite(beat)) {
    throw new Error(`Invalid bar beat value: ${barBeat}`);
  }
  return Math.max(0, (bar - 1) * beatsPerBar + (beat - 1));
}

export function beatsPerBarFromSignature(signature: string): number {
  const [beatsRaw] = signature.split("/");
  const beats = Number.parseInt(beatsRaw, 10);
  return Number.isFinite(beats) && beats > 0 ? beats : 4;
}



