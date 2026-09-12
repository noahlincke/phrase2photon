export interface Fb4LaserColorSlot {
  id: string;
  name: string;
  graphicsColor: string;
  observedName: string;
  channel15: number;
  nominalBand: string;
  role: string;
}

export interface Fb4LaserColorProfile {
  version: 1;
  fixture: "pangolin-fb4-dmx16";
  profileId: string;
  profileName: string;
  channel: 15;
  slots: Fb4LaserColorSlot[];
}

export const fb4ProjectorColorProfile: Fb4LaserColorProfile = {
  version: 1,
  fixture: "pangolin-fb4-dmx16",
  profileId: "nlincke-fb4-projector-v1",
  profileName: "Noah FB4 Projector v1",
  channel: 15,
  slots: [
    {
      id: "smoke-cool",
      name: "Smoke Cool",
      graphicsColor: "#7dd3fc",
      observedName: "Neon Blue",
      channel15: 118,
      nominalBand: "green-cyan",
      role: "cool air and wash contrast"
    },
    {
      id: "acid-contrast",
      name: "Acid Contrast",
      graphicsColor: "#d9ff00",
      observedName: "Green",
      channel15: 84,
      nominalBand: "yellow-lime",
      role: "acid hook and phrase lift"
    },
    {
      id: "warm-cinematic",
      name: "Warm Cinematic",
      graphicsColor: "#f59e0b",
      observedName: "Orange",
      channel15: 54,
      nominalBand: "orange",
      role: "warm transition and breakdown glow"
    },
    {
      id: "nocturne-glow",
      name: "Nocturne Glow",
      graphicsColor: "#c084fc",
      observedName: "Red",
      channel15: 207,
      nominalBand: "pink-red",
      role: "night accent and tension color"
    },
    {
      id: "desaturated_decay",
      name: "Desaturated Decay",
      graphicsColor: "#d1d5db",
      observedName: "White",
      channel15: 240,
      nominalBand: "white",
      role: "neutral white and reset state"
    }
  ]
};

export function slotForPalette(palette: string, profile = fb4ProjectorColorProfile): Fb4LaserColorSlot | null {
  return profile.slots.find((slot) => slot.id === palette) ?? null;
}
