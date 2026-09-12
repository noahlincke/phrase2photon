import type { NowPlayingStatus } from "./types.js";

export type LoadedSourceKind = "library" | "now-playing";

export function isBrowserAudioTransportSource(sourceKind: LoadedSourceKind): boolean {
  return sourceKind === "library";
}

export function resolveNowPlayingPlaybackSeconds(
  status: NowPlayingStatus | null,
  nowEpochMs: number
): number | null {
  const observation = status?.observation;
  if (!observation || observation.playbackPositionSeconds === null) {
    return null;
  }
  if (observation.isPlaying === false) {
    return observation.playbackPositionSeconds;
  }
  const observedAtMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    return observation.playbackPositionSeconds;
  }
  const elapsedSeconds = Math.max(0, (nowEpochMs - observedAtMs) / 1000);
  const projected = observation.playbackPositionSeconds + elapsedSeconds;
  const duration = resolveNowPlayingPlaybackDurationSeconds(status) ?? observation.durationSeconds;
  return Math.min(projected, duration);
}

export function resolveNowPlayingPlaybackDurationSeconds(
  status: NowPlayingStatus | null
): number | null {
  return status?.preparedAudio?.durationSeconds ?? status?.observation?.durationSeconds ?? null;
}
