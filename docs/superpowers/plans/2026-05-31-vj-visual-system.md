# Phrase2Photon VJ Visual System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-class preset-driven visual system for Phrase2Photon, add deterministic and live-rotation preset selection, add an offline demo render/export lane, and produce 32 synced 10-second preset demo videos.

**Architecture:** Replace the current single `WebVisualizer` effect with a catalog-driven graphics runtime. Presets become authored assets with explicit metadata and compatibility tags, shows gain durable phrase-to-preset assignments, and the runtime resolves visuals through deterministic, live-rotation, or manual-override selection. A headless/offline render path reuses the same runtime to export 10-second web-graphics demos muxed with analyzed audio.

**Tech Stack:** TypeScript, Vite, Three.js, Vitest, Playwright, Node.js, ffmpeg, existing Phrase2Photon Python compiler/show contract

---

### Task 1: Extend the show contract for preset catalogs and phrase assignments

**Files:**
- Modify: `runtime/src/show/types.ts`
- Modify: `runtime/src/show/schema.ts`
- Modify: `src/phrase2photon/contracts/show_package.py`
- Modify: `build/example-show.json`
- Test: `runtime/src/__tests__/showLoader.test.ts`
- Test: `runtime/src/__tests__/runtimeState.test.ts`
- Test: `tests/test_show_package.py`

- [ ] **Step 1: Write the failing runtime schema tests**

```typescript
it("parses preset catalogs and phrase preset assignments", async () => {
  const raw = JSON.stringify({
    version: "0.1.0",
    song: { song_id: "test", title: "Test", artist: null, tempo: 124, time_signature: "4/4" },
    preset_catalog: [
      {
        preset_id: "calm-prism-chamber",
        name: "Calm Prism Chamber",
        family: "texture-atmosphere",
        mode_support: ["deterministic", "live-rotation"],
        phrase_tags: ["intro", "groove"],
        energy_tags: ["low", "mid"],
        style_tags: ["texture", "calm"],
        palette_key: "smoke-cool",
        engine: "shader-plane",
        thumbnail_url: null,
        clip_source: null,
        notes: ["slow chamber drift"]
      }
    ],
    phrase_visual_assignments: [
      { phrase_id: "phrase_intro", preset_id: "calm-prism-chamber", locked: true, palette_override: null, parameter_overrides: {} }
    ],
    phrases: [],
    lighting_cues: [],
    dmx_laser_cues: [],
    manual_overrides: []
  });

  const show = parseShowPackage(raw);
  expect(show.preset_catalog[0].preset_id).toBe("calm-prism-chamber");
  expect(show.phrase_visual_assignments[0].preset_id).toBe("calm-prism-chamber");
});
```

- [ ] **Step 2: Run runtime schema tests to verify RED**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/showLoader.test.ts src/__tests__/runtimeState.test.ts`
Expected: FAIL because `preset_catalog` and `phrase_visual_assignments` are unknown/missing from runtime types and schema.

- [ ] **Step 3: Write the failing Python contract test**

```python
def test_show_package_supports_preset_catalog_and_phrase_assignments() -> None:
    package = ShowPackage(
        version="0.1.0",
        song=SongMeta(song_id="song", title="Song", artist=None, tempo=124, time_signature="4/4"),
        preset_catalog=[
            VisualPreset(
                preset_id="calm-prism-chamber",
                name="Calm Prism Chamber",
                family="texture-atmosphere",
                mode_support=["deterministic", "live-rotation"],
                phrase_tags=["intro", "groove"],
                energy_tags=["low", "mid"],
                style_tags=["texture", "calm"],
                palette_key="smoke-cool",
                engine="shader-plane",
            )
        ],
        phrase_visual_assignments=[
            PhraseVisualAssignment(phrase_id="phrase_intro", preset_id="calm-prism-chamber", locked=True)
        ],
        phrases=[],
        lighting_cues=[],
        dmx_laser_cues=[],
        manual_overrides=[],
    )

    assert package.preset_catalog[0].preset_id == "calm-prism-chamber"
    assert package.phrase_visual_assignments[0].locked is True
```

- [ ] **Step 4: Run Python contract test to verify RED**

Run: `cd /Users/nlincke/phrase2photon && ./.venv/bin/pytest tests/test_show_package.py -k preset_catalog -v`
Expected: FAIL because `VisualPreset` and `PhraseVisualAssignment` do not exist yet.

- [ ] **Step 5: Implement the contract additions**

```typescript
export type PresetModeSupport = "deterministic" | "live-rotation";

export interface VisualPreset {
  preset_id: string;
  name: string;
  family: string;
  mode_support: PresetModeSupport[];
  phrase_tags: string[];
  energy_tags: EnergyLevel[];
  style_tags: string[];
  palette_key: string;
  engine: string;
  thumbnail_url: string | null;
  clip_source: string | null;
  notes: string[];
}

