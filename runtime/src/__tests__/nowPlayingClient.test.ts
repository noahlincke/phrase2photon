import { describe, expect, it, vi } from "vitest";

import { fetchNowPlayingStatus } from "../nowPlaying/client.js";

describe("fetchNowPlayingStatus", () => {
  it("loads the same-origin status payload", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        modeState: "reactive_fallback",
        observation: null,
        activeShowId: null,
        armedShow: null,
        preparedAudio: null,
        preparing: null,
        providerAttempts: [],
        sourceDiagnostics: null
      })
    }));

    const payload = await fetchNowPlayingStatus(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/now-playing/status");
    expect(payload.modeState).toBe("reactive_fallback");
  });

  it("throws when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503
    }));

    await expect(
      fetchNowPlayingStatus(fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow("Now Playing status failed: 503");
  });

  it("throws when the payload shape is invalid", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        modeState: "bad-state",
        observation: "nope",
        activeShowId: null,
        armedShow: null,
        preparedAudio: null,
        preparing: null,
        providerAttempts: {},
        sourceDiagnostics: null
      })
    }));

    await expect(
      fetchNowPlayingStatus(fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/modeState|observation|providerAttempts/);
  });

  it("accepts the Python service observation shape and normalizes it", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        modeState: "premade_active",
        observation: {
          source_app: "Rekordbox",
          title: "Oh K",
          artist: "Alves",
          duration_seconds: 159,
          observed_at: "2026-05-16T20:59:53.878731Z",
          playback_position_seconds: 48.25,
          is_playing: true
        },
        activeShowId: "f1b5cc5958f1c263",
        armedShow: {
          id: "f1b5cc5958f1c263",
          showUrl: "/api/now-playing/show/f1b5cc5958f1c263"
        },
        preparedAudio: {
          path: "/Volumes/MUSIC/Deep_Minimal_3_/Alves - Oh K (2025).flac",
          audioUrl: "/api/now-playing/audio/f1b5cc5958f1c263",
          durationSeconds: 159.37498866213153,
          provider: "disk"
        },
        preparing: null,
        providerAttempts: [],
        sourceDiagnostics: {
          source_app: "Rekordbox",
          database_loaded: true,
          selected_path: "/Volumes/MUSIC/Deep_Minimal_3_/Alves - Oh K (2025).flac",
          selected_content_id: "123",
          selected_via: "open_audio_db_match",
          open_audio_candidates: [
            {
              path: "/Volumes/MUSIC/Deep_Minimal_3_/Alves - Oh K (2025).flac",
              title: "Oh K",
              artist: "Alves",
              content_id: "123",
              current_offset: 1000,
              previous_offset: 500,
              offset_delta: 500,
              file_size: 4000,
              buffer_ratio: 0.25,
              is_fully_buffered: false,
              recent_event_at: null,
              selected: true,
              matched_record: true
            }
          ],
          recent_event_content_ids: ["123"]
        }
      })
    }));

    const payload = await fetchNowPlayingStatus(fetchImpl as unknown as typeof fetch);

    expect(payload.observation).toEqual({
      sourceApp: "Rekordbox",
      title: "Oh K",
      artist: "Alves",
      durationSeconds: 159,
      observedAt: "2026-05-16T20:59:53.878731Z",
      playbackPositionSeconds: 48.25,
      isPlaying: true
    });
    expect(payload.modeState).toBe("premade_active");
    expect(payload.activeShowId).toBe("f1b5cc5958f1c263");
    expect(payload.sourceDiagnostics).toEqual({
      sourceApp: "Rekordbox",
      databaseLoaded: true,
      selectedPath: "/Volumes/MUSIC/Deep_Minimal_3_/Alves - Oh K (2025).flac",
      selectedContentId: "123",
      selectedVia: "open_audio_db_match",
      openAudioCandidates: [
        {
          path: "/Volumes/MUSIC/Deep_Minimal_3_/Alves - Oh K (2025).flac",
          title: "Oh K",
          artist: "Alves",
          contentId: "123",
          currentOffset: 1000,
          previousOffset: 500,
          offsetDelta: 500,
          fileSize: 4000,
          bufferRatio: 0.25,
          isFullyBuffered: false,
          recentEventAt: null,
          selected: true,
          matchedRecord: true
        }
      ],
      recentEventContentIds: ["123"]
    });
  });
});
