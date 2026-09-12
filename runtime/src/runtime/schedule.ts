import type { Phrase, ShowPackage } from "../show/types.js";

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
  const beatsPerBar = beatsPerBarFromSignature(show.song.time_signature);
  const secondsPerBeat = 60 / show.song.tempo;

  return show.phrases.map((phrase, index) => {
    const startBeat = barBeatToBeat(phrase.range.start_bar_beat, beatsPerBar);
    let endBeat = barBeatToBeat(phrase.range.end_bar_beat, beatsPerBar);
    if (endBeat <= startBeat) {
      const next = show.phrases[index + 1];
      endBeat = next ? barBeatToBeat(next.range.start_bar_beat, beatsPerBar) : startBeat + beatsPerBar * 8;
    }

    const startSeconds = startBeat * secondsPerBeat;
    let endSeconds = endBeat * secondsPerBeat;
    if (index === show.phrases.length - 1 && audioDurationSeconds && audioDurationSeconds > startSeconds) {
      endSeconds = audioDurationSeconds;
      endBeat = endSeconds / secondsPerBeat;
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

export function playbackStateAt(schedule: ScheduledPhrase[], seconds: number, bpm: number): PhrasePlaybackState {
  if (!schedule.length) {
    throw new Error("Cannot evaluate playback state without phrases.");
  }

  const active =
    schedule.find((entry) => seconds >= entry.startSeconds && seconds < entry.endSeconds) ??
    schedule[schedule.length - 1];
  const duration = Math.max(active.endSeconds - active.startSeconds, 0.001);
  const phraseProgress = clamp01((seconds - active.startSeconds) / duration);
  const beatFloat = seconds / (60 / bpm);
  const beat = Math.floor(beatFloat) + 1;
  const bar = Math.floor(beatFloat / 4) + 1;
  const phase = beatFloat - Math.floor(beatFloat);

  return {
    active,
    phraseProgress,
    beat,
    bar,
    phase
  };
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
