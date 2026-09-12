/**
 * Visual palettes.
 *
 * Every palette is two inks on near-black. The restraint is the point: the
 * previous renderer mixed three accent colours per scene plus independently
 * coloured background layers, which is what made the output read as busy
 * rather than composed. Two colours also keep line work legible when
 * projected, where washed-out midtones disappear.
 */

export interface Palette {
  id: string;
  name: string;
  /** Primary line colour. */
  ink: [number, number, number];
  /** Secondary, used sparingly for emphasis on accents and hits. */
  accent: [number, number, number];
  background: [number, number, number];
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export const palettes: Palette[] = [
  {
    id: "smoke-cool",
    name: "Smoke",
    ink: rgb("#cfe9ff"),
    accent: rgb("#4cc9ff"),
    background: rgb("#04070c")
  },
  {
    id: "nocturne-glow",
    name: "Nocturne",
    ink: rgb("#e6e1ff"),
    accent: rgb("#9d7cff"),
    background: rgb("#06050e")
  },
  {
    id: "warm-cinematic",
    name: "Ember",
    ink: rgb("#ffe6c2"),
    accent: rgb("#ff9d2e"),
    background: rgb("#0c0704")
  },
  {
    id: "acid-contrast",
    name: "Acid",
    ink: rgb("#e8ffb3"),
    accent: rgb("#d9ff00"),
    background: rgb("#030502")
  },
  {
    id: "desaturated_decay",
    name: "Ash",
    ink: rgb("#e8e8e8"),
    accent: rgb("#8f9aa6"),
    background: rgb("#070709")
  }
];

const fallback = palettes[0];

export function paletteById(id: string | null | undefined): Palette {
  if (!id) {
    return fallback;
  }
  return palettes.find((palette) => palette.id === id) ?? fallback;
}
