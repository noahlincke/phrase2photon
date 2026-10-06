import { describe, expect, it } from "vitest";

import {
  TRACKING_LOSS_GRACE_MS,
  createNowPlayingTracking,
  resolveNowPlayingDriver
} from "../nowPlaying/liveDriver.js";
import type { NowPlayingStatus } from "../nowPlaying/types.js";

function statusWith(observation: NowPlayingStatus["observation"]): NowPlayingStatus {
  return {
    modeState: "reactive_fallback",
    observation,
    activeShowId: null,
    armedShow: null,
    preparedAudio: null,
    preparing: null,
    providerAttempts: []
  };
}

const OBSERVED = statusWith({
  title: "Track",
  artist: null,
  durationSeconds: 212,
  sourceApp: "Rekordbox",
  observedAt: "2026-05-15T22:40:00Z",
  playbackPositionSeconds: 12,
  positionSource: "exact",
  isPlaying: true,
  deck: null
});

const LOST = statusWith(null);

describe("Now Playing live driver", () => {
  it("drives the premade show while the backend confirms it is playing", () => {
    const decision = resolveNowPlayingDriver({
      activeShowId: "track-a",
      status: OBSERVED,
      loadedShowId: "track-a",
      tracking: createNowPlayingTracking(),
      nowMs: 10_000
    });

    expect(decision.driver).toBe("premade");
    expect(decision.tracking).toEqual({ showId: "track-a", lostAtMs: null });
  });

  it("holds the show through a tracking loss inside the grace window", () => {
    const first = resolveNowPlayingDriver({
      activeShowId: null,
      status: LOST,
      loadedShowId: "track-a",
      tracking: { showId: "track-a", lostAtMs: null },
      nowMs: 10_000
    });
    expect(first.driver).toBe("premade");
    expect(first.tracking.lostAtMs).toBe(10_000);

    const later = resolveNowPlayingDriver({
      activeShowId: null,
      status: LOST,
      loadedShowId: "track-a",
      tracking: first.tracking,
      nowMs: 10_000 + TRACKING_LOSS_GRACE_MS - 100
    });
    expect(later.driver).toBe("premade");
    expect(later.tracking.lostAtMs).toBe(10_000);
  });

  it("continues without re-arming when the same track comes back inside the window", () => {
    const decision = resolveNowPlayingDriver({
      activeShowId: "track-a",
      status: OBSERVED,
      loadedShowId: "track-a",
      tracking: { showId: "track-a", lostAtMs: 10_000 },
      nowMs: 10_000 + TRACKING_LOSS_GRACE_MS - 500
    });

    expect(decision.driver).toBe("premade");
    expect(decision.tracking).toEqual({ showId: "track-a", lostAtMs: null });
  });

  it("hands over to the live mic once the grace window expires", () => {
    const decision = resolveNowPlayingDriver({
      activeShowId: null,
      status: LOST,
      loadedShowId: "track-a",
      tracking: { showId: "track-a", lostAtMs: 10_000 },
      nowMs: 10_000 + TRACKING_LOSS_GRACE_MS + 1
    });

    expect(decision.driver).toBe("live-mic");
    expect(decision.tracking).toEqual({ showId: null, lostAtMs: null });
  });

  it("uses the live mic when the current track has no show", () => {
    const decision = resolveNowPlayingDriver({
      activeShowId: null,
      status: OBSERVED,
      loadedShowId: "track-a",
      tracking: { showId: "track-a", lostAtMs: null },
      nowMs: 10_000
    });

    // The observation is alive, so this is not a tracking loss to ride out:
    // the deck moved to a track the runtime cannot arm.
    expect(decision.driver).toBe("live-mic");
    expect(decision.tracking).toEqual({ showId: null, lostAtMs: null });
  });

  it("uses the live mic with nothing loaded at all", () => {
    const decision = resolveNowPlayingDriver({
      activeShowId: null,
      status: OBSERVED,
      loadedShowId: null,
      tracking: createNowPlayingTracking(),
      nowMs: 10_000
    });

    expect(decision.driver).toBe("live-mic");
  });

  it("Recover drops straight to the live mic and clears any held show", () => {
    const held = resolveNowPlayingDriver({
      activeShowId: null,
      status: LOST,
      loadedShowId: "track-a",
      tracking: { showId: "track-a", lostAtMs: null },
      nowMs: 10_000
    });
    expect(held.driver).toBe("premade");

    // Recover resets tracking, so the next decision is mic-driven even before
    // a fresh status poll answers.
    const decision = resolveNowPlayingDriver({
      activeShowId: null,
      status: LOST,
      loadedShowId: "track-a",
      tracking: createNowPlayingTracking(),
      nowMs: 10_000
    });

    expect(decision.driver).toBe("live-mic");
    expect(decision.tracking).toEqual({ showId: null, lostAtMs: null });
  });
});
