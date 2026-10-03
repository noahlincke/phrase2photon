import { describe, expect, it } from "vitest";

import { applyLaserLook, latencyShiftedBeats, type LaserLookContext } from "../dmx/laserLooks.js";
import { buildFb4Dmx16Frame, type Fb4Dmx16Frame } from "../dmx/fb4Dmx16.js";
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

/** The same phrase forced onto the 39-channel profile through an out-of-range cue. */
function baseFrameWith39(kind: PhraseKind, phraseProgress = 0): Fb4Dmx16Frame {
  const phrase = show.phrases.find((entry) => entry.phrase_id === `phrase_${kind}`)!;
  return buildFb4Dmx16Frame({
    show,
    phrase,
    lightingCue: null,
    laserCue: {
      cue_id: `cue_${kind}`,
      phrase_id: phrase.phrase_id,
      fixture_group: "laser_main",
      mode: "cue",
      parameter_overrides: { page: 1, cue: 60 }
    },
    allowExperimental39Channel: true,
    phraseProgress
  });
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
    phraseOrdinal: 0,
    dimmerFades: false,
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
    expect(late.channels[4]).toBe(255);
  });

  it("ramps build size up and chops the dimmer faster toward the drop", () => {
    const start = looked("build", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1 });
    expect(start.channels[6]).toBe(153);
    expect(start.channels[4]).toBe(255);

    const middle = looked("build", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(middle.channels[6]).toBe(204);

    // First half: quarter-note chops, full or off, on half of each beat.
    const quarterOn = looked("build", { beatsIntoPhrase: 2.25, beatPhase: 0.25, beatInBar: 3 });
    expect(quarterOn.channels[4]).toBe(255);
    const quarterOff = looked("build", { beatsIntoPhrase: 2.5, beatPhase: 0.5, beatInBar: 3 });
    expect(quarterOff.channels[4]).toBe(0);

    // Last two bars: sixteenth-note chops, so the on/off boundary moves from
    // the beat midpoint to the sixteenth midpoint.
    const sixteenthOn = looked("build", { beatsIntoPhrase: 24.5, beatPhase: 0.5, beatInBar: 3 });
    expect(sixteenthOn.channels[4]).toBe(255);
    const sixteenthOff = looked("build", { beatsIntoPhrase: 24.625, beatPhase: 0.625, beatInBar: 3 });
    expect(sixteenthOff.channels[4]).toBe(0);

    // The last two bars go white.
    const white = looked("build", { beatsIntoPhrase: 25, beatPhase: 0, beatInBar: 2 });
    expect(white.channels[14]).toBe(240);
    expect(white.colorLabel).toBe("White");
    const early = looked("build", { beatsIntoPhrase: 10, beatPhase: 0, beatInBar: 3 });
    expect(early.channels[14]).toBe(84);
  });

  it("ramps the last eight bars of a breakdown that leads into a drop", () => {
    // A 16-bar breakdown: the ramp covers beats 32-64 only. Outside the ramp
    // the breakdown sits at its own shrunk size.
    const early = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(early.channels[6]).toBe(137);
    const justBefore = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 31.5, beatPhase: 0.5, beatInBar: 4 });
    expect(justBefore.channels[6]).toBe(137);

    const rampStart = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 32, beatPhase: 0, beatInBar: 1 });
    expect(rampStart.channels[6]).toBe(153);
    const mid = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 40, beatPhase: 0, beatInBar: 1 });
    expect(mid.channels[6]).toBe(179);
    const late = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 56, beatPhase: 0, beatInBar: 1 });
    expect(late.channels[6]).toBe(230);

    // Last two bars of the ramp: sixteenth chops, on at the grid, off mid-grid.
    const sixteenthOn = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 56.5, beatPhase: 0.5, beatInBar: 1 });
    expect(sixteenthOn.channels[4]).toBe(255);
    const sixteenthOff = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 56.625, beatPhase: 0.625, beatInBar: 1 });
    expect(sixteenthOff.channels[4]).toBe(0);
    const white = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 57, beatPhase: 0, beatInBar: 2 });
    expect(white.channels[14]).toBe(240);
    expect(white.colorLabel).toBe("White");
    const beforeWhite = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 48, beatPhase: 0, beatInBar: 1 });
    expect(beforeWhite.channels[14]).toBe(84);

    // The last beat before the drop still goes dark.
    const finalBeat = looked("breakdown", { nextPhraseKind: "drop", beatsInPhrase: 64, beatsIntoPhrase: 63.5, beatPhase: 0.5, beatInBar: 4 });
    expect(finalBeat.channels[4]).toBe(0);
  });

  it("leaves a breakdown that leads into a groove un-ramped", () => {
    const insideWindow = looked("breakdown", { nextPhraseKind: "groove", beatsInPhrase: 64, beatsIntoPhrase: 56, beatPhase: 0, beatInBar: 1 });
    expect(insideWindow.channels[6]).toBe(137);
    expect(insideWindow.channels[14]).toBe(84);
  });

  it("pulses size on bar downbeats in groove and every beat in drop", () => {
    // Groove dynamics 0.54 sizes the phrase frame at 207.
    const baseSize = Math.round(150 + 0.54 * 105);
    const downbeat = looked("groove", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1 });
    expect(downbeat.channels[4]).toBe(255);
    expect(downbeat.channels[6]).toBe(255);
    const decayed = looked("groove", { beatsIntoPhrase: 0.9, beatPhase: 0.9, beatInBar: 1 });
    expect(decayed.channels[4]).toBe(255);
    expect(decayed.channels[6]).toBe(Math.round(baseSize + (255 - baseSize) * 0.1));
    const offBeat = looked("groove", { beatsIntoPhrase: 1, beatPhase: 0, beatInBar: 2 });
    expect(offBeat.channels[6]).toBe(baseSize);

    // Drop accents every beat; its phrase size is already full.
    const dropBeat = looked("drop", { beatsIntoPhrase: 5, beatPhase: 0.5, beatInBar: 2 });
    expect(dropBeat.channels[4]).toBe(255);
    expect(dropBeat.channels[6]).toBe(255);
  });

  it("keeps breakdown full, halves the angle ramp and sits smaller", () => {
    const breakdown = looked("breakdown", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(breakdown.channels[4]).toBe(255);
    expect(breakdown.channels[8]).toBe(64);
    // Phrase size 182, shrunk to three quarters.
    expect(breakdown.channels[6]).toBe(137);

    const groove = looked("groove", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 }, 0.5);
    expect(groove.channels[8]).toBe(128);
    // The bar downbeat accent bumps size straight to full.
    expect(groove.channels[6]).toBe(255);
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
    expect(hit.channels[20]).toBe(0);
    expect(hit.channels[21]).toBe(255);
    expect(hit.channels[22]).toBe(0);

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
    expect(breakdown.channels[24]).toBe(0);
  });

  it("shifts beat-timed events earlier by the latency compensation", () => {
    // At 120 BPM one beat is 500 ms, so 30 ms is 0.06 beats: a downbeat due at
    // beat 10 is evaluated - and sent - when the transport reads 9.97.
    expect(latencyShiftedBeats(9.97, 30, 120)).toBeCloseTo(10.03, 5);
    expect(latencyShiftedBeats(10, 0, 120)).toBe(10);
  });
});

