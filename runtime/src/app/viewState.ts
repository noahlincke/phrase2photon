import type { RuntimeInputMode } from "./types.js";
import type { NowPlayingStatus } from "../nowPlaying/types.js";

export type VisualOwnership = "mic" | "loaded" | "idle";

/** Which signal owns the room in Now Playing mode; mirrors liveDriver.ts. */
export type NowPlayingDriverKind = "premade" | "live-mic";

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

/**
 * The track name the transport bar shows.
 *
 * While the premade driver runs the loaded show, the bar names that show.
 * Once the live fallback owns the room — the deck moved to a track whose show
 * is not ready yet — naming the unloaded show would lie about what is
 * playing, so the bar names the deck's own track instead.
 */
export function nowPlayingTransportLabel(input: {
  driver: NowPlayingDriverKind;
  observationTitle: string | null;
  loadedTitle: string | null;
}): string {
  if (input.driver === "live-mic") {
    return input.observationTitle ?? "No source";
  }
  return input.loadedTitle ?? "No source";
}

/** How far through preparation a stage sits, or null for an unknown stage. */
export function preparationProgressValue(stage: string | null): number | null {
  switch (stage) {
    case "resolving_audio":
      return 0.2;
    case "caching_audio":
      return 0.45;
    case "analyzing_audio":
      return 0.7;
    case "compiling_show":
      return 0.9;
    default:
      return null;
  }
}

const PREPARE_STAGE_LABELS: Record<string, string> = {
  resolving_audio: "resolving",
  caching_audio: "caching",
  analyzing_audio: "analysing",
  compiling_show: "compiling"
};

/**
 * The one-line preparation state for the Now Playing panel, or null when
 * there is nothing to say: a running preparation names its track and step,
 * an active show reads Ready, anything else stays quiet.
 */
export function nowPlayingPrepareState(input: {
  preparing: NowPlayingStatus["preparing"];
  observationTitle: string | null;
  outputMode: string;
}): string | null {
  if (input.preparing !== null) {
    const title = input.observationTitle ?? "the current track";
    const stage = PREPARE_STAGE_LABELS[input.preparing.stage] ?? input.preparing.stage;
    const progress = preparationProgressValue(input.preparing.stage);
    const percent = progress === null ? "" : `, ${Math.round(progress * 100)}%`;
    return `Preparing ${title}: ${stage}${percent}`;
  }
  if (input.outputMode === "premade_active") {
    return "Ready";
  }
  return null;
}
