import type { Phrase, ShowPackage, VisualPreset } from "../show/types.js";

export interface ResolveVisualPresetInput {
  mode: "deterministic" | "live-rotation";
  phraseId: string;
  show: ShowPackage;
  previousPresetId: string | null;
  manualOverridePresetId?: string | null;
}

export interface ResolvedVisualPreset {
  preset: VisualPreset;
  source: "manual" | "assignment" | "rotation";
}

export type PresetResolutionMode = ResolveVisualPresetInput["mode"];

export function resolveVisualPreset(input: ResolveVisualPresetInput): ResolvedVisualPreset {
  if (input.manualOverridePresetId) {
    return {
      preset: requirePreset(input.show, input.manualOverridePresetId),
      source: "manual"
    };
  }

  if (input.mode === "deterministic") {
    const assignment = input.show.phrase_visual_assignments.find((entry) => entry.phrase_id === input.phraseId);
    if (assignment) {
      return {
        preset: requirePreset(input.show, assignment.preset_id),
        source: "assignment"
      };
    }
  }

  const phrase = requirePhrase(input.show, input.phraseId);
  const compatible = compatiblePresetsForPhrase(input.show, phrase, input.mode);
  if (!compatible.length) {
    throw new Error(`No compatible presets for phrase ${input.phraseId} in mode ${input.mode}.`);
  }

  const filtered = input.previousPresetId
    ? compatible.filter((preset) => preset.preset_id !== input.previousPresetId)
    : compatible;
  const pool = filtered.length ? filtered : compatible;
  return {
    preset: pool[0],
    source: "rotation"
  };
}

export function compatiblePresetsForPhraseId(
  show: ShowPackage,
  phraseId: string,
  mode: PresetResolutionMode
): VisualPreset[] {
  return compatiblePresetsForPhrase(show, requirePhrase(show, phraseId), mode);
}

function compatiblePresetsForPhrase(show: ShowPackage, phrase: Phrase, mode: PresetResolutionMode): VisualPreset[] {
  return show.preset_catalog.filter((preset) => {
    if (!preset.mode_support.includes(mode)) {
      return false;
    }

    const energyMatch = preset.energy_tags.length === 0 || preset.energy_tags.includes(phrase.energy.level);
    if (!energyMatch) {
      return false;
    }

    const phraseTag = phraseTagForPhrase(phrase);
    return preset.phrase_tags.length === 0 || preset.phrase_tags.includes(phraseTag);
  });
}

function phraseTagForPhrase(phrase: Phrase): string {
  const name = phrase.name.toLowerCase();
  if (name.includes("intro")) {
    return "intro";
  }
  if (name.includes("build") || name.includes("lift")) {
    return "build";
  }
  if (name.includes("drop")) {
    return "drop";
  }
  if (name.includes("outro")) {
    return "outro";
  }
  if (phrase.energy.level === "low") {
    return "groove";
  }
  return "groove";
}

function requirePhrase(show: ShowPackage, phraseId: string): Phrase {
  const phrase = show.phrases.find((candidate) => candidate.phrase_id === phraseId);
  if (!phrase) {
    throw new Error(`Unknown phrase: ${phraseId}`);
  }
  return phrase;
}

function requirePreset(show: ShowPackage, presetId: string): VisualPreset {
  const preset = show.preset_catalog.find((candidate) => candidate.preset_id === presetId);
  if (!preset) {
    throw new Error(`Unknown preset: ${presetId}`);
  }
  return preset;
}