describe("mid-phrase entry", () => {
  it("hits solid when the drop is entered a fraction of a beat in", () => {
    const hit = looked("drop", { beatsIntoPhrase: 0.2, beatPhase: 0.2, beatInBar: 1 });
    expect(hit.channels[4]).toBe(255);
    expect(hit.channels[6]).toBe(255);
  });

  it("chops, not solid, when the drop is entered past the first beat", () => {
    // Still inside the burst bar, so entry at 1.5 lands on the sixteenth chop
    // grid instead of the solid downbeat: on at 1.5, off at 1.75.
    const on = looked("drop", { beatsIntoPhrase: 1.5, beatPhase: 0.5, beatInBar: 1 });
    expect(on.channels[4]).toBe(255);
    const off = looked("drop", { beatsIntoPhrase: 1.75, beatPhase: 0.75, beatInBar: 1 });
    expect(off.channels[4]).toBe(0);
  });

  it("skips the hit entirely when the drop is entered past the burst bar", () => {
    const after = looked("drop", { beatsIntoPhrase: 5, beatPhase: 0, beatInBar: 2 });
    // No retroactive strobe: size stays at the phrase frame's own, not the hit's 255.
    expect(after.channels[6]).toBe(baseFrame("drop", 0).channels[6]);
  });

  it("resumes a build ramp at the entry position", () => {
    // Entered halfway through a 32-beat build: ramp progress 0.5.
    const build = looked("build", { beatsIntoPhrase: 16, beatPhase: 0, beatInBar: 1 });
    expect(build.channels[6]).toBe(204);

    // A breakdown's eight-bar pre-drop ramp resumes halfway too: 16 of 32 ramp beats.
    const breakdown = looked("breakdown", {
      nextPhraseKind: "drop",
      beatsInPhrase: 64,
      beatsIntoPhrase: 48,
      beatPhase: 0,
      beatInBar: 1
    });
    expect(breakdown.channels[6]).toBe(204);
  });

  it("dips dark when a show is entered just before its drop", () => {
    const dip = looked("build", {
      nextPhraseKind: "drop",
      beatsInPhrase: 32,
      beatsIntoPhrase: 31.5,
      beatPhase: 0.5,
      beatInBar: 4
    });
    expect(dip.channels[4]).toBe(0);
  });
});

