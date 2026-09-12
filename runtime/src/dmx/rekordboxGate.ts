import type { Fb4Dmx16Frame } from "./fb4Dmx16.js";

export function applyRekordboxLineFaderMute(
  frame: Fb4Dmx16Frame,
  enabled: boolean,
  highestLineFader: number | null
): Fb4Dmx16Frame {
  if (!enabled || highestLineFader === null || highestLineFader > 0) {
    return frame;
  }
  const channels = [...frame.channels];
  if (frame.profile === "pangolin-fb4-dmx39") {
    channels[16] = 0;
  } else {
    channels[4] = 0;
  }
  return {
    ...frame,
    channels
  };
}
