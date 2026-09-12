import {
  buildDefaultPhraseVisualAssignments,
  ensureShowPresetCatalog,
  sceneIdForPresetId
} from "../graphics/visualPresets.js";
import { ShowPackageSchema } from "./schema.js";
import type { ShowPackage } from "./types.js";

export function coerceShowPackage(value: unknown): ShowPackage {
  return hydrateShowPackage(ShowPackageSchema.parse(value) as ShowPackage);
}

export function hydrateShowPackage(show: ShowPackage): ShowPackage {
  const preset_catalog = ensureShowPresetCatalog(show);
  const defaults = buildDefaultPhraseVisualAssignments({ ...show, preset_catalog });

  // Shows compiled against the previous renderer name presets that no longer
  // exist. Remap what can be remapped and fall back to the default choice for
  // that phrase, so an old show still plays rather than failing to resolve.
  const phrase_visual_assignments = show.phrase_visual_assignments.length
    ? show.phrase_visual_assignments.map((assignment, index) => {
        const scene = sceneIdForPresetId(assignment.preset_id);
        return {
          ...assignment,
          preset_id: scene ?? defaults[index]?.preset_id ?? preset_catalog[0].preset_id
        };
      })
    : defaults;

  return {
    ...show,
    preset_catalog,
    phrase_visual_assignments
  };
}
