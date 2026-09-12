import { fb4CueCatalogGenerated } from "./fb4CueCatalog.generated.js";
import type { Fb4CueCatalogEntry } from "./fb4CueCatalog.types.js";

const observedPageOneNames: Record<number, string> = {
  1: "Circle",
  2: "Horizontal line",
  3: "Upside-down triangle",
  4: "Square",
  5: "Moving Single Sine Wave",
  6: "Moving Triple Sine Wave",
  7: "Moving Triple Square Wave",
  8: "Moving Triple Saw Wave",
  9: "Four Horizontal Circles",
  10: "Three Circles",
  11: "Four Vertical Lines",
  12: "Four Box Lines",
  13: "Boxy Cross",
  14: "X",
  15: "Star",
  16: "Target (Lines with Circle)",
  17: "Boxy X",
  18: "Tighter Boxy X",
  19: "Symmetrical Star Loops",
  20: "Tight Symmetrical Star Loops",
  21: "Red Circle with White NESW",
  22: "Red Line with White End/Midpoints",
  23: "Red Upside-down Triangle with White",
  24: "Square with End Points",
  25: "Moving Single Sine Wave (w End Point)",
  26: "Moving Triple Sine Wave (w End Points)"
};

export type { Fb4CueCatalogEntry, Fb4CueCatalogOverride, Fb4CueCatalogSource } from "./fb4CueCatalog.types.js";

export const fb4CueCatalog: Fb4CueCatalogEntry[] = mergeObservedEntries(fb4CueCatalogGenerated);

export function describeFb4Cue(page: number, cue: number): Fb4CueCatalogEntry | null {
  return fb4CueCatalog.find((entry) => entry.page === page && entry.cue === cue) ?? null;
}

export function applyCatalogOverride(
  entry: Fb4CueCatalogEntry,
  override: { name?: string; description?: string }
): Fb4CueCatalogEntry {
  const description = override.description?.trim() || override.name?.trim() || entry.description;
  if (!description) {
    return entry;
  }
  return {
    ...entry,
    description,
    source: "local-override",
    notes: "Local cue metadata."
  };
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function mergeObservedEntries(entries: Fb4CueCatalogEntry[]): Fb4CueCatalogEntry[] {
  const merged = new Map<string, Fb4CueCatalogEntry>();
  for (const entry of entries) {
    merged.set(keyFor(entry.page, entry.cue), entry);
  }
  for (const [cueValue, name] of Object.entries(observedPageOneNames)) {
    const cue = Number.parseInt(cueValue, 10);
    const key = keyFor(1, cue);
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        name,
        description: existing.description || name,
        source: "observed-local",
        observedShape: name.toLowerCase(),
        notes: "Observed on physical FB4 page 1.",
        slug: slugify(name)
      });
      continue;
    }
    merged.set(key, {
      page: 1,
      cue,
      category: "Smooth Simples Colors",
      name,
      description: name,
      source: "observed-local",
      observedShape: name.toLowerCase(),
      notes: "Observed on physical FB4 page 1.",
      slug: slugify(name),
      thumbnailPath: cue <= 100 ? `/fb4-thumbnails/p1-c${cue}.png` : null
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.page - right.page || left.cue - right.cue);
}

function keyFor(page: number, cue: number): string {
  return `${page}:${cue}`;
}