describe("dimmer is always full or off", () => {
  const dimmerIndex = (frame: Fb4Dmx16Frame): number =>
    frame.profile === "pangolin-fb4-dmx39" ? 16 : 4;
  const sizeIndex = (frame: Fb4Dmx16Frame): number =>
    frame.profile === "pangolin-fb4-dmx39" ? 19 : 6;
  const nextKinds: (PhraseKind | null)[] = [null, "drop", "groove"];
  const beatPhases = [0, 0.25, 0.5, 0.75];
  const beatsInBar = [1, 3];

  /** Every look over every phrase kind and beat position keeps the switch. */
  it("keeps the dimmer at 0 or 255 across every look and context", () => {
    let frames = 0;
    for (const kind of KIND_ORDER) {
      for (const nextKind of nextKinds) {
        for (const dropHit of [null, 0.2, 1.25, 3.5]) {
          for (let beatsIntoPhrase = 0; beatsIntoPhrase <= 64; beatsIntoPhrase += 0.125) {
            const beatInBar = beatsInBar[Math.floor(beatsIntoPhrase) % 2];
            const beatPhase = beatPhases[Math.round((beatsIntoPhrase % 1) * 4)];
            for (const allow39 of [false, true]) {
              const base = baseFrame(kind, 0.5);
              const frame = applyLaserLook(base, context({
                phraseKind: kind,
                nextPhraseKind: nextKind,
                beatsIntoPhrase,
                beatInBar,
                beatPhase,
                dropHitBeats: dropHit
              }));
              const looked39 = allow39
                ? applyLaserLook(
                  baseFrameWith39(kind),
                  context({
                    phraseKind: kind,
                    nextPhraseKind: nextKind,
                    beatsIntoPhrase,
                    beatInBar,
                    beatPhase,
                    dropHitBeats: dropHit
                  })
                )
                : null;
              for (const candidate of looked39 ? [frame, looked39] : [frame]) {
                const value = candidate.channels[dimmerIndex(candidate)];
                if (value !== 0 && value !== 255) {
                  throw new Error(
                    `dimmer ${value} at kind=${kind} next=${nextKind} hit=${dropHit} beat=${beatsIntoPhrase} phase=${beatPhase} bar=${beatInBar} profile=${candidate.profile}`
                  );
                }
                const size = candidate.channels[sizeIndex(candidate)];
                if (size < 0 || size > 255) {
                  throw new Error(`size ${size} out of envelope at kind=${kind} beat=${beatsIntoPhrase}`);
                }
                frames += 1;
              }
            }
          }
        }
      }
    }
    expect(frames).toBeGreaterThan(10000);
  });

  /** Silence-sized phrases go dark; lit ones are full, sized by energy. */
  it("keeps the show frames themselves on the switch", () => {
    for (const kind of KIND_ORDER) {
      for (const allow39 of [false, true]) {
        for (const phraseProgress of [0, 0.25, 0.5, 0.75, 1]) {
          const frame = allow39 ? baseFrameWith39(kind, phraseProgress) : baseFrame(kind, phraseProgress);
          const value = frame.channels[dimmerIndex(frame)];
          expect([0, 255]).toContain(value);
          const size = frame.channels[sizeIndex(frame)];
          expect(size).toBeGreaterThanOrEqual(150);
          expect(size).toBeLessThanOrEqual(255);
        }
      }
    }
    // Silence: a lighting cue at zero intensity keeps the dimmer dark.
    const silentPhrase = {
      ...show.phrases[1],
      energy: { level: "low" as const, dynamics: 0, tension: 0 }
    };
    const silent = buildFb4Dmx16Frame({ show, phrase: silentPhrase, lightingCue: null, phraseProgress: 0 });
    expect(silent.channels[4]).toBe(0);
  });
});

