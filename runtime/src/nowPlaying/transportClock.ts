import type { NowPlayingStatus } from "./types.js";

export type LoadedSourceKind = "library" | "now-playing";

export function isBrowserAudioTransportSource(sourceKind: LoadedSourceKind): boolean {
  return sourceKind === "library";
}

/**
 * Whether the source app is reporting a real transport clock.
 *
 * Only an exact clock survives the things DJs actually do - pausing, looping,
 * jumping to a cue - so this decides whether the position can be trusted or
 * whether something else has to supply it.
 */
export function nowPlayingClockIsExact(status: NowPlayingStatus | null): boolean {
  const observation = status?.observation;
  return observation?.positionSource === "exact" && observation.playbackPositionSeconds !== null;
}

/** The last observation the premade clock may hold through a tracking loss. */
export interface NowPlayingHeldObservation {
  observation: NowPlayingStatus["observation"];
  /** The show the observation was captured under; the hold only applies to it. */
  showId: string | null;
}

/**
 * The hold for one status, tagged with the show the backend says the
 * observation belongs to.
 *
 * The status's activeShowId is the backend's resolved identity for the very
 * observation it travels with (the resolver only reports it once the deck
 * track matches), so it is the observation's own identity — not the loaded
 * show's, which can already have moved on when the observation lands.
 */
export function heldFromStatus(status: NowPlayingStatus | null): NowPlayingHeldObservation | null {
  return status?.observation ? { observation: status.observation, showId: status.activeShowId } : null;
}

/**
 * The status the playback clock reads, with the tracking-loss hold applied.
 *
 * While a premade show rides out the backend's tracking loss the last
 * observation seen is held in place so the show keeps running on its projected
 * clock instead of snapping to the start of the track. The hold belongs to the
 * show it was captured under: served across a show switch it would evaluate
 * the new show's schedule at the old show's playhead, so it stops applying
 * until the new show's own clock arrives.
 */
export function heldClockStatus(
  status: NowPlayingStatus | null,
  held: NowPlayingHeldObservation | null,
  loadedShowId: string | null
): NowPlayingStatus | null {
  if (status && !status.observation && held && held.showId === loadedShowId) {
    return { ...status, observation: held.observation };
  }
  return status;
}

export function resolveNowPlayingPlaybackSeconds(
  status: NowPlayingStatus | null,
  nowEpochMs: number,
  rate = 1
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
  const projected = observation.playbackPositionSeconds + elapsedSeconds * rate;
  const duration = resolveNowPlayingPlaybackDurationSeconds(status) ?? observation.durationSeconds;
  return Math.min(projected, duration);
}

/**
 * The deck's pitch as a ratio against the show's tempo.
 *
 * A deck bpm read can land in a different octave than the analysed show
 * (half/double grids), so the raw ratio is folded by powers of two into
 * [0.75, 1.5) first; anything still beyond rekordbox's ±16% tempo range —
 * or an unusable bpm read — falls back to un-pitched 1.0.
 */
export function deckPitchRatio(deckBpm: number | null, showBpm: number): number {
  if (
    deckBpm === null ||
    !Number.isFinite(deckBpm) ||
    !Number.isFinite(showBpm) ||
    deckBpm <= 0 ||
    showBpm <= 0
  ) {
    return 1;
  }
  let ratio = deckBpm / showBpm;
  while (ratio >= 1.5) {
    ratio /= 2;
  }
  while (ratio < 0.75) {
    ratio *= 2;
  }
  return ratio >= 0.84 && ratio < 1.16 ? ratio : 1;
}

/**
 * The bpm a premade laser frame paces its cue speed with.
 *
 * A deck pitched away from the show's original tempo burns source seconds
 * faster than the tempo map assumes, so the FB4 cue-speed channel should
 * carry the deck's effective bpm — but only in now-playing mode with a deck
 * sample to read, scaled back into the show's octave, since library
 * playback already owns its transport.
 */
export function deckCueBpm(
  sourceKind: LoadedSourceKind | null,
  deckBpm: number | null,
  showBpm: number
): number {
  if (sourceKind !== "now-playing") {
    return showBpm;
  }
  return Math.round(showBpm * deckPitchRatio(deckBpm, showBpm));
}

export function resolveNowPlayingPlaybackDurationSeconds(
  status: NowPlayingStatus | null
): number | null {
  return status?.preparedAudio?.durationSeconds ?? status?.observation?.durationSeconds ?? null;
}
