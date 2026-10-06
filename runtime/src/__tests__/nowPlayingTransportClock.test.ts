import { describe, expect, it } from "vitest";

import {
  deckCueBpm,
  deckDisplayBpm,
  deckPitchRatio,
  heldClockStatus,
  heldFromStatus,
  isBrowserAudioTransportSource,
  nowPlayingClockIsExact,
  resolveNowPlayingPlaybackSeconds,
  resolveNowPlayingPlaybackDurationSeconds
} from "../nowPlaying/transportClock.js";
import type { NowPlayingObservation, NowPlayingStatus } from "../nowPlaying/types.js";

describe("now-playing transport clock", () => {
  it("treats library as the only browser-audio-driven source", () => {
    expect(isBrowserAudioTransportSource("library")).toBe(true);
    expect(isBrowserAudioTransportSource("now-playing")).toBe(false);
  });

  it("projects a live source clock forward from the observed playback position", () => {
    const seconds = resolveNowPlayingPlaybackSeconds(
      {
        modeState: "premade_active",
        observation: {
          sourceApp: "Music",
          title: "Extract",
          artist: "Chris Stussy",
          durationSeconds: 453.7,
          observedAt: "2026-05-16T21:50:25.000Z",
          playbackPositionSeconds: 127.25,
          positionSource: "estimated",
          isPlaying: true,
          deck: null
        },
        activeShowId: "show-a",
        armedShow: null,
        preparedAudio: {
          path: "/tmp/extract.wav",
          audioUrl: "/api/now-playing/audio/show-a",
          durationSeconds: 453.7,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      Date.parse("2026-05-16T21:50:27.500Z")
    );

    expect(seconds).toBeCloseTo(129.75, 5);
  });

  it("holds a paused source at its last reported playback position", () => {
    const seconds = resolveNowPlayingPlaybackSeconds(
      {
        modeState: "premade_active",
        observation: {
          sourceApp: "Music",
          title: "Extract",
          artist: "Chris Stussy",
          durationSeconds: 453.7,
          observedAt: "2026-05-16T21:50:25.000Z",
          playbackPositionSeconds: 127.25,
          positionSource: "estimated",
          isPlaying: false,
          deck: null
        },
        activeShowId: "show-a",
        armedShow: null,
        preparedAudio: {
          path: "/tmp/extract.wav",
          audioUrl: "/api/now-playing/audio/show-a",
          durationSeconds: 453.7,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: []
      },
      Date.parse("2026-05-16T21:55:27.500Z")
    );

    expect(seconds).toBeCloseTo(127.25, 5);
  });

  it("prefers prepared audio duration for now-playing tracks", () => {
    const duration = resolveNowPlayingPlaybackDurationSeconds({
      modeState: "premade_active",
      observation: {
        sourceApp: "Rekordbox",
        title: "Oh K",
        artist: "Alves",
        durationSeconds: 159,
        observedAt: "2026-05-16T20:59:53.878731Z",
        playbackPositionSeconds: 48.25,
        positionSource: "estimated",
        isPlaying: true,
        deck: null
      },
      activeShowId: "track-a",
      armedShow: null,
      preparedAudio: {
        path: "/tmp/oh-k.flac",
        audioUrl: "/api/now-playing/audio/track-a",
        durationSeconds: 159.375,
        provider: "disk"
      },
      preparing: null,
      providerAttempts: []
    });

    expect(duration).toBeCloseTo(159.375, 5);
  });
});

describe("nowPlayingClockIsExact", () => {
  const observation: NowPlayingObservation = {
    sourceApp: "Rekordbox",
    title: "Track",
    artist: "Artist",
    durationSeconds: 300,
    observedAt: "2026-05-16T20:59:53.878731Z",
    playbackPositionSeconds: 48.25,
    positionSource: "exact",
    isPlaying: true,
    deck: null
  };

  const statusWith = (overrides: Partial<NowPlayingObservation>): NowPlayingStatus =>
    ({
      modeState: "premade_active",
      observation: { ...observation, ...overrides },
      activeShowId: null,
      armedShow: null,
      preparedAudio: null,
      preparing: null,
      providerAttempts: []
    }) as unknown as NowPlayingStatus;

  it("trusts a source app that reports its own transport", () => {
    expect(nowPlayingClockIsExact(statusWith({}))).toBe(true);
  });

  it("does not trust a position inferred from file read offsets", () => {
    expect(nowPlayingClockIsExact(statusWith({ positionSource: "estimated" }))).toBe(false);
  });

  it("does not trust a source that says nothing about where the position came from", () => {
    expect(nowPlayingClockIsExact(statusWith({ positionSource: null }))).toBe(false);
  });

  it("is not fooled by an exact label with no position behind it", () => {
    expect(nowPlayingClockIsExact(statusWith({ playbackPositionSeconds: null }))).toBe(false);
  });

  it("handles no status at all", () => {
    expect(nowPlayingClockIsExact(null)).toBe(false);
  });
});

describe("heldClockStatus", () => {
  const observationA: NowPlayingObservation = {
    sourceApp: "Rekordbox",
    title: "Track A",
    artist: "Artist A",
    durationSeconds: 300,
    observedAt: "2026-05-16T20:59:53.878731Z",
    playbackPositionSeconds: 120.5,
    positionSource: "exact",
    isPlaying: true,
    deck: null
  };
  const heldA = { observation: observationA, showId: "show-a" };
  const statusWithoutObservation: NowPlayingStatus = {
    modeState: "premade_active",
    observation: null,
    activeShowId: "show-b",
    armedShow: null,
    preparedAudio: {
      path: "/tmp/track-b.wav",
      audioUrl: "/api/now-playing/audio/show-b",
      durationSeconds: 240,
      provider: "disk"
    },
    preparing: null,
    providerAttempts: []
  };

  it("keeps holding the observation through a tracking loss on the same show", () => {
    const served = heldClockStatus(statusWithoutObservation, heldA, "show-a");
    expect(served?.observation).toEqual(observationA);
  });

  it("drops a held observation that belongs to another loaded show", () => {
    // Show A -> show B switch: the held observation describes A's deck
    // position, so B's schedule must not be evaluated at it.
    const served = heldClockStatus(statusWithoutObservation, heldA, "show-b");
    expect(served?.observation).toBeNull();
    expect(resolveNowPlayingPlaybackSeconds(served, Date.parse("2026-05-16T21:00:00Z"))).toBeNull();
  });
});

describe("heldFromStatus", () => {
  it("tags the hold with the show the backend resolved the observation to", () => {
    const status = {
      modeState: "premade_active",
      observation: { sourceApp: "Rekordbox", title: "Track B", artist: null },
      activeShowId: "show-b"
    } as unknown as NowPlayingStatus;
    expect(heldFromStatus(status)).toEqual({
      observation: status.observation,
      showId: "show-b"
    });
  });

  it("tags an unresolved observation as belonging to no show", () => {
    const status = {
      modeState: "reactive_fallback",
      observation: { sourceApp: "Rekordbox", title: "Track B", artist: null },
      activeShowId: null
    } as unknown as NowPlayingStatus;
    expect(heldFromStatus(status)?.showId).toBeNull();
  });

  it("holds nothing without an observation", () => {
    const status = {
      modeState: "premade_active",
      observation: null,
      activeShowId: "show-b"
    } as unknown as NowPlayingStatus;
    expect(heldFromStatus(status)).toBeNull();
  });
});

describe("deck bpm consumers", () => {
  const pitchedStatus: NowPlayingStatus = {
    modeState: "premade_active",
    observation: {
      sourceApp: "Rekordbox",
      title: "Track B",
      artist: null,
      durationSeconds: 240,
      observedAt: "2026-05-16T21:50:25.000Z",
      playbackPositionSeconds: 127.25,
      positionSource: "exact",
      isPlaying: true,
      deck: null
    },
    activeShowId: "show-b",
    armedShow: null,
    preparedAudio: null,
    preparing: null,
    providerAttempts: []
  };

  it("extrapolates the status observation at the deck's pitch rate", () => {
    const seconds = resolveNowPlayingPlaybackSeconds(
      pitchedStatus,
      Date.parse("2026-05-16T21:50:27.500Z"),
      1.025
    );
    expect(seconds).toBeCloseTo(127.25 + 2.5 * 1.025, 5);
  });

  it("paces premade cue speed with the deck's effective bpm", () => {
    expect(deckCueBpm("now-playing", 123, 120)).toBe(123);
    // A deck grid an octave off stays on the show's octave after folding.
    expect(deckCueBpm("now-playing", 246, 120)).toBe(123);
    expect(deckCueBpm("now-playing", 61.5, 120)).toBe(123);
    expect(deckCueBpm("now-playing", 200, 120)).toBe(120);
  });

  it("falls back to the show tempo without a usable deck bpm", () => {
    expect(deckCueBpm("now-playing", null, 120)).toBe(120);
    expect(deckCueBpm("now-playing", 0, 120)).toBe(120);
    expect(deckCueBpm("library", 123, 120)).toBe(120);
    expect(deckCueBpm(null, 123, 120)).toBe(120);
  });

  it("reads a synced deck's effective tempo in the now-playing HUD", () => {
    // Rags: native 125, deck synced down to 124.
    expect(deckDisplayBpm("now-playing", 124, 125).toFixed(1)).toBe("124.0");
    // A deck grid an octave off still reads on the show's octave.
    expect(deckDisplayBpm("now-playing", 248, 124).toFixed(1)).toBe("124.0");
  });

  it("keeps the show tempo in the HUD without a deck bpm", () => {
    expect(deckDisplayBpm("now-playing", null, 125).toFixed(1)).toBe("125.0");
    expect(deckDisplayBpm("library", 124, 125).toFixed(1)).toBe("125.0");
    expect(deckDisplayBpm(null, 124, 125).toFixed(1)).toBe("125.0");
  });
});

describe("deckPitchRatio", () => {
  it("keeps a small pitch offset", () => {
    expect(deckPitchRatio(123, 120)).toBeCloseTo(1.025, 5);
  });

  it("folds half/double grid mismatches into the show's octave", () => {
    expect(deckPitchRatio(246, 120)).toBeCloseTo(1.025, 5);
    expect(deckPitchRatio(61.5, 120)).toBeCloseTo(1.025, 5);
  });

  it("rejects a ratio beyond rekordbox's tempo range after folding", () => {
    expect(deckPitchRatio(200, 120)).toBe(1);
  });

  it("rejects unusable deck bpm reads", () => {
    expect(deckPitchRatio(null, 120)).toBe(1);
    expect(deckPitchRatio(0, 120)).toBe(1);
    expect(deckPitchRatio(NaN, 120)).toBe(1);
    expect(deckPitchRatio(Infinity, 120)).toBe(1);
  });
});
