import { describe, expect, it } from "vitest";

import { applyRekordboxLineFaderMute } from "../dmx/rekordboxGate.js";
import { buildFb4CueFrame, buildFb4LegacyCueFrame } from "../dmx/fb4Dmx16.js";

describe("Rekordbox line-fader laser mute", () => {
  it("cuts the laser dimmer when enabled and every line fader is at zero", () => {
    const frame39 = applyRekordboxLineFaderMute(buildFb4CueFrame(8, 122), true, 0);
    const frame16 = applyRekordboxLineFaderMute(buildFb4LegacyCueFrame(8, 122), true, 0);

    expect(frame39.channels[16]).toBe(0);
    expect(frame16.channels[4]).toBe(0);
  });

  it("leaves laser brightness alone when any line fader is above zero", () => {
    const base = buildFb4CueFrame(8, 122);
    const gated = applyRekordboxLineFaderMute(base, true, 0.15);

    expect(gated.channels[16]).toBe(base.channels[16]);
  });
});
