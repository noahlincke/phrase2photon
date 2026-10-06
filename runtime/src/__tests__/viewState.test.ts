import { describe, expect, it } from "vitest";

import {
  buildNowPlayingMetaRows,
  nowPlayingPrepareState,
  nowPlayingTransportLabel,
  preparationProgressValue,
  resolveVisualOwnership
} from "../app/viewState.js";

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
          isPlaying: true,
          deck: null
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

  it("shows the deck's track in the transport bar while the fallback drives the room", () => {
    expect(
      nowPlayingTransportLabel({
        driver: "live-mic",
        observationTitle: "Demo Track 1",
        loadedTitle: "Rags"
      })
    ).toBe("Demo Track 1");

    expect(
      nowPlayingTransportLabel({ driver: "premade", observationTitle: "Demo Track 1", loadedTitle: "Rags" })
    ).toBe("Rags");

    expect(nowPlayingTransportLabel({ driver: "live-mic", observationTitle: null, loadedTitle: null })).toBe(
      "No source"
    );
  });

  it("describes the running preparation step with its percent", () => {
    expect(
      nowPlayingPrepareState({
        preparing: { showId: "", stage: "compiling_show", message: "" },
        observationTitle: "Demo Track 1",
        outputMode: "reactive_fallback"
      })
    ).toBe("Preparing Demo Track 1: compiling, 90%");

    expect(preparationProgressValue("resolving_audio")).toBe(0.2);
    expect(preparationProgressValue("unknown_stage")).toBeNull();
  });

  it("reports Ready once the current track's show is active and nothing else", () => {
    expect(
      nowPlayingPrepareState({ preparing: null, observationTitle: "Demo Track 1", outputMode: "premade_active" })
    ).toBe("Ready");

    expect(
      nowPlayingPrepareState({
        preparing: null,
        observationTitle: "Demo Track 1",
        outputMode: "reactive_fallback"
      })
    ).toBeNull();
  });
});
