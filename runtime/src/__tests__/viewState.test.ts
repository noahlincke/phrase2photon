import { describe, expect, it } from "vitest";

import { buildNowPlayingMetaRows, resolveVisualOwnership } from "../app/viewState.js";

describe("view-state helpers", () => {
  it("keeps now-playing on loaded visuals instead of silently becoming mic-driven", () => {
    expect(
      resolveVisualOwnership({
        inputMode: "now-playing",
        hasLoadedTrack: true,
        hasSchedule: true
      })
    ).toBe("loaded");

    expect(
      resolveVisualOwnership({
        inputMode: "now-playing",
        hasLoadedTrack: false,
        hasSchedule: false
      })
    ).toBe("idle");
  });

  it("keeps now-playing meta focused on actionable rows without provider-attempt spam", () => {
    const rows = buildNowPlayingMetaRows({
      status: {
        modeState: "reactive_fallback",
        observation: {
          sourceApp: "Music",
          title: "Bubble & Squeak",
          artist: "Rupert Ellis",
          durationSeconds: 243,
          observedAt: "2026-06-13T18:12:00Z",
          playbackPositionSeconds: 37,
          positionSource: "estimated",
          isPlaying: true
        },
        activeShowId: null,
        armedShow: null,
        preparedAudio: null,
        preparing: {
          showId: "bubble-and-squeak-rupert-ellis",
          stage: "matching_audio",
          message: "Matching cached or downloadable audio."
        },
        providerAttempts: [
          { provider: "disk", status: "miss", message: "no candidates" },
          { provider: "scdl", status: "miss", message: "no candidates" }
        ],
        sourceDiagnostics: {
          sourceApp: "Rekordbox",
          databaseLoaded: true,
          selectedPath: "/Users/demo/Music/Bubble & Squeak.wav",
          selectedContentId: "123",
          selectedVia: "open_audio_candidates",
          openAudioCandidates: [],
          recentEventContentIds: ["123"]
        }
      },
      outputMode: "reactive_fallback",
      pendingShowId: null,
      preparedTrackId: null,
      runtimeNote: null,
      loadingShowId: null,
      preparingShowId: null
    });

    expect(rows).toEqual([]);
    expect(rows.join(" ")).not.toContain("disk");
    expect(rows.join(" ")).not.toContain("scdl");
    expect(rows.join(" ")).not.toContain("Selected file");
  });
});
