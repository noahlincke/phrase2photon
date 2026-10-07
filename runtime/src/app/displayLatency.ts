/**
 * Display latency compensation for the graphics lane.
 *
 * The laser lane compensates its own output path with the operator's laser
 * offset. The three.js visuals ride a different output path - a TV over HDMI
 * or a Chromecast tab cast - whose latency is much larger and tuned
 * separately, so they get their own setting. A show clock (Library transport
 * or a Now Playing deck clock) can see the future, so the frame for playback +
 * offset is evaluated now and lands on the beat after the display's delay.
 * Live mic has no clock to predict from, so there the offset is inactive.
 */

export const DISPLAY_LATENCY_KEY = "p2p.output.displayLatencyMs";
export const DISPLAY_LATENCY_MAX_MS = 2500;

/** Parses the persisted setting, clamped to 0..2500 ms. */
export function parseDisplayLatencyMs(raw: string | null): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(DISPLAY_LATENCY_MAX_MS, Math.max(0, value));
}

/**
 * Playback seconds the visuals evaluate: ahead by the display offset when a
 * show clock exists, exactly at playback otherwise.
 */
export function displayPlaybackSeconds(seconds: number, offsetMs: number | null): number {
  return offsetMs === null ? seconds : seconds + offsetMs / 1000;
}
