# FB4 Cue Catalog Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an official-ish FB4 cue catalog with thumbnails from Pangolin's packet, preserve local cue annotations as overrides, and surface thumbnails in the existing runtime cue catalog, current cue panel, and laser timeline annotations.

**Architecture:** Treat the Pangolin packet as the source for generated artifacts and keep runtime logic thin. A generator script will emit a JSON catalog plus thumbnail PNGs, runtime code will merge generated entries with local overrides, and the UI will render the richer metadata without redesigning unrelated show-editing surfaces.

**Tech Stack:** TypeScript, Vite, Vitest, Playwright, Node filesystem APIs, PDF rasterization via system CLI helpers, existing Phrase2Photon runtime UI.

---

## File Structure

- Create: `runtime/scripts/generateFb4CueCatalog.ts`
- Create: `runtime/src/dmx/fb4CueCatalog.generated.ts`
- Create: `runtime/src/dmx/fb4CueCatalog.types.ts`
- Create: `runtime/src/__tests__/fb4CueCatalogGenerator.test.ts`
- Modify: `runtime/src/dmx/fb4CueCatalog.ts`
- Modify: `runtime/src/dmx/fb4Dmx16.ts`
- Modify: `runtime/src/show/types.ts`
- Modify: `runtime/src/app/audioTimeline.ts`
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/app/styles.css`
- Modify: `runtime/src/library/vitePlugin.ts`
- Modify: `runtime/src/__tests__/fb4Dmx16.test.ts`
- Modify: `runtime/e2e/runtime.spec.ts`
- Create: `runtime/public/fb4-thumbnails/.gitkeep`
- Create: `runtime/public/fb4-thumbnails/README.md`
- Create: `runtime/fixtures/fb4/README.md`

### Task 1: Define the richer FB4 catalog model and merge generated entries with local overrides

**Files:**
- Create: `runtime/src/dmx/fb4CueCatalog.types.ts`
- Create: `runtime/src/dmx/fb4CueCatalog.generated.ts`
- Modify: `runtime/src/dmx/fb4CueCatalog.ts`
- Modify: `runtime/src/show/types.ts`
- Test: `runtime/src/__tests__/fb4Dmx16.test.ts`

- [ ] **Step 1: Write the failing catalog-shape test**

```ts
it("exposes generated FB4 catalog entries with thumbnail and source metadata", () => {
  const first = describeFb4Cue(1, 1);
  expect(first).not.toBeNull();
  expect(first?.page).toBe(1);
  expect(first?.cue).toBe(1);
  expect(first?.category).toBe("Smooth Simples");
  expect(first?.source).toBe("official-packet");
  expect(first?.thumbnailPath).toContain("/fb4-thumbnails/");
  expect(typeof first?.description).toBe("string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm test -- --runInBand src/__tests__/fb4Dmx16.test.ts`
Expected: FAIL because `category`, `source`, `thumbnailPath`, and `description` do not exist yet.

- [ ] **Step 3: Add the richer catalog entry type and generated fixture module**

```ts
export interface Fb4CueCatalogEntry {
  page: number;
  cue: number;
  category: string;
  name: string;
  description: string;
  source: "official-packet" | "local-override";
  observedShape: string;
  notes: string;
  slug: string;
  thumbnailPath: string | null;
  colorVariant: string | null;
}

export const fb4CueCatalogGenerated: Fb4CueCatalogEntry[] = [
  {
    page: 1,
    cue: 1,
    category: "Smooth Simples",
    name: "Circle",
    description: "",
    source: "official-packet",
    observedShape: "circle",
    notes: "Generated from FB4 Beam Content Pack packet.",
    slug: "circle",
    thumbnailPath: "/fb4-thumbnails/p1-c1.png",
    colorVariant: null
  }
];
```

- [ ] **Step 4: Update the merge layer to preserve local names and descriptions separately**

```ts
interface Fb4CueCatalogOverride {
  name?: string;
  description?: string;
}

export function catalogEntryFor(page: number, cue: number): Fb4CueCatalogEntry | null {
  const generated = describeGeneratedFb4Cue(page, cue);
  if (!generated) {
    return null;
  }
  const override = catalogOverrides[catalogKey(page, cue)];
  if (!override) {
    return generated;
  }
  return {
    ...generated,
    name: override.name?.trim() || generated.name,
    description: override.description?.trim() || generated.description,
    source: override.name || override.description ? "local-override" : generated.source
  };
}
```

- [ ] **Step 5: Extend `DmxLaserCue` with an explicit catalog reference**

```ts
export interface DmxLaserCue {
  cue_id: string;
  phrase_id: string;
  fixture_group: string;
  mode: string;
  page?: number;
  cue?: number;
  parameter_overrides: Record<string, number | string>;
}
```

- [ ] **Step 6: Run tests to verify the richer model passes**

Run: `cd runtime && npm test -- --runInBand src/__tests__/fb4Dmx16.test.ts`
Expected: PASS with the richer catalog fields and backward-compatible page-1 behavior.

- [ ] **Step 7: Commit**

```bash
git add runtime/src/dmx/fb4CueCatalog.types.ts runtime/src/dmx/fb4CueCatalog.generated.ts runtime/src/dmx/fb4CueCatalog.ts runtime/src/show/types.ts runtime/src/__tests__/fb4Dmx16.test.ts
git commit -m "feat: add generated fb4 catalog model"
```

### Task 2: Build the FB4 packet-to-thumbnail generator and generated catalog artifact

**Files:**
- Create: `runtime/scripts/generateFb4CueCatalog.ts`
- Create: `runtime/src/__tests__/fb4CueCatalogGenerator.test.ts`
- Create: `runtime/public/fb4-thumbnails/.gitkeep`
- Create: `runtime/public/fb4-thumbnails/README.md`
- Create: `runtime/fixtures/fb4/README.md`

- [ ] **Step 1: Write the failing generator test**

```ts
import { describe, expect, it } from "vitest";
import { buildGeneratedCatalogEntry, thumbnailFilename } from "../scripts/generateFb4CueCatalog.js";

describe("FB4 catalog generator helpers", () => {
  it("builds deterministic thumbnail paths and generated names", () => {
    expect(thumbnailFilename(5, 14)).toBe("p5-c14.png");
    expect(buildGeneratedCatalogEntry({ page: 5, cue: 14, category: "Sheets" }).thumbnailPath)
      .toBe("/fb4-thumbnails/p5-c14.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm test -- --runInBand src/__tests__/fb4CueCatalogGenerator.test.ts`
Expected: FAIL because the generator helpers do not exist yet.

- [ ] **Step 3: Implement the generator script with deterministic paths**

```ts
export function thumbnailFilename(page: number, cue: number): string {
  return `p${page}-c${cue}.png`;
}

export function buildGeneratedCatalogEntry(input: {
  page: number;
  cue: number;
  category: string;
  name?: string;
  colorVariant?: string | null;
}): Fb4CueCatalogEntry {
  const label = input.name ?? `${input.category} Cue ${input.cue}`;
  return {
    page: input.page,
    cue: input.cue,
    category: input.category,
    name: label,
    description: "",
    source: "official-packet",
    observedShape: label.toLowerCase(),
    notes: "Generated from FB4 Beam Content Pack packet.",
    slug: slugify(label),
    thumbnailPath: `/fb4-thumbnails/${thumbnailFilename(input.page, input.cue)}`,
    colorVariant: input.colorVariant ?? null
  };
}
```

- [ ] **Step 4: Add the packet rasterization and crop pipeline**

```ts
const packetPdf = process.env.FB4_PACKET_PDF ?? `${homedir()}/Downloads/FB4_Beam_Content_Pack_1.0.pdf`;
await execa("pdftoppm", ["-png", packetPdf, join(tmpDir, "packet")]);
await cropCueGrid({
  sourceImage: join(tmpDir, "packet-020.png"),
  rows: 6,
  columns: 8,
  destinationDir: publicThumbnailDir,
  page: 1
});
await writeFile(
  generatedModulePath,
  `export const fb4CueCatalogGenerated = ${JSON.stringify(entries, null, 2)} as const;\n`,
  "utf8"
);
```

- [ ] **Step 5: Document the manual input expectations**

```md
# FB4 packet fixture notes

- Place `FB4_Beam_Content_Pack_1.0.pdf` here for local regeneration if it is not in `~/Downloads`.
- The generator writes thumbnails to `runtime/public/fb4-thumbnails/`.
- Generated catalog data is committed through `runtime/src/dmx/fb4CueCatalog.generated.ts`.
```

- [ ] **Step 6: Run unit tests and a dry generator pass**

Run: `cd runtime && npm test -- --runInBand src/__tests__/fb4CueCatalogGenerator.test.ts`
Expected: PASS

Run: `cd runtime && node --experimental-strip-types scripts/generateFb4CueCatalog.ts --dry-run`
Expected: prints generated entry count and planned thumbnail output paths without writing files.

- [ ] **Step 7: Commit**

```bash
git add runtime/scripts/generateFb4CueCatalog.ts runtime/src/__tests__/fb4CueCatalogGenerator.test.ts runtime/public/fb4-thumbnails/.gitkeep runtime/public/fb4-thumbnails/README.md runtime/fixtures/fb4/README.md
git commit -m "feat: add fb4 packet thumbnail generator"
```

### Task 3: Replace the localStorage string-only override path with structured overrides and preserve existing names

**Files:**
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/dmx/fb4CueCatalog.ts`
- Test: `runtime/e2e/runtime.spec.ts`

- [ ] **Step 1: Write the failing override migration test**

```ts
test("cue catalog editor preserves existing local names and exposes descriptions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("p2p.dmx.cueCatalog", JSON.stringify({ "1:5": "Five Point Star" }));
  });
  await page.goto("/");
  await page.locator("#cueCatalogMode").check();
  await expect(page.locator("#cueCatalog")).toContainText("Five Point Star");
  await expect(page.getByPlaceholder("Description")).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm run e2e -- --grep "cue catalog editor preserves existing local names"`
Expected: FAIL because the editor only supports a single text input and no migration path.

- [ ] **Step 3: Add structured overrides and migration logic**

```ts
type Fb4CueCatalogOverrideRecord = Record<string, { name?: string; description?: string }>;

function loadCatalogOverrides(): Fb4CueCatalogOverrideRecord {
  const raw = localStorage.getItem("p2p.dmx.cueCatalog");
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => {
    if (typeof value === "string") {
      return [key, { name: value.trim() }];
    }
    if (value && typeof value === "object") {
      const record = value as { name?: unknown; description?: unknown };
      return [key, {
        name: typeof record.name === "string" ? record.name.trim() : undefined,
        description: typeof record.description === "string" ? record.description.trim() : undefined
      }];
    }
    return [key, {}];
  }));
}
```

- [ ] **Step 4: Update the editor UI to show generated name, local name, and description**

```ts
const generated = describeFb4Cue(entry.page, entry.cue);
const description = document.createElement("input");
description.type = "text";
description.placeholder = "Description";
description.value = catalogStoredOverrideFor(entry.page, entry.cue)?.description ?? "";
description.addEventListener("input", () => {
  saveCatalogOverride(entry.page, entry.cue, {
    name: input.value,
    description: description.value
  });
});
row.append(playButton, generatedLabel, input, description);
```

- [ ] **Step 5: Run the targeted Playwright check**

Run: `cd runtime && npm run e2e -- --grep "cue catalog editor preserves existing local names"`
Expected: PASS with migrated names and visible description inputs.

- [ ] **Step 6: Commit**

```bash
git add runtime/src/app/main.ts runtime/src/dmx/fb4CueCatalog.ts runtime/e2e/runtime.spec.ts
git commit -m "feat: migrate fb4 catalog overrides to structured records"
```

### Task 4: Render thumbnails in the cue catalog, current cue panel, and phrase output/timeline laser surfaces

**Files:**
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/app/audioTimeline.ts`
- Modify: `runtime/src/app/styles.css`
- Modify: `runtime/src/dmx/fb4Dmx16.ts`
- Test: `runtime/e2e/runtime.spec.ts`

