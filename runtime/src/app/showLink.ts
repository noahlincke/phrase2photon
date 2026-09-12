import type { MusicalFrame } from "../graphics/visualSystem.js";

/**
 * Link between the control window and the pop-out show window.
 *
 * Musical state is broadcast, not pixels. The show window runs its own render
 * loop against the most recent state, so the two windows do not have to share
 * a frame rate - which matters when the show output is on a 60 Hz projector
 * and the control window is on a 120 Hz laptop display, or when the control
 * window is occluded and the browser throttles its timers.
 */

const CHANNEL_NAME = "phrase2photon-show";

export interface ShowFramePayload {
  type: "frame";
  frame: MusicalFrame;
  sceneId: string;
  /** Seconds since the control window started, for time-based scene motion. */
  elapsedSeconds: number;
}

export interface ShowHelloPayload {
  type: "hello";
}

export interface ShowClosedPayload {
  type: "closed";
}

export type ShowMessage = ShowFramePayload | ShowHelloPayload | ShowClosedPayload;

export function createShowChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}