export interface PhraseVisualAssignment {
  phrase_id: string;
  preset_id: string;
  locked: boolean;
  palette_override: string | null;
  parameter_overrides: Record<string, string | number | boolean>;
}
```

```python
class VisualPreset(BaseModel):
    preset_id: str
    name: str
    family: str
    mode_support: list[Literal["deterministic", "live-rotation"]]
    phrase_tags: list[str] = Field(default_factory=list)
    energy_tags: list[Literal["low", "mid", "high", "peak"]] = Field(default_factory=list)
    style_tags: list[str] = Field(default_factory=list)
    palette_key: str
    engine: str
    thumbnail_url: str | None = None
    clip_source: str | None = None
    notes: list[str] = Field(default_factory=list)

class PhraseVisualAssignment(BaseModel):
    phrase_id: str
    preset_id: str
    locked: bool = True
    palette_override: str | None = None
    parameter_overrides: dict[str, str | int | float | bool] = Field(default_factory=dict)
```

- [ ] **Step 6: Update example show payload**

```json
{
  "preset_catalog": [
    {
      "preset_id": "calm-prism-chamber",
      "name": "Calm Prism Chamber",
      "family": "texture-atmosphere",
      "mode_support": ["deterministic", "live-rotation"],
      "phrase_tags": ["intro", "groove"],
      "energy_tags": ["low", "mid"],
      "style_tags": ["texture", "calm"],
      "palette_key": "smoke-cool",
      "engine": "shader-plane",
      "thumbnail_url": null,
      "clip_source": null,
      "notes": ["slow chamber drift"]
    }
  ],
  "phrase_visual_assignments": [
    {
      "phrase_id": "phrase_intro",
      "preset_id": "calm-prism-chamber",
      "locked": true,
      "palette_override": null,
      "parameter_overrides": {}
    }
  ]
}
```

- [ ] **Step 7: Run tests to verify GREEN**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/showLoader.test.ts src/__tests__/runtimeState.test.ts`
Expected: PASS

Run: `cd /Users/nlincke/phrase2photon && ./.venv/bin/pytest tests/test_show_package.py -v`
Expected: PASS


### Task 2: Replace the single-effect visualizer with a preset-driven graphics runtime

**Files:**
- Create: `runtime/src/graphics/presetCatalog.ts`
- Create: `runtime/src/graphics/presetSelection.ts`
- Create: `runtime/src/graphics/runtime.ts`
- Create: `runtime/src/scenes/presets.ts`
- Create: `runtime/src/scenes/clipChop.ts`
- Modify: `runtime/src/app/visualizer.ts`
- Modify: `runtime/src/graphics/types.ts`
- Test: `runtime/src/__tests__/runtimeState.test.ts`
- Test: `runtime/src/__tests__/presetSelection.test.ts`

- [ ] **Step 1: Write failing preset-selection tests**

```typescript
it("uses deterministic phrase assignments for library playback", () => {
  const selection = resolveVisualPreset({
    mode: "deterministic",
    phraseId: "phrase_intro",
    show,
    previousPresetId: null
  });

  expect(selection.preset.preset_id).toBe("calm-prism-chamber");
});

it("rotates among compatible live presets without leaving the allowed pool", () => {
  const selection = resolveVisualPreset({
    mode: "live-rotation",
    phraseId: "phrase_drop",
    show,
    previousPresetId: "hard-kaleido-strike"
  });

  expect(selection.preset.style_tags).toContain("percussive");
  expect(selection.preset.mode_support).toContain("live-rotation");
});
```

- [ ] **Step 2: Run runtime tests to verify RED**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/presetSelection.test.ts src/__tests__/runtimeState.test.ts`
Expected: FAIL because preset-selection runtime does not exist.

- [ ] **Step 3: Implement preset catalog and selection**

```typescript
export function resolveVisualPreset(input: ResolveVisualPresetInput): ResolvedVisualPreset {
  if (input.manualOverridePresetId) {
    return { preset: requirePreset(input.show, input.manualOverridePresetId), source: "manual" };
  }

  if (input.mode === "deterministic") {
    const assignment = input.show.phrase_visual_assignments.find((entry) => entry.phrase_id === input.phraseId);
    if (assignment) {
      return { preset: requirePreset(input.show, assignment.preset_id), source: "assignment" };
    }
  }

  const compatible = compatiblePresetsForPhrase(input.show, input.phraseId, input.mode);
  const preset = pickRotatingPreset(compatible, input.rotationSeed, input.previousPresetId);
  return { preset, source: "rotation" };
}
```

- [ ] **Step 4: Implement scene-based visual runtime**

```typescript
export class WebVisualizer {
  private readonly runtime: GraphicsRuntimeImpl;