- [ ] **Step 1: Write the failing UI test for thumbnail rendering**

```ts
test("shows FB4 thumbnails in the cue catalog and current cue panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#cueCatalog img").first()).toBeVisible();
  await page.getByRole("button", { name: "Cue 1" }).click();
  await expect(page.locator("#currentCue img")).toBeVisible();
});
```

- [ ] **Step 2: Write the failing timeline annotation test**

```ts
test("renders laser cue chips on the audio timeline overlay", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".timeline-laser-chip").first()).toBeVisible();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd runtime && npm run e2e -- --grep "FB4 thumbnails|laser cue chips"`
Expected: FAIL because no cue thumbnails or laser chips are rendered yet.

- [ ] **Step 4: Render thumbnail-backed cue rows and current cue previews**

```ts
function cueThumbnail(entry: Fb4CueCatalogEntry): HTMLImageElement | null {
  if (!entry.thumbnailPath) {
    return null;
  }
  const image = document.createElement("img");
  image.src = entry.thumbnailPath;
  image.alt = `P${entry.page} C${entry.cue} ${entry.name}`;
  image.loading = "lazy";
  return image;
}

row.append(cueThumbnail(entry) ?? fallbackSwatch(entry), textColumn);
elements.currentCue.replaceChildren(label, previewImage, title, details);
```

