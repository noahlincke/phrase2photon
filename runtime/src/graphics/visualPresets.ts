import type { EnergyLevel, Phrase, ShowPackage, VisualPreset } from "../show/types.js";
import { roleForPhraseKind, selectScene, visualScenes, type SceneRole } from "./visualScenes.js";

/**
 * The visual preset catalogue, derived from the scene list.
 *
 * One preset per scene. The previous catalogue held thirty-two entries
 * generated from combinations of layer flags, which meant the picker was a
 * wall of names nobody could tell apart and most combinations had never been
 * looked at. Six named scenes with stated purposes are easier to choose
 * between and far easier to keep good.
 */

export function visualPresetCatalog(): VisualPreset[] {
  return visualScenes.map((scene) => ({
    preset_id: scene.id,
    name: scene.name,
    family: scene.roles[0],
    mode_support: ["deterministic", "live-rotation"],
    phrase_tags: scene.roles,
    energy_tags: energyTagsForRange(scene.energyRange),
    style_tags: ["line", "geometric"],
    palette_key: "smoke-cool",
    engine: "glsl",
    thumbnail_url: null,
    clip_source: null,
    notes: [scene.note]
  }));
}

function energyTagsForRange(range: [number, number]): EnergyLevel[] {
  const levels: Array<{ level: EnergyLevel; at: number }> = [
    { level: "low", at: 0.15 },
    { level: "mid", at: 0.45 },
    { level: "high", at: 0.7 },
    { level: "peak", at: 0.9 }
  ];
  const matched = levels.filter((entry) => entry.at >= range[0] - 0.12 && entry.at <= range[1] + 0.12);
  return (matched.length ? matched : levels).map((entry) => entry.level);
}

/**
 * Maps preset ids from show packages compiled before the renderer was
 * replaced onto the nearest current scene, so existing shows still play.
 */
const LEGACY_PRESET_SCENES: Record<string, string> = {
  "calm-prism-chamber": "contour",
  "glass-tide-sanctum": "contour",
  "velvet-ion-mist": "contour",
  "echo-caustic-drift": "contour",
  "opal-current-orbit": "radial",
  "storm-veil-pressure": "interference",
  "deep-house-mandala": "radial",
  "ivory-echo-wheel": "radial",
  "orbital-petal-array": "radial",
  "drop-mandala-flare": "strobe",
  "mirror-halo-fan": "radial",
  "lattice-ascent-tunnel": "tunnel",
  "crystal-overdrive": "tunnel",
  "void-rib-accelerator": "tunnel",
  "chrome-synapse-bloom": "interference",
  "phase-reactor-crown": "strobe",
  "ionic-sigil-gate": "horizon",
  "aegean-letter-vault": "contour",
  "oracle-ring-procession": "horizon",
  "temple-vector-drop": "strobe",
  "contour-bloom-study": "contour",
  "arc-resonance-study": "radial",
  "razor-grid-swing": "interference",
  "hinge-pressure-rig": "horizon",
  "blade-echo-chop": "strobe",
  "fantasy-dash-repeater": "tunnel",
  "sigil-caster-chop": "interference",
  "bow-draw-snapcut": "horizon",
  "parry-freeze-array": "strobe",
  "cloak-turn-strobe": "strobe",
  "summon-burst-loop": "tunnel",
  "impact-pose-carousel": "strobe"
};

export function sceneIdForPresetId(presetId: string | null | undefined): string | null {
  if (!presetId) {
    return null;
  }
  if (visualScenes.some((scene) => scene.id === presetId)) {
    return presetId;
  }
  return LEGACY_PRESET_SCENES[presetId] ?? null;
}

/** Replaces whatever catalogue a show carries with the current one. */
export function ensureShowPresetCatalog(_show: ShowPackage): VisualPreset[] {
  return visualPresetCatalog();
}

/** Normalised 0-1 energy for a phrase, matching the analyser's scale. */
export function energyValueForPhrase(phrase: Phrase): number {
  const byLevel: Record<EnergyLevel, number> = { low: 0.2, mid: 0.45, high: 0.7, peak: 0.92 };
  const base = byLevel[phrase.energy.level] ?? 0.5;
  return Math.max(0, Math.min(1, base * 0.7 + phrase.energy.dynamics * 0.3));
}

/**
 * Infers a musical role from a phrase.
 *
 * Compiled shows carry phrase names from the Ableton arrangement, which is the
 * most reliable signal available; energy fills in when the name says nothing.
 */
export function roleForPhrase(phrase: Phrase): SceneRole {
  const name = phrase.name.toLowerCase();
  if (name.includes("intro")) {
    return roleForPhraseKind("intro");
  }
  if (name.includes("outro")) {
    return roleForPhraseKind("outro");
  }
  if (name.includes("break") || name.includes("strip")) {
    return roleForPhraseKind("breakdown");
  }
  if (name.includes("build") || name.includes("lift") || name.includes("riser")) {
    return roleForPhraseKind("build");
  }
  if (name.includes("drop")) {
    return roleForPhraseKind("drop");
  }
  return phrase.energy.level === "peak" ? "peak" : phrase.energy.level === "low" ? "calm" : "groove";
}

export function buildDefaultPhraseVisualAssignments(show: ShowPackage): ShowPackage["phrase_visual_assignments"] {
  let previous: string | null = null;
  return show.phrases.map((phrase) => {
    const scene = selectScene(roleForPhrase(phrase), energyValueForPhrase(phrase), previous);
    previous = scene.id;
    return {
      phrase_id: phrase.phrase_id,
      preset_id: scene.id,
      locked: true,
      palette_override: null,
      parameter_overrides: {}
    };
  });
}
