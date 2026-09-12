import {
  CONTOUR_GLSL,
  HORIZON_GLSL,
  INTERFERENCE_GLSL,
  RADIAL_GLSL,
  STROBE_GLSL,
  TUNNEL_GLSL
} from "./glsl/scenes.js";

/**
 * The visual scene catalogue.
 *
 * Six scenes, not thirty-two. The previous catalogue had thirty-two entries
 * built from combinations of layer flags, which meant most of them differed
 * only in ways nobody could name and the picker became a wall of noise. Each
 * of these is a distinct idea with a stated job.
 */

export type SceneRole = "calm" | "groove" | "build" | "peak";

export interface VisualScene {
  id: string;
  name: string;
  /** One line on what it is for; shown in the picker. */
  note: string;
  roles: SceneRole[];
  /** Energy band it suits, on the 0-1 scale used by the analyser. */
  energyRange: [number, number];
  fragmentShader: string;
}

export const visualScenes: VisualScene[] = [
  {
    id: "contour",
    name: "Contour",
    note: "Topographic level lines that drift. For intros and breakdowns.",
    roles: ["calm"],
    energyRange: [0, 0.45],
    fragmentShader: CONTOUR_GLSL
  },
  {
    id: "radial",
    name: "Radial",
    note: "Centred symmetry with a ring on every beat.",
    roles: ["calm", "groove"],
    energyRange: [0.15, 0.7],
    fragmentShader: RADIAL_GLSL
  },
  {
    id: "horizon",
    name: "Horizon",
    note: "Perspective floor advancing one cell per beat.",
    roles: ["groove"],
    energyRange: [0.25, 0.8],
    fragmentShader: HORIZON_GLSL
  },
  {
    id: "interference",
    name: "Interference",
    note: "Crossed line families; the moiré tightens as a build rises.",
    roles: ["build"],
    energyRange: [0.35, 0.85],
    fragmentShader: INTERFERENCE_GLSL
  },
  {
    id: "tunnel",
    name: "Tunnel",
    note: "Polygonal travel, one ring past the camera per beat.",
    roles: ["build", "peak"],
    energyRange: [0.5, 1],
    fragmentShader: TUNNEL_GLSL
  },
  {
    id: "strobe",
    name: "Strobe",
    note: "Hard nested frames snapping on the beat. For drops.",
    roles: ["peak"],
    energyRange: [0.65, 1],
    fragmentShader: STROBE_GLSL
  }
];

export function sceneById(id: string | null | undefined): VisualScene | null {
  if (!id) {
    return null;
  }
  return visualScenes.find((scene) => scene.id === id) ?? null;
}

/**
 * Picks a scene for a musical moment.
 *
 * `previousId` is avoided where possible so consecutive phrases do not repeat,
 * which is the main thing that makes a generated show feel mechanical.
 */
export function selectScene(
  role: SceneRole,
  energy: number,
  previousId: string | null
): VisualScene {
  const byRole = visualScenes.filter((scene) => scene.roles.includes(role));
  const pool = byRole.length ? byRole : visualScenes;
  const inRange = pool.filter(
    (scene) => energy >= scene.energyRange[0] && energy <= scene.energyRange[1]
  );
  const candidates = inRange.length ? inRange : pool;
  const fresh = candidates.filter((scene) => scene.id !== previousId);
  return (fresh.length ? fresh : candidates)[0];
}

/** Maps the analyser's phrase roles onto scene roles. */
export function roleForPhraseKind(kind: string): SceneRole {
  switch (kind) {
    case "intro":
    case "breakdown":
    case "outro":
      return "calm";
    case "build":
      return "build";
    case "drop":
      return "peak";
    default:
      return "groove";
  }
}