  constructor(canvas: HTMLCanvasElement) {
    this.runtime = new GraphicsRuntimeImpl(canvas);
  }

  render(frame: VisualizerFrame): void {
    this.runtime.renderFrame(frame);
  }
}
```

```typescript
export interface VisualizerFrame {
  show: ShowPackage;
  playback: PhrasePlaybackState;
  bands: AudioBands;
  nowSeconds: number;
  resolvedPreset: VisualPreset;
}
```

- [ ] **Step 5: Seed preset scene engines**

```typescript
export const presetFactories: Record<string, GraphicsSceneFactory> = {
  "shader-plane": { create: () => new TextureAtmosphereScene() },
  "kaleido-core": { create: () => new CenteredKaleidoscopeScene() },
  "cyber-lattice": { create: () => new CyberLatticeScene() },
  "symbol-temple": { create: () => new SymbolTempleScene() },
  "line-study": { create: () => new LineSymmetryScene() },
  "clip-chop": { create: () => new ClipChopScene() }
};
```

- [ ] **Step 6: Run runtime tests to verify GREEN**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/presetSelection.test.ts src/__tests__/runtimeState.test.ts`
Expected: PASS


### Task 3: Author the initial 32-preset catalog and wire deterministic/live usage

**Files:**
- Create: `runtime/src/graphics/authoredPresets.ts`
- Modify: `build/example-show.json`
- Modify: `src/phrase2photon/contracts/show_package.py`
- Modify: `runtime/src/app/main.ts`
- Test: `runtime/src/__tests__/liveMicInput.test.ts`
- Test: `runtime/src/__tests__/runtimeState.test.ts`
- Test: `runtime/e2e/runtime.spec.ts`

- [ ] **Step 1: Write failing tests for deterministic assignment and live rotation UI/runtime state**

```typescript
it("pins a phrase to its assigned preset during library playback", () => {
  const frame = resolvePlaybackFrame(testShow, "phrase_intro", "library");
  expect(frame.resolvedPreset.preset_id).toBe("calm-prism-chamber");
});

it("rotates compatible presets in mic mode", () => {
  const first = resolvePlaybackFrame(testShow, "phrase_drop", "mic", null);
  const second = resolvePlaybackFrame(testShow, "phrase_drop", "mic", first.resolvedPreset.preset_id);
  expect(second.resolvedPreset.preset_id).not.toBe(first.resolvedPreset.preset_id);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/liveMicInput.test.ts src/__tests__/runtimeState.test.ts`
Expected: FAIL because runtime frames do not yet resolve authored preset catalogs.

- [ ] **Step 3: Author the 32 presets**

```typescript
export const authoredPresets: VisualPreset[] = [
  { preset_id: "calm-prism-chamber", family: "texture-atmosphere", engine: "shader-plane", ... },
  { preset_id: "glass-tide-sanctum", family: "texture-atmosphere", engine: "shader-plane", ... },
  { preset_id: "deep-house-mandala", family: "centered-kaleidoscope", engine: "kaleido-core", ... },
  { preset_id: "drop-lattice-exhale", family: "cyber-psychedelic", engine: "cyber-lattice", ... },
  { preset_id: "ionic-sigil-gate", family: "symbolic-architecture", engine: "symbol-temple", ... },
  { preset_id: "blade-echo-chop", family: "clip-chop", engine: "clip-chop", ... }
];
```

- [ ] **Step 4: Seed library/example shows with assignments**

```typescript
const assignment = {
  phrase_id: phrase.phrase_id,
  preset_id: suggestedPresetIdForPhrase(phrase),
  locked: true,
  palette_override: null,
  parameter_overrides: {}
};
```

- [ ] **Step 5: Wire main runtime selection flow**

```typescript
const resolvedPreset = resolveVisualPreset({
  mode: isMicDrivenMode() ? "live-rotation" : "deterministic",
  show: loaded.show,
  phraseId: playback.active.phrase.phrase_id,
  previousPresetId: lastResolvedPresetId,
  manualOverridePresetId: manualPresetOverrideId
});

visualizer.render({ show: loaded.show, playback, bands, nowSeconds: nowMs / 1000, resolvedPreset });
```

- [ ] **Step 6: Run tests and e2e checks to verify GREEN**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/liveMicInput.test.ts src/__tests__/runtimeState.test.ts`
Expected: PASS

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run e2e -- --grep "Kolter|Mic input|phrase map"`
Expected: PASS


### Task 4: Add operator controls and runtime visibility for preset state

