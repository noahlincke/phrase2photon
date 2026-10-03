import { describe, expect, it } from "vitest";

import { applyLaserLook, latencyShiftedBeats, type LaserLookContext } from "../dmx/laserLooks.js";
import { buildFb4Dmx16Frame, intensityToDimmer, type Fb4Dmx16Frame } from "../dmx/fb4Dmx16.js";
import type { PhraseKind } from "../audio/structure.js";
import type { DmxLaserCue, Phrase, ShowPackage } from "../show/types.js";

const DYNAMICS: Record<PhraseKind, number> = {
  intro: 0.2,
  build: 0.72,
  drop: 1,
  groove: 0.54,
  breakdown: 0.3,
  outro: 0.26
};

const KIND_ORDER: PhraseKind[] = ["intro", "build", "drop", "groove", "breakdown", "outro"];

function phraseFor(kind: PhraseKind, index: number): Phrase {
  return {
    phrase_id: `phrase_${kind}`,
    name: kind,
    range: {
      start_bar_beat: `${index * 8 + 1}|1`,
      end_bar_beat: `${(index + 1) * 8 + 1}|1`,
      start_locator_id: null,
      end_locator_id: null
    },
    locators: [],
    track_features: [],
    energy: { level: "mid", dynamics: DYNAMICS[kind], tension: 0.3 },
    visual_look: { palette: "acid-contrast", motion_style: "steady_orbit", composition: "open", notes: [] },
    transition_in: null,
    transition_out: null
  };
}

const show: ShowPackage = {
  version: "0.1.0",
  song: { song_id: "song", title: "Song", artist: null, tempo: 120, time_signature: "4/4" },
  phrases: KIND_ORDER.map(phraseFor),
  preset_catalog: [],
  phrase_visual_assignments: [],
  lighting_cues: [],
  dmx_laser_cues: [],
  manual_overrides: []
};

function baseFrame(kind: PhraseKind, phraseProgress = 0): Fb4Dmx16Frame {
  const phrase = show.phrases.find((entry) => entry.phrase_id === `phrase_${kind}`)!;
  return buildFb4Dmx16Frame({ show, phrase, lightingCue: null, phraseProgress });
}

function context(overrides: Partial<LaserLookContext>): LaserLookContext {
  return {
    phraseKind: "groove",
    nextPhraseKind: null,
    beatsIntoPhrase: 0,
    beatsInPhrase: 32,
    beatPhase: 0,
    beatInBar: 1,
    beatsPerBar: 4,
    dropHitBeats: null,
    ...overrides
  };
}

function looked(kind: PhraseKind, ctx: Partial<LaserLookContext>, phraseProgress = 0): Fb4Dmx16Frame {
  return applyLaserLook(baseFrame(kind, phraseProgress), context({ phraseKind: kind, ...ctx }));
}

