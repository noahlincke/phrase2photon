import { describe, expect, it } from "vitest";

import { buildPresetDemoManifest } from "../export/demoManifest.js";

describe("buildPresetDemoManifest", () => {
  it("builds a stable manifest for a 10-second preset demo batch", () => {
    const manifest = buildPresetDemoManifest({
      presetIds: ["calm-prism-chamber", "blade-echo-chop"],
      trackId: "kolter-let-you-go",
      baseStartSeconds: 37,
      durationSeconds: 10
    });

    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.filename).toBe("01-calm-prism-chamber-kolter-let-you-go.mp4");
    expect(manifest.entries[1]?.filename).toBe("02-blade-echo-chop-kolter-let-you-go.mp4");
    expect(manifest.entries[0]?.durationSeconds).toBe(10);
  });
});
