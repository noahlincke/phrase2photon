import type { RuntimeInputMode } from "./types.js";
import type { NowPlayingStatus } from "../nowPlaying/types.js";

export type VisualOwnership = "mic" | "loaded" | "idle";

export interface BuildNowPlayingMetaRowsInput {
  status: NowPlayingStatus | null;
  outputMode: string;
  pendingShowId: string | null;
  preparedTrackId: string | null;
  runtimeNote: string | null;
  loadingShowId: string | null;
  preparingShowId: string | null;
  /** What the deck follower is doing, when the microphone is on it. */
  followerNote?: string | null;
}

export function resolveVisualOwnership(input: {
  inputMode: RuntimeInputMode;
  hasLoadedTrack: boolean;
  hasSchedule: boolean;
}): VisualOwnership {
  if (input.inputMode === "mic") {
    return "mic";
  }
  if (input.hasLoadedTrack && input.hasSchedule) {
    return "loaded";
  }
  return "idle";
}

export function buildNowPlayingMetaRows(input: BuildNowPlayingMetaRowsInput): string[] {
  const rows: string[] = [];

  if (input.outputMode === "premade_armed" && input.pendingShowId) {
    rows.push(`Next handoff: ${input.pendingShowId}`);
  }

  if (input.preparedTrackId) {
    rows.push(`Ready show cached: ${input.preparedTrackId}`);
  } else if (input.loadingShowId) {
    rows.push(`Loading show: ${input.loadingShowId}`);
  } else if (input.preparingShowId && !input.status?.preparing) {
    rows.push(`Preloading show: ${input.preparingShowId}`);
  }

  // Worth saying out loud: without the analyser bundle, shows are compiled at
  // an assumed tempo, which looks like a detection failure rather than a
  // missing build step.
  const analyzer = input.status?.analyzer;
  if (analyzer && analyzer !== "analyser ready.") {
    rows.push(analyzer);
  }

  // Deck following changes where the position comes from, so it belongs above
  // the audio-provider line rather than buried under it.
  if (input.followerNote) {
    rows.push(input.followerNote);
  }

  if (input.status?.preparedAudio && input.outputMode !== "premade_active") {
    rows.push(
      `Audio ready via ${input.status.preparedAudio.provider} · ${Math.round(input.status.preparedAudio.durationSeconds)}s`
    );
  } else if (input.runtimeNote && !rows.length) {
    rows.push(input.runtimeNote);
  }

  return rows;
}
