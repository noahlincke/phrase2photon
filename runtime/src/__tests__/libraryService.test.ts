import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLibraryRegistry, toPublicTrack } from "../library/service.js";

describe("library service", () => {
  it("loads a local registry and exposes browser-safe URLs", async () => {
    const root = join(tmpdir(), `p2p-library-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const registryPath = join(root, "library.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        tracks: [
          {
            id: "track-a",
            title: "Track A",
            artist: null,
            abletonProjectPath: "~/Ableton/project.als",
            audioPath: "~/Audio/track.wav",
            showPath: "~/Shows/track-a",
            bpm: 122
          }
        ]
      })
    );

    const registry = await loadLibraryRegistry(registryPath);
    const publicTrack = toPublicTrack(registry.tracks[0]);

    expect(registry.tracks).toHaveLength(1);
    expect(publicTrack.audioUrl).toBe("/media/track-a");
    expect(publicTrack.showUrl).toBe("/api/library/track-a/show");
  });
});
