import { describe, expect, it } from "vitest";

import {
  applyNowPlayingStatus,
  createNowPlayingSession,
  preparedAudioForShow
} from "../nowPlaying/handoff.js";
import type { NowPlayingStatus } from "../nowPlaying/types.js";

function statusWithShow(id: string): NowPlayingStatus {
  return {
    modeState: "premade_armed",
    observation: null,
    activeShowId: null,
    armedShow: { id, showUrl: `/api/now-playing/show/${id}` },
    preparedAudio: {
      path: `/tmp/${id}.wav`,
      audioUrl: `/api/now-playing/audio/${id}`,
      durationSeconds: 212,
      provider: "disk"
    },
    preparing: null,
    providerAttempts: []
  };
}

describe("Now Playing handoff", () => {
  it("switches immediately from reactive fallback when a show is ready", () => {
    const session = createNowPlayingSession();
    const next = applyNowPlayingStatus(session, {
      nowMs: 10_000,
      status: {
        modeState: "reactive_fallback",
        observation: {
          title: "Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:40:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: null,
        armedShow: { id: "track-a", showUrl: "/api/now-playing/show/track-a" },
        preparedAudio: {
          path: "/tmp/track-a.wav",
          audioUrl: "/api/now-playing/audio/track-a",
          durationSeconds: 212,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: null,
      lastCueStartMs: null,
      cueBoundaryReached: false
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-a");
    expect(next.pendingShowId).toBeNull();
  });

  it("waits for the next cue boundary when another premade show is already active", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "current-show"
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 13_500,
      status: {
        modeState: "reactive_fallback",
        observation: {
          title: "Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:40:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: "current-show",
        armedShow: { id: "track-b", showUrl: "/api/now-playing/show/track-b" },
        preparedAudio: {
          path: "/tmp/track-b.wav",
          audioUrl: "/api/now-playing/audio/track-b",
          durationSeconds: 212,
          provider: "spotdl"
        },
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: { showId: "current-show", phraseId: "drop-2" },
      lastCueStartMs: 11_000,
      cueBoundaryReached: false
    });

    expect(next.outputMode).toBe("premade_armed");
    expect(next.activeShowId).toBe("current-show");
    expect(next.pendingShowId).toBe("track-b");
  });

  it("switches immediately inside the two-second post-cue grace window", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "current-show"
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 12_100,
      status: {
        modeState: "reactive_fallback",
        observation: {
          title: "Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:40:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: "current-show",
        armedShow: { id: "track-c", showUrl: "/api/now-playing/show/track-c" },
        preparedAudio: {
          path: "/tmp/track-c.wav",
          audioUrl: "/api/now-playing/audio/track-c",
          durationSeconds: 212,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: { showId: "current-show", phraseId: "groove-1" },
      lastCueStartMs: 11_000,
      cueBoundaryReached: false
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-c");
    expect(next.pendingShowId).toBeNull();
  });

  it("keeps premade playback active when repeated polls report the same ready show after the grace window", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "track-same",
      pendingShowId: "stale-pending"
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 25_000,
      status: {
        modeState: "premade_active",
        observation: {
          title: "Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:42:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: "track-same",
        armedShow: { id: "track-same", showUrl: "/api/now-playing/show/track-same" },
        preparedAudio: {
          path: "/tmp/track-same.wav",
          audioUrl: "/api/now-playing/audio/track-same",
          durationSeconds: 212,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: { showId: "track-same", phraseId: "verse-1" },
      lastCueStartMs: 20_000,
      cueBoundaryReached: false
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-same");
    expect(next.pendingShowId).toBeNull();
  });

  it("keeps premade playback active when the backend reports an active show without an armed replacement", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "track-live",
      pendingShowId: "stale-pending"
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 30_000,
      status: {
        modeState: "premade_active",
        observation: {
          title: "Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:43:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: "track-live",
        armedShow: null,
        preparedAudio: null,
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: { showId: "track-live", phraseId: "chorus-1" },
      lastCueStartMs: 28_000,
      cueBoundaryReached: false
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-live");
    expect(next.pendingShowId).toBeNull();
  });

  it("ignores stale ready payloads from older observations", () => {
    const session = createNowPlayingSession({
      latestObservedAt: "2026-05-15T22:41:00Z",
      outputMode: "reactive_fallback"
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 15_000,
      status: {
        modeState: "reactive_fallback",
        observation: {
          title: "Old Track",
          artist: "Artist",
          durationSeconds: 212,
          sourceApp: "Spotify",
          observedAt: "2026-05-15T22:40:00Z",
          playbackPositionSeconds: 12,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: null,
        armedShow: { id: "track-old", showUrl: "/api/now-playing/show/track-old" },
        preparedAudio: {
          path: "/tmp/track-old.wav",
          audioUrl: "/api/now-playing/audio/track-old",
          durationSeconds: 212,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      currentPlayback: null,
      lastCueStartMs: null,
      cueBoundaryReached: false
    });

    expect(next).toEqual(session);
  });

  it("pairs prepared audio only with the show it was armed for", () => {
    // A new track arms while the previous show is still loaded: its audio
    // must not be paired with the loaded show's tempo mid-handover.
    expect(preparedAudioForShow(statusWithShow("track-b"), "track-a")).toBeNull();
    expect(preparedAudioForShow(statusWithShow("track-a"), "track-a")?.audioUrl).toBe(
      "/api/now-playing/audio/track-a"
    );
    expect(preparedAudioForShow(null, "track-a")).toBeNull();
    expect(preparedAudioForShow(statusWithShow("track-a"), null)).toBeNull();
  });
});
