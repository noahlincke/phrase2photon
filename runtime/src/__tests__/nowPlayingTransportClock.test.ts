import { describe, expect, it } from "vitest";

import {
  isBrowserAudioTransportSource,
  resolveNowPlayingPlaybackSeconds,
  resolveNowPlayingPlaybackDurationSeconds
} from "../nowPlaying/transportClock.js";

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
          isPlaying: true
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
          isPlaying: false
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
        isPlaying: true
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
