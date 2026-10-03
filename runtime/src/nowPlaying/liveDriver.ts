import type { NowPlayingStatus } from "./types.js";

/**
 * Which signal drives visuals and laser in Now Playing mode.
 *
 * Now Playing has no local transport: the deck audio lives in the source app.
 * When the status feed stops describing that deck - the observation drops, the
 * request track has no show yet - there is nothing to follow. Rather than
 * freezing or looping a synthetic preview, the runtime hands the room to the
 * same LiveAnalyzer path Mic mode uses. A short grace window keeps a playing
 * show alive across a momentary tracking loss, running on its projected clock,
 * so a one-poll hiccup in the feed does not visibly restart the show.
 */

/** How long a premade show keeps running on its projected clock after tracking is lost. */
export const TRACKING_LOSS_GRACE_MS = 4_000;

export type NowPlayingDriver = "premade" | "live-mic";

export interface NowPlayingTrackingState {
  /** The show the premade driver is holding across an observation gap. */
  showId: string | null;
  /** When tracking was last seen healthy for that show; null while it still is. */
  lostAtMs: number | null;
}

export function createNowPlayingTracking(): NowPlayingTrackingState {
  return { showId: null, lostAtMs: null };
}

export interface ResolveNowPlayingDriverInput {
  /** Show id the backend currently reports as actively playing, if any. */
  activeShowId: string | null;
  status: NowPlayingStatus | null;
  /** Show id loaded in the browser for the Now Playing deck, if any. */
  loadedShowId: string | null;
  tracking: NowPlayingTrackingState;
  nowMs: number;
}

export interface NowPlayingDriverDecision {
  driver: NowPlayingDriver;
  tracking: NowPlayingTrackingState;
}

export function resolveNowPlayingDriver(
  input: ResolveNowPlayingDriverInput
): NowPlayingDriverDecision {
  const loadedShowId = input.loadedShowId;
  const observationPresent = input.status?.observation != null;
  const trackingHealthy =
    observationPresent &&
    input.activeShowId !== null &&
    input.activeShowId === loadedShowId;

  if (trackingHealthy) {
    return { driver: "premade", tracking: { showId: loadedShowId, lostAtMs: null } };
  }

  // The observation dropped mid-show. Hold the loaded show through the grace
  // window; the first lost poll starts it, and expiry hands over to the mic.
  if (
    !observationPresent &&
    loadedShowId !== null &&
    input.tracking.showId === loadedShowId &&
    (input.tracking.lostAtMs === null ||
      input.nowMs - input.tracking.lostAtMs <= TRACKING_LOSS_GRACE_MS)
  ) {
    return {
      driver: "premade",
      tracking: { showId: loadedShowId, lostAtMs: input.tracking.lostAtMs ?? input.nowMs }
    };
  }

  return { driver: "live-mic", tracking: createNowPlayingTracking() };
}
