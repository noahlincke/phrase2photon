import type { Phrase, ShowPackage } from "../show/types.js";
import { barBeatToBeat, beatsToSeconds, gridFor, secondsToBeats, type BeatGrid } from "../show/beatGrid.js";

export { barBeatToBeat, beatsPerBarFromSignature } from "../show/beatGrid.js";

export interface ScheduledPhrase {
  phrase: Phrase;
  startBeat: number;
  endBeat: number;
  startSeconds: number;
  endSeconds: number;
}

export interface PhrasePlaybackState {
  active: ScheduledPhrase;
  phraseProgress: number;
  beat: number;
  bar: number;
  phase: number;
}

export function buildPhraseSchedule(show: ShowPackage, audioDurationSeconds?: number): ScheduledPhrase[] {
  const grid = gridFor(show);

  return show.phrases.map((phrase, index) => {
    const startBeat = barBeatToBeat(phrase.range.start_bar_beat, grid.beatsPerBar);
    let endBeat = barBeatToBeat(phrase.range.end_bar_beat, grid.beatsPerBar);
    if (endBeat <= startBeat) {
      const next = show.phrases[index + 1];
      endBeat = next ? barBeatToBeat(next.range.start_bar_beat, grid.beatsPerBar) : startBeat + grid.beatsPerBar * 8;
    }

    const startSeconds = beatsToSeconds(grid, startBeat);
    let endSeconds = beatsToSeconds(grid, endBeat);
    if (index === show.phrases.length - 1 && audioDurationSeconds && audioDurationSeconds > startSeconds) {
      endSeconds = audioDurationSeconds;
      endBeat = secondsToBeats(grid, audioDurationSeconds);
    }

    return {
      phrase,
      startBeat,
      endBeat,
      startSeconds,
      endSeconds
    };
  });
}

export function playbackStateAt(schedule: ScheduledPhrase[], seconds: number, grid: BeatGrid): PhrasePlaybackState {
  if (!schedule.length) {
    throw new Error("Cannot evaluate playback state without phrases.");
  }

  const active =
    schedule.find((entry) => seconds >= entry.startSeconds && seconds < entry.endSeconds) ??
    (seconds < schedule[0].startSeconds ? schedule[0] : schedule[schedule.length - 1]);
  const duration = Math.max(active.endSeconds - active.startSeconds, 0.001);
  const phraseProgress = clamp01((seconds - active.startSeconds) / duration);
  const beatFloat = secondsToBeats(grid, seconds);
  const beat = Math.floor(beatFloat) + 1;
  const bar = Math.floor(beatFloat / grid.beatsPerBar) + 1;
  const phase = beatFloat - Math.floor(beatFloat);

  return {
    active,
    phraseProgress,
    beat,
    bar,
    phase
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