- [ ] **Step 5: Feed timeline annotations with catalog metadata**

```ts
export interface TimelineLaserCue {
  phraseId: string;
  page: number;
  cue: number;
  name: string;
  thumbnailPath: string | null;
}

audioTimeline.render({
  ...base,
  laserCues: loaded.show.dmx_laser_cues.map((cue) => toTimelineLaserCue(cue))
});
```

- [ ] **Step 6: Add the CSS needed for compact thumbnail chips**

```css
.cue-catalog-row img,
.current-cue img,
.timeline-laser-chip img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}
```

- [ ] **Step 7: Run the runtime test suite**

Run: `cd runtime && npm test && npm run e2e -- --grep "FB4 thumbnails|laser cue chips"`
Expected: PASS with visible cue thumbnails and timeline chips.

- [ ] **Step 8: Commit**

```bash
git add runtime/src/app/main.ts runtime/src/app/audioTimeline.ts runtime/src/app/styles.css runtime/src/dmx/fb4Dmx16.ts runtime/e2e/runtime.spec.ts
git commit -m "feat: render fb4 thumbnails in runtime surfaces"
```

### Task 5: Export the richer cue catalog and verify the full runtime path

**Files:**
- Modify: `runtime/src/library/vitePlugin.ts`
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/e2e/runtime.spec.ts`

- [ ] **Step 1: Write the failing export shape test**

```ts
test("exports cue catalog entries with thumbnails and descriptions", async ({ page }) => {
  await page.goto("/");
  const response = await page.request.get("/api/dmx/cue-catalog/exported");
  const payload = await response.json();
  expect(payload.entries[0].thumbnailPath).toContain("/fb4-thumbnails/");
  expect(payload.entries[0]).toHaveProperty("description");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm run e2e -- --grep "exports cue catalog entries"`
Expected: FAIL because the export currently only includes `page`, `cue`, `name`, `slug`, `observedShape`, and `notes`.

- [ ] **Step 3: Expand the export payload and stable filename**

```ts
const payload = {
  version: 2,
  fixture: "pangolin-fb4-dmx16",
  exportedAt: new Date().toISOString(),
  entries: entries.map((entry) => ({
    page: entry.page,
    cue: entry.cue,
    category: entry.category,
    name: entry.name,
    description: entry.description,
    slug: entry.slug,
    observedShape: entry.observedShape,
    notes: entry.notes,
    source: entry.source,
    thumbnailPath: entry.thumbnailPath,
    colorVariant: entry.colorVariant
  }))
};
```

- [ ] **Step 4: Update the export path to be generic, not page-one-specific**

```ts
function cueCatalogExportPath(): string {
  return join(homedir(), "Phrase2PhotonShows", "exports", "fb4-cue-catalog.json");
}
```

- [ ] **Step 5: Run full verification**

Run: `cd runtime && npm run typecheck`
Expected: PASS

Run: `cd runtime && npm test`
Expected: PASS

Run: `cd runtime && npm run e2e`
Expected: PASS

Run: `cd runtime && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add runtime/src/library/vitePlugin.ts runtime/src/app/main.ts runtime/e2e/runtime.spec.ts
git commit -m "feat: export rich fb4 catalog metadata"
```

## Self-Review

- Spec coverage:
  - Generated official catalog: covered by Tasks 1 and 2.
  - Extracted thumbnails: covered by Task 2.
  - Descriptions plus migration of current names: covered by Task 3.
  - Runtime thumbnail integration for existing FB4 surfaces: covered by Task 4.
  - Export and verification: covered by Task 5.
- Placeholder scan:
  - No `TODO`, `TBD`, or implicit "write tests later" steps remain.
- Type consistency:
  - `Fb4CueCatalogEntry`, `thumbnailPath`, `description`, and structured overrides are named consistently across tasks.

Plan complete and saved to `docs/superpowers/plans/2026-05-15-fb4-catalog-thumbnails.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