describe("dimmer fades allowed", () => {
  const dimmerIndex = (frame: Fb4Dmx16Frame): number =>
    frame.profile === "pangolin-fb4-dmx39" ? 16 : 4;

  it("breathes the breakdown dimmer between the fade floor and full", () => {
    let lowest = 255;
    let highest = 0;
    for (let beatsIntoPhrase = 0; beatsIntoPhrase <= 64; beatsIntoPhrase += 0.125) {
      for (const nextKind of [null, "groove", "build"] as (PhraseKind | null)[]) {
        const frame = looked("breakdown", {
          nextPhraseKind: nextKind,
          beatsInPhrase: 64,
          beatsIntoPhrase,
          beatPhase: beatsIntoPhrase % 1,
          beatInBar: 1,
          dimmerFades: true
        });
        const value = frame.channels[4];
        if (value < lowest) lowest = value;
        if (value > highest) highest = value;
      }
    }
    // About 40% to 100%: the swell never dips to dark and never exceeds full.
    expect(lowest).toBeGreaterThanOrEqual(102);
    expect(lowest).toBeLessThanOrEqual(110);
    expect(highest).toBe(255);
  });

  it("fades the build in through its last two bars instead of chopping", () => {
    const start = looked("build", { beatsIntoPhrase: 24, beatPhase: 0, beatInBar: 1, dimmerFades: true });
    expect(start.channels[4]).toBe(102);
    const mid = looked("build", { beatsIntoPhrase: 28, beatPhase: 0, beatInBar: 1, dimmerFades: true });
    expect(mid.channels[4]).toBe(Math.round(102 + 153 * 0.5));
    const late = looked("build", { beatsIntoPhrase: 31.5, beatPhase: 0.5, beatInBar: 4, dimmerFades: true });
    expect(late.channels[4]).toBe(Math.round(102 + 153 * 0.9375));
    // The pre-drop dip still owns the final beat.
    expect(looked("build", { nextPhraseKind: "drop", beatsIntoPhrase: 31.875, beatPhase: 0.875, beatInBar: 4, dimmerFades: true }).channels[4]).toBe(0);
  });

  it("alternates accents per phrase between size pulses and brightness pulses", () => {
    const even = looked("groove", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1, dimmerFades: true });
    expect(even.channels[4]).toBe(255);
    expect(even.channels[6]).toBe(255);

    const oddPeak = looked("groove", { phraseOrdinal: 1, beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1, dimmerFades: true });
    expect(oddPeak.channels[4]).toBe(255);
    const oddDecayed = looked("groove", { phraseOrdinal: 1, beatsIntoPhrase: 0.9, beatPhase: 0.9, beatInBar: 1, dimmerFades: true });
    expect(oddDecayed.channels[4]).toBe(Math.round(102 + 153 * 0.1));
  });

  it("keeps the drop hit's dark beat and hard chop with fades allowed", () => {
    const solid = looked("drop", { beatsIntoPhrase: 0, beatPhase: 0, beatInBar: 1, dimmerFades: true });
    expect(solid.channels[4]).toBe(255);
    const off = looked("drop", { beatsIntoPhrase: 1.375, beatPhase: 0.375, beatInBar: 2, dimmerFades: true });
    expect(off.channels[4]).toBe(0);
  });

  it("keeps every faded dimmer at 0 or at least the fade floor across the grid", () => {
    for (const kind of KIND_ORDER) {
      for (const nextKind of [null, "drop", "groove"] as (PhraseKind | null)[]) {
        for (const dropHit of [null, 0.2, 1.25, 3.5]) {
          for (let beatsIntoPhrase = 0; beatsIntoPhrase <= 64; beatsIntoPhrase += 0.125) {
            const beatInBar = Math.floor(beatsIntoPhrase) % 2 === 0 ? 1 : 3;
            const beatPhase = Math.round((beatsIntoPhrase % 1) * 4) / 4;
            const frame = applyLaserLook(baseFrame(kind, 0.5), context({
              phraseKind: kind,
              nextPhraseKind: nextKind,
              beatsIntoPhrase,
              beatInBar,
              beatPhase,
              dropHitBeats: dropHit,
              dimmerFades: true
            }));
            const value = frame.channels[4];
            if (value !== 0 && value < 102) {
              throw new Error(
                `faded dimmer ${value} below the floor at kind=${kind} next=${nextKind} hit=${dropHit} beat=${beatsIntoPhrase}`
              );
            }
          }
        }
      }
    }
  });
});
