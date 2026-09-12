import { playbackStateAt, type PhrasePlaybackState, type ScheduledPhrase } from "../runtime/schedule.js";

/** Band levels for reactive visuals, each 0-1. */
export interface AudioBands {
  low: number;
  mid: number;
  high: number;
}

export interface FallbackPreviewStateInput {
  schedule: ScheduledPhrase[];
  bpm: number;
  anchorPhraseId: string | null;
  startedAtMs: number;
  nowMs: number;
}

export interface FallbackPreviewState {
  seconds: number;
  playback: PhrasePlaybackState;
  bands: AudioBands;
}

export function buildFallbackPreviewState(input: FallbackPreviewStateInput): FallbackPreviewState {
  if (!input.schedule.length) {
    throw new Error("Fallback preview requires a scheduled show.");
  }

  const anchor =
    input.schedule.find((entry) => entry.phrase.phrase_id === input.anchorPhraseId) ??
    input.schedule[0];
  const secondsPerBeat = 60 / Math.max(input.bpm, 1);
  const phraseDuration = Math.max(anchor.endSeconds - anchor.startSeconds, secondsPerBeat * 4);
  const elapsedSeconds = Math.max(0, (input.nowMs - input.startedAtMs) / 1000);
  const seconds = anchor.startSeconds + (elapsedSeconds % phraseDuration);
  const playbackSeconds = Math.min(seconds, Math.max(anchor.startSeconds, anchor.endSeconds - 0.001));
  const playback = playbackStateAt(input.schedule, playbackSeconds, input.bpm);
  const bands = syntheticPreviewBands(playback.phase, elapsedSeconds);

  return {
    seconds: playbackSeconds,
    playback,
    bands
  };
}

function syntheticPreviewBands(phase: number, elapsedSeconds: number): AudioBands {
  const beatPulse = Math.max(0, Math.cos(phase * Math.PI * 2));
  const midSweep = 0.5 + Math.sin(elapsedSeconds * 1.35 + phase * Math.PI * 2) * 0.5;
  const sparkle = 0.5 + Math.sin(elapsedSeconds * 3.9 + phase * Math.PI * 4) * 0.5;

  return {
    low: clampBand(0.24 + beatPulse * 0.58),
    mid: clampBand(0.16 + midSweep * 0.34 + beatPulse * 0.12),
    high: clampBand(0.12 + sparkle * 0.26 + beatPulse * 0.16)
  };
}

function clampBand(value: number): number {
  return Math.max(0, Math.min(1, value));
}