describe("laser looks", () => {
  it("dips to dark on the last beat before a premade drop", () => {
    expect(looked("build", { nextPhraseKind: "drop", beatsIntoPhrase: 31.5 }).channels[4]).toBe(0);
    // More than one beat out, the build pulse still runs.
    expect(looked("build", { nextPhraseKind: "drop", beatsIntoPhrase: 30.5 }).channels[4]).toBeGreaterThan(0);
    // No next-phrase knowledge (live input), no dip.
    expect(looked("build", { nextPhraseKind: null, beatsIntoPhrase: 31.5 }).channels[4]).toBeGreaterThan(0);
  });

  it("hits full on the drop downbeat and chops the burst bar on sixteenths", () => {
    const downbeat = looked("drop", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1 });
    expect(downbeat.channels[4]).toBe(255);
    expect(downbeat.channels[6]).toBe(255);
    expect(downbeat.channels[7]).toBe(255);

    const on = looked("drop", { beatsIntoPhrase: 1.125, beatInBar: 2 });
    const off = looked("drop", { beatsIntoPhrase: 1.375, beatInBar: 2 });
    expect(on.channels[4]).toBe(255);
    expect(off.channels[4]).toBe(0);

    // Past the burst bar the phrase's own accent look takes over.
    const after = looked("drop", { beatsIntoPhrase: 5, beatInBar: 2, beatPhase: 0 });
    expect(after.channels[4]).toBe(255);
  });

  it("fires the live drop hit from the analyzer trigger without a pre-dip", () => {
    const hit = looked("groove", { phraseKind: "drop", dropHitBeats: 0.2, beatsIntoPhrase: 0.2 });
    expect(hit.channels[4]).toBe(255);
    expect(hit.channels[6]).toBe(255);

    const off = looked("groove", { phraseKind: "drop", dropHitBeats: 1.25, beatsIntoPhrase: 1.25 });
    expect(off.channels[4]).toBe(0);

    const late = looked("drop", { beatsIntoPhrase: 9, beatInBar: 2, beatPhase: 0.5 });
    expect(late.channels[4]).toBe(Math.round(128 + (intensityToDimmer(1) - 128) * 0.5));
  });

  it("ramps build size up and pulses the dimmer faster toward the drop", () => {
    const start = looked("build", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1 });
    expect(start.channels[6]).toBe(153);
    expect(start.channels[4]).toBe(intensityToDimmer(0.72));

    const middle = looked("build", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(middle.channels[6]).toBe(204);

    // First half: quarter-note pulses decay over the whole beat.
    const quarter = looked("build", { beatsIntoPhrase: 2.5, beatPhase: 0.5, beatInBar: 3 });
    const peak = intensityToDimmer(0.72);
    const base = Math.round(peak * 0.4);
    expect(quarter.channels[4]).toBe(Math.round(base + (peak - base) * 0.5));

    // Last two bars: sixteenth-note pulses, so mid-interval lands halfway between
    // sixteenths, not halfway between quarters.
    const sixteenth = looked("build", { beatsIntoPhrase: 24.625, beatPhase: 0.625, beatInBar: 3 });
    expect(sixteenth.channels[4]).toBe(Math.round(base + (peak - base) * 0.5));

    // The last two bars go white.
    const white = looked("build", { beatsIntoPhrase: 25, beatPhase: 0, beatInBar: 2 });
    expect(white.channels[14]).toBe(240);
    expect(white.colorLabel).toBe("White");
    const early = looked("build", { beatsIntoPhrase: 10, beatPhase: 0, beatInBar: 3 });
    expect(early.channels[14]).toBe(84);
  });

  it("accents bar downbeats in groove and every beat in drop", () => {
    const peak = intensityToDimmer(0.54);
    const base = Math.round(peak * 0.5);
    const downbeat = looked("groove", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1 });
    expect(downbeat.channels[4]).toBe(peak);
    const decayed = looked("groove", { beatsIntoPhrase: 0.9, beatPhase: 0.9, beatInBar: 1 });
    expect(decayed.channels[4]).toBe(Math.round(base + (peak - base) * 0.1));
    const offBeat = looked("groove", { beatsIntoPhrase: 1, beatPhase: 0, beatInBar: 2 });
    expect(offBeat.channels[4]).toBe(peak);

    const dropPeak = intensityToDimmer(1);
    const dropBase = Math.round(dropPeak * 0.5);
    const dropBeat = looked("drop", { beatsIntoPhrase: 5, beatPhase: 0.5, beatInBar: 2 });
    expect(dropBeat.channels[4]).toBe(Math.round(dropBase + (dropPeak - dropBase) * 0.5));
  });

  it("leaves breakdown dimmer and pool alone but halves the angle ramp", () => {
    const breakdown = looked("breakdown", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(breakdown.channels[4]).toBe(intensityToDimmer(0.3));
    expect(breakdown.channels[8]).toBe(64);

    const groove = looked("groove", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 }, 0.5);
    expect(groove.channels[8]).toBe(128);
  });

  it("drives the 39-channel pairs for size, dimmer and angle", () => {
    const laserCue: DmxLaserCue = {
      cue_id: "cue",
      phrase_id: "phrase_drop",
      fixture_group: "laser_main",
      mode: "cue",
      parameter_overrides: { page: 5, cue: 60 }
    };
    const phrase = show.phrases.find((entry) => entry.phrase_id === "phrase_drop")!;
    const frame = buildFb4Dmx16Frame({
      show,
      phrase,
      lightingCue: null,
      laserCue,
      allowExperimental39Channel: true,
      phraseProgress: 0
    });
    const hit = applyLaserLook(frame, context({ phraseKind: "drop", beatsIntoPhrase: 0.5 }));
    expect(hit.profile).toBe("pangolin-fb4-dmx39");
    expect(hit.channels[16]).toBe(255);
    expect(hit.channels[19]).toBe(255);
    expect(hit.channels[20]).toBe(255);
    expect(hit.channels[21]).toBe(255);
    expect(hit.channels[22]).toBe(255);

    const build = applyLaserLook(
      buildFb4Dmx16Frame({
        show,
        phrase: show.phrases.find((entry) => entry.phrase_id === "phrase_build")!,
        lightingCue: null,
        laserCue: { ...laserCue, phrase_id: "phrase_build" },
        allowExperimental39Channel: true,
        phraseProgress: 0.5
      }),
      context({ phraseKind: "build", beatsIntoPhrase: 16, beatPhase: 0.5, beatInBar: 1 })
    );
    expect(build.channels[16]).toBeGreaterThan(0);
    expect(build.channels[19]).toBe(204);
    expect(build.channels[21]).toBe(204);

    const breakdown = applyLaserLook(
      buildFb4Dmx16Frame({
        show,
        phrase: show.phrases.find((entry) => entry.phrase_id === "phrase_breakdown")!,
        lightingCue: null,
        laserCue: { ...laserCue, phrase_id: "phrase_breakdown" },
        allowExperimental39Channel: true,
        phraseProgress: 0.5
      }),
      context({ phraseKind: "breakdown", beatsIntoPhrase: 16 })
    );
    expect(breakdown.channels[23]).toBe(64);
    expect(breakdown.channels[24]).toBe(64);
  });

  it("shifts beat-timed events earlier by the latency compensation", () => {
    // At 120 BPM one beat is 500 ms, so 30 ms is 0.06 beats: a downbeat due at
    // beat 10 is evaluated - and sent - when the transport reads 9.97.
    expect(latencyShiftedBeats(9.97, 30, 120)).toBeCloseTo(10.03, 5);
    expect(latencyShiftedBeats(10, 0, 120)).toBe(10);
  });
});
