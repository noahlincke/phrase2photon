import { readFile } from "node:fs/promises";

import { hydrateShowPackage } from "./hydrate.js";
import { ShowPackageSchema } from "./schema.js";
import type { ShowPackage } from "./types.js";

export { hydrateShowPackage } from "./hydrate.js";

export async function loadShowPackage(path: string): Promise<ShowPackage> {
  const raw = await readFile(path, "utf8");
  return hydrateShowPackage(parseShowPackage(raw));
}

export function parseShowPackage(raw: string): ShowPackage {
  return ShowPackageSchema.parse(JSON.parse(raw)) as ShowPackage;
}

export function requirePhrase(show: ShowPackage, phraseId: string) {
  const phrase = show.phrases.find((candidate) => candidate.phrase_id === phraseId);
  if (!phrase) {
    throw new Error(`Unknown phrase: ${phraseId}`);
  }
  return phrase;
}
