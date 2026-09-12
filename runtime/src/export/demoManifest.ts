export interface BuildPresetDemoManifestInput {
  presetIds: string[];
  trackId: string;
  baseStartSeconds: number;
  durationSeconds: number;
}

export interface PresetDemoManifestEntry {
  order: number;
  presetId: string;
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  filename: string;
}

export interface PresetDemoManifest {
  version: 1;
  entries: PresetDemoManifestEntry[];
}

export function buildPresetDemoManifest(input: BuildPresetDemoManifestInput): PresetDemoManifest {
  return {
    version: 1,
    entries: input.presetIds.map((presetId, index) => ({
      order: index + 1,
      presetId,
      trackId: input.trackId,
      startSeconds: chooseStartSeconds(input.baseStartSeconds, presetId, index),
      durationSeconds: input.durationSeconds,
      filename: `${String(index + 1).padStart(2, "0")}-${presetId}-${input.trackId}.mp4`
    }))
  };
}

function chooseStartSeconds(baseStartSeconds: number, presetId: string, index: number): number {
  if (presetId.includes("drop") || presetId.includes("chop") || presetId.includes("strike")) {
    return baseStartSeconds + 60;
  }
  if (presetId.includes("intro") || presetId.includes("calm") || presetId.includes("mist")) {
    return Math.max(0, baseStartSeconds - 20);
  }
  return baseStartSeconds + (index % 4) * 8;
}
