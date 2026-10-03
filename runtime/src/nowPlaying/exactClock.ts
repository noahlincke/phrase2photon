import type { NowPlayingClockSample } from "./types.js";

/**
 * Exact-playhead anchoring for the Now Playing transport clock.
 *
 * The server streams raw deck samples; each exact sample becomes an anchor the
 * clock projects from until the next one lands. Folding the sample's age in at
 * anchor time is what keeps cue jumps and loops from ever lasting more than
 * one poll tick, where the old status-only path waited up to 1.2 s.
 */

/** A sample this far from the current projection is a cue jump, not drift. */
export const NOW_PLAYING_JUMP_SECONDS = 0.25;

export interface ClockSampleAnchor {
  positionSeconds: number;
  anchoredAtMs: number;
  playing: boolean;
}

/** A clock sample carrying a usable playhead position. */
export type ExactClockSample = NowPlayingClockSample & {
  deck: number;
  positionSeconds: number;
};

export function clockSampleIsExact(
  sample: NowPlayingClockSample | null
): sample is ExactClockSample {
  return (
    sample !== null &&
    sample.status === "exact" &&
    sample.deck !== null &&
    sample.positionSeconds !== null
  );
}

/** The playhead position implied by a sample at the moment it is applied. */
export function clockSamplePositionSeconds(sample: ExactClockSample): number {
  const ageSeconds =
    sample.playing === true && sample.ageMs !== null ? Math.max(0, sample.ageMs) / 1000 : 0;
  return sample.positionSeconds + ageSeconds;
}

/**
 * Re-anchors the transport clock on one exact sample.
 *
 * A deck jump larger than NOW_PLAYING_JUMP_SECONDS lands the same way as
 * steady playback: the new sample replaces the anchor outright, so the clock
 * snaps immediately instead of easing or waiting for the status poll.
 */
export function anchorFromClockSample(
  sample: ExactClockSample,
  nowMs: number
): ClockSampleAnchor {
  return {
    positionSeconds: clockSamplePositionSeconds(sample),
    anchoredAtMs: nowMs,
    playing: sample.playing !== false
  };
}

export function projectClockAnchor(anchor: ClockSampleAnchor, nowMs: number): number {
  if (!anchor.playing) {
    return anchor.positionSeconds;
  }
  return anchor.positionSeconds + Math.max(0, nowMs - anchor.anchoredAtMs) / 1000;
}

/** True when a sample lands far enough from the current projection to be a jump. */
export function clockSampleIsJump(
  anchor: ClockSampleAnchor,
  sample: NowPlayingClockSample,
  nowMs: number
): boolean {
  if (!clockSampleIsExact(sample)) {
    return false;
  }
  const drift = projectClockAnchor(anchor, nowMs) - clockSamplePositionSeconds(sample);
  return Math.abs(drift) > NOW_PLAYING_JUMP_SECONDS;
}
