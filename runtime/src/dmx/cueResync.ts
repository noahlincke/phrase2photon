import type { Fb4Dmx16Frame } from "./fb4Dmx16.js";

/**
 * Cue re-sync: on a chosen bar period the current cue is restarted so its
 * animation phase lines up with the bar.
 *
 * The FB4 re-latches a cue when its cue-index channel leaves the "none active"
 * band, so one frame of "none" followed by the cue again restarts the cue's
 * animation. The restart frame must land on the downbeat, so the beat position
 * the caller supplies is already latency-shifted (the same shift the beat looks
 * use), and the tracker fires on the first show frame of each new period.
 */

export interface CueResyncTick {
  /** Latency-shifted absolute beat position, the same value the looks use. */
  positionBeats: number;
  beatsPerBar: number;
  bpm: number;
}

/**
 * A restart that lands further into the bar than this is a missed boundary
 * (a hold or a stalled frame loop), not a downbeat: skip it and wait for the
 * next one rather than re-syncing off the beat.
 */
const RESTART_WINDOW_MS = 60;

export class CueResyncTracker {
  private lastPeriod: number | null = null;

  /**
   * Returns the restart frame when this is the first show frame at a new
   * period downbeat, or null when the frame should go out unchanged.
   */
  restart(
    frame: Fb4Dmx16Frame,
    tick: CueResyncTick,
    periodBars: number,
    enabled: boolean
  ): Fb4Dmx16Frame | null {
    if (!enabled) {
      return null;
    }
    const periodBeats = Math.max(1, tick.beatsPerBar * periodBars);
    const period = Math.floor(Math.max(0, tick.positionBeats) / periodBeats);
    if (period === this.lastPeriod) {
      return null;
    }
    this.lastPeriod = period;
    const windowBeats = (RESTART_WINDOW_MS / 1000) * (tick.bpm / 60);
    if (tick.positionBeats - period * periodBeats > windowBeats) {
      return null;
    }
    return restartCueFrame(frame);
  }
}

/** The same frame with the cue-index channel held at "none active" for one frame. */
export function restartCueFrame(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
  const channels = [...frame.channels];
  channels[frame.profile === "pangolin-fb4-dmx39" ? 14 : 2] = 0;
  return { ...frame, channels };
}