**Files:**
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/app/styles.css`
- Modify: `runtime/e2e/runtime.spec.ts`
- Test: `runtime/src/__tests__/cueOverride.test.ts`

- [ ] **Step 1: Write failing manual override tests**

```typescript
it("keeps a manually pinned preset active until released", () => {
  const override = persistentCueOverrideForPhrase({
    phraseId: "phrase_drop",
    presetId: "deep-house-mandala"
  });

  expect(override?.presetId).toBe("deep-house-mandala");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/cueOverride.test.ts`
Expected: FAIL because preset-level overrides are not modeled.

- [ ] **Step 3: Implement preset-state inspector and controls**

```typescript
<div>
  <h3>Visual Preset</h3>
  <div id="presetState" class="output-row"></div>
  <div id="presetPicker" class="phrase-list"></div>
  <button id="releasePresetOverride" class="secondary-button" type="button">Release preset override</button>
</div>
```

```typescript
interface PersistentCueOverride {
  phraseId: string;
  presetId: string | null;
  cueId?: string | null;
}
```

- [ ] **Step 4: Run tests and e2e checks to verify GREEN**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/cueOverride.test.ts`
Expected: PASS

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run e2e -- --grep "phrase map|Mic input|Now Playing"`
Expected: PASS


### Task 5: Build the offline render/export pipeline

**Files:**
- Create: `runtime/src/export/renderDemo.ts`
- Create: `runtime/src/export/offlineRenderer.ts`
- Create: `runtime/src/export/demoManifest.ts`
- Create: `runtime/scripts/renderPresetDemo.ts`
- Modify: `runtime/package.json`
- Test: `runtime/src/__tests__/demoManifest.test.ts`

- [ ] **Step 1: Write failing offline-export tests**

```typescript
it("builds a stable manifest for a 10-second preset demo", () => {
  const manifest = buildPresetDemoManifest({
    presetId: "calm-prism-chamber",
    trackId: "kolter-let-you-go",
    startSeconds: 37,
    durationSeconds: 10
  });

  expect(manifest.filename).toBe("01-calm-prism-chamber-kolter-let-you-go.mp4");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/demoManifest.test.ts`
Expected: FAIL because offline export modules do not exist.

- [ ] **Step 3: Implement the manifest and renderer**

```typescript
export interface PresetDemoManifestEntry {
  order: number;
  presetId: string;
  trackId: string;
  startSeconds: number;
  durationSeconds: number;
  outputPath: string;
}
```

```typescript
await execa("ffmpeg", [
  "-y",
  "-framerate", "60",
  "-i", `${framesDir}/frame-%05d.png`,
  "-ss", `${startSeconds}`,
  "-t", `${durationSeconds}`,
  "-i", audioPath,
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  outputPath
]);
```

- [ ] **Step 4: Add script entry points**

```json
{
  "scripts": {
    "render:preset-demo": "node ./scripts/renderPresetDemo.ts"
  }
}
```

- [ ] **Step 5: Run tests to verify GREEN**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm test -- src/__tests__/demoManifest.test.ts`
Expected: PASS


### Task 6: Generate and verify the 32 demo videos

**Files:**
- Create: `runtime/public/demo-clips/`
- Create: `runtime/rendered-demos/`
- Create: `runtime/rendered-demos/demo-manifest.json`
- Modify: `runtime/README.md`

- [ ] **Step 1: Create or place placeholder clip assets for the 8 clip-chop presets**

```text
runtime/public/demo-clips/
  fantasy-dash.mp4
  blade-parry.mp4
  sigil-caster.mp4
  bow-draw.mp4
```

- [ ] **Step 2: Render the full preset batch**

Run: `cd /Users/nlincke/phrase2photon/runtime && npm run render:preset-demo -- --track kolter-let-you-go --duration 10 --count 32`
Expected: 32 `.mp4` outputs plus `demo-manifest.json`.

- [ ] **Step 3: Verify file count and naming**

Run: `cd /Users/nlincke/phrase2photon/runtime && find rendered-demos -maxdepth 1 -name '*.mp4' | wc -l`
Expected: `32`

- [ ] **Step 4: Spot-check sync and diversity**

Run: `cd /Users/nlincke/phrase2photon/runtime && ffprobe rendered-demos/01-calm-prism-chamber-kolter-let-you-go.mp4`
Expected: duration near `10.0` seconds with audio and video streams present.

Run: `cd /Users/nlincke/phrase2photon/runtime && ffprobe rendered-demos/32-blade-echo-chop-kolter-let-you-go.mp4`
Expected: duration near `10.0` seconds with audio and video streams present.

- [ ] **Step 5: Document the workflow**

```md
## Preset Demo Export

Run `npm run render:preset-demo -- --track kolter-let-you-go --duration 10 --count 32`
to regenerate the current demo batch under `runtime/rendered-demos/`.
```
