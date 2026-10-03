import { describe, expect, it } from "vitest";

import { buildArtDmxPacket } from "../dmx/artnet.js";
import {
  buildFb4LegacyCueFrame,
  buildFb4BrightnessOverlayFrame,
  buildFb4ColorModeFrame,
  buildFb4ColorScrollFrame,
  buildFb4CueControlFrame,
  buildFb4CueFrame,
  buildFb4Dmx16Frame,
  buildFb4ZoneFrame,
  cueIndexValue,
  fb4CueRequires39Channel,
  intensityToDimmer,
  pageIndexValue,
  resolveFb4LegacyCueTarget,
  selectVariedFb4Palette
} from "../dmx/fb4Dmx16.js";
import { applyCatalogOverride, describeFb4Cue, fb4CueCatalog } from "../dmx/fb4CueCatalog.js";
import type { ShowPackage } from "../show/types.js";

const show: ShowPackage = {
  version: "0.1.0",
  song: { song_id: "song", title: "Song", artist: null, tempo: 122, time_signature: "4/4" },
  phrases: [
    {
      phrase_id: "phrase_intro",
      name: "Intro",
      range: { start_bar_beat: "1|1", end_bar_beat: "9|1", start_locator_id: null, end_locator_id: null },
      locators: [],
      track_features: [],
      energy: { level: "low", dynamics: 0.2, tension: 0.1 },
      visual_look: { palette: "smoke-cool", motion_style: "slow_drift", composition: "sparse", notes: [] },
      transition_in: null,
      transition_out: null
    },
    {
      phrase_id: "phrase_drop",
      name: "Drop",
      range: { start_bar_beat: "9|1", end_bar_beat: "17|1", start_locator_id: null, end_locator_id: null },
      locators: [],
      track_features: [],
      energy: { level: "peak", dynamics: 1, tension: 0.3 },
      visual_look: { palette: "acid-contrast", motion_style: "beat_locked_cuts", composition: "dense", notes: [] },
      transition_in: null,
      transition_out: null
    }
  ],
  preset_catalog: [],
  phrase_visual_assignments: [],
  lighting_cues: [
    {
      cue_id: "lx_drop",
      phrase_id: "phrase_drop",
      fixture_group: "laser_main",
      look: { palette: "white-acid", intensity: 0.9, movement: "beat_chase", strobe: true },
      priority: 20
    }
  ],
  dmx_laser_cues: [],
  manual_overrides: []
};

describe("FB4 DMX16 mapping", () => {
  it("maps phrase state into the Pangolin FB4 16-channel profile", () => {
    const target = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5
    });
    const frame = buildFb4Dmx16Frame({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5
    });

    expect(frame.channels).toHaveLength(16);
    expect(frame.channels[0]).toBe(240);
    expect([3, 4, 5, 7, 8, 9]).toContain(frame.page);
    expect(frame.page).toBe(target.page);
    expect(frame.cue).toBe(target.cue);
    expect(frame.channels[1]).toBe(pageIndexValue(frame.page));
    expect(frame.channels[2]).toBe(cueIndexValue(frame.cue));
    expect(frame.channels[3]).toBe(122);
    expect(frame.channels[4]).toBe(intensityToDimmer(0.9));
    expect(frame.channels[6]).toBeGreaterThanOrEqual(168);
    expect(frame.cueShape).not.toBeNull();
    expect(frame.colorLabel).toBe("Yellow-Lime");
    expect(frame.graphicsColor).toBe("#d9ff00");
    expect(frame.channels[14]).toBe(84);
  });

  it("keeps low-energy show frames larger, dimmer, and intentionally color matched", () => {
    const frame = buildFb4Dmx16Frame({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0
    });

    expect(frame.channels[4]).toBeGreaterThanOrEqual(100);
    expect(frame.channels[6]).toBeGreaterThan(160);
    expect(frame.channels[7]).toBeGreaterThan(160);
    expect(frame.colorLabel).toBe("Cyan");
    expect(frame.graphicsColor).toBe("#7dd3fc");
    expect(frame.channels[14]).toBe(118);
  });

  it("honors a palette override for live color variation", () => {
    const frame = buildFb4Dmx16Frame({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      paletteOverride: "warm-cinematic"
    });

    expect(frame.palette).toBe("warm-cinematic");
    expect(frame.colorLabel).toBe("Orange");
    expect(frame.channels[14]).toBe(54);
  });

  it("keeps full visible-point coverage on show frames unless geometry override is enabled", () => {
    const frame = buildFb4Dmx16Frame({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0
    });

    expect(frame.profile).toBe("pangolin-fb4-dmx16");
    expect(frame.channels[11]).toBe(255);
  });

  it("uses the full 16-channel legacy bank for deterministic fallback selection", () => {
    const phraseVariants = [
      phraseVariant("intro", "Intro", "low", "sparse", "slow_drift"),
      phraseVariant("groove", "Groove", "mid", "open", "steady_orbit"),
      phraseVariant("lift", "Lift", "high", "medium", "ramp_sweep"),
      phraseVariant("drop", "Drop", "peak", "dense", "beat_locked_cuts")
    ];
    const spreadShow: ShowPackage = {
      ...show,
      song: { ...show.song, song_id: "spread-song" },
      phrases: Array.from({ length: 24 }, (_, index) => phraseVariants[index % phraseVariants.length](index)),
      lighting_cues: [],
      dmx_laser_cues: []
    };

    const targets = spreadShow.phrases.map((phrase) => resolveFb4LegacyCueTarget({
      show: spreadShow,
      phrase,
      lightingCue: null,
      phraseProgress: 0
    }));

    expect(targets.every((target) => target.page >= 1 && target.page <= 9)).toBe(true);
    expect(targets.every((target) => target.cue >= 1 && target.cue <= 48)).toBe(true);
    expect(new Set(targets.map((target) => target.page)).size).toBeGreaterThan(3);
    expect(targets.some((target) => target.page > 1)).toBe(true);
  });

  it("keeps deterministic saved-show fallback stable for the same phrase", () => {
    const first = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5
    });
    const second = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5
    });

    expect(second).toEqual(first);
  });

  it("constrains low-energy fallback cues away from the dense point-heavy banks", () => {
    const target = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0
    });

    expect([1, 2, 6]).toContain(target.page);
  });

  it("picks only among reachable favourites once a pool has enough of them", () => {
    const target = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      favouriteCues: { open: ["1:5", "1:9", "2:3", "6:12", "10:1"] }
    });

    expect([[1, 5], [1, 9], [2, 3], [6, 12]]).toContainEqual([target.page, target.cue]);
  });

  it("falls back to the default pool when a pool has fewer than four reachable favourites", () => {
    const input = {
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0
    };
    const withoutFavourites = resolveFb4LegacyCueTarget(input);
    const withTooFew = resolveFb4LegacyCueTarget({
      ...input,
      // "10:1" needs 39-channel addressing, so only three favourites are usable.
      favouriteCues: { open: ["1:5", "1:9", "2:3", "10:1"] }
    });

    expect(withTooFew).toEqual(withoutFavourites);
  });

  it("ignores favourites the 16-channel fallback cannot address", () => {
    const target = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      // P10 and cue 49 have no 16-channel address; the remaining four still qualify.
      favouriteCues: { open: ["10:1", "9:49", "1:5", "1:9", "2:3", "6:12"] }
    });

    expect([[1, 5], [1, 9], [2, 3], [6, 12]]).toContainEqual([target.page, target.cue]);
  });

  it("keeps variety rotation working within the favourited pool", () => {
    const input = {
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      favouriteCues: { open: ["1:5", "1:9", "2:3", "6:12"] }
    };
    const first = resolveFb4LegacyCueTarget({ ...input, cueSelection: { mode: "variety", rotationOrdinal: 0 } });
    const second = resolveFb4LegacyCueTarget({ ...input, cueSelection: { mode: "variety", rotationOrdinal: 1 } });

    expect([[1, 5], [1, 9], [2, 3], [6, 12]]).toContainEqual([first.page, first.cue]);
    expect([[1, 5], [1, 9], [2, 3], [6, 12]]).toContainEqual([second.page, second.cue]);
    expect(second).not.toEqual(first);
  });

  it("rotates live-style fallback cues across compatible full-bank targets", () => {
    const first = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5,
      cueSelection: { mode: "variety", rotationOrdinal: 0 }
    });
    const second = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      phraseProgress: 0.5,
      cueSelection: { mode: "variety", rotationOrdinal: 1 }
    });

    expect([3, 4, 5, 7, 8, 9]).toContain(first.page);
    expect([3, 4, 5, 7, 8, 9]).toContain(second.page);
    expect(second.page).not.toBe(first.page);
    expect(second).not.toEqual(first);
  });

  it("rotates open live-style fallback across pages before walking nearby cues", () => {
    const first = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      cueSelection: { mode: "variety", rotationOrdinal: 0 }
    });
    const second = resolveFb4LegacyCueTarget({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      cueSelection: { mode: "variety", rotationOrdinal: 1 }
    });

    expect([1, 2, 6]).toContain(first.page);
    expect([1, 2, 6]).toContain(second.page);
    expect(second.page).not.toBe(first.page);
  });

  it("varies live palettes often but not on every fresh phrase event", () => {
    const paletteIds = ["smoke-cool", "acid-contrast", "warm-cinematic", "nocturne-glow", "desaturated_decay"];
    const seen: string[] = [];
    let current: string | null = null;

    for (const eventKey of ["mic_drop_1", "mic_drop_2", "mic_drop_3", "mic_drop_4", "mic_drop_5", "mic_drop_6"]) {
      current = selectVariedFb4Palette({ eventKey, currentPalette: current, paletteIds });
      seen.push(current);
    }

    expect(new Set(seen).size).toBeGreaterThan(2);
    expect(seen.some((palette, index) => index > 0 && palette === seen[index - 1])).toBe(true);
    expect(seen.some((palette, index) => index > 0 && palette !== seen[index - 1])).toBe(true);
  });

  it("keeps sub-100 dimmer values reserved for near-black fade levels", () => {
    expect(intensityToDimmer(0)).toBe(0);
    expect(intensityToDimmer(0.05)).toBeLessThan(100);
    expect(intensityToDimmer(0.12)).toBeGreaterThanOrEqual(100);
    expect(intensityToDimmer(0.9)).toBeGreaterThan(230);
  });

  it("builds operator cue and overlay frames for fixture checks", () => {
    const blackout = buildFb4CueControlFrame("blackout", 122);
    const cue = buildFb4CueFrame(8, 122);
    const dimmer = buildFb4BrightnessOverlayFrame(64, 122);

    expect(blackout.channels.every((value) => value === 0)).toBe(true);
    expect(cue.profile).toBe("pangolin-fb4-dmx39");
    expect(cue.channels[0]).toBe(251);
    expect(cue.channels[13]).toBe(1);
    expect(cue.channels[14]).toBe(8);
    expect(dimmer.profile).toBe("pangolin-fb4-dmx39");
    expect(dimmer.channels[16]).toBe(64);
  });

  it("uses the FB4 39-channel profile when a show phrase explicitly targets a catalog cue", () => {
    const explicitCue = {
      cue_id: "laser_drop",
      phrase_id: "phrase_drop",
      fixture_group: "laser_main",
      mode: "content_pack",
      parameter_overrides: {
        page: 2,
        cue: 221
      }
    };
    const frame = buildFb4Dmx16Frame({
      show: { ...show, dmx_laser_cues: [explicitCue] },
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      laserCue: explicitCue,
      phraseProgress: 0.5
    });

    expect(frame.profile).toBe("pangolin-fb4-dmx39");
    expect(frame.channels).toHaveLength(39);
    expect(frame.page).toBe(2);
    expect(frame.cue).toBe(221);
    expect(frame.channels[0]).toBe(251);
    expect(frame.channels[13]).toBe(2);
    expect(frame.channels[14]).toBe(221);
    expect(frame.cueShape).toBe("textured circle");
  });

  it("stays on the legacy 16-channel fallback when experimental 39-channel targeting is disabled", () => {
    const explicitCue = {
      cue_id: "laser_drop",
      phrase_id: "phrase_drop",
      fixture_group: "laser_main",
      mode: "content_pack",
      parameter_overrides: {
        page: 2,
        cue: 221
      }
    };
    const fallbackTarget = resolveFb4LegacyCueTarget({
      show: { ...show, dmx_laser_cues: [explicitCue] },
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      laserCue: explicitCue,
      allowExperimental39Channel: false,
      phraseProgress: 0.5
    });
    const frame = buildFb4Dmx16Frame({
      show: { ...show, dmx_laser_cues: [explicitCue] },
      phrase: show.phrases[1],
      lightingCue: show.lighting_cues[0],
      laserCue: explicitCue,
      allowExperimental39Channel: false,
      phraseProgress: 0.5
    });

    expect(frame.profile).toBe("pangolin-fb4-dmx16");
    expect(frame.channels).toHaveLength(16);
    expect(frame.page).toBe(fallbackTarget.page);
    expect(frame.cue).toBe(fallbackTarget.cue);
    expect(frame.channels[1]).toBe(pageIndexValue(frame.page));
    expect(frame.channels[2]).toBe(cueIndexValue(frame.cue));
  });

  it("builds manual cue frames for the full catalog, not just the old 48-cue bank", () => {
    const frame = buildFb4CueFrame(221, 122, 2);

    expect(frame.profile).toBe("pangolin-fb4-dmx39");
    expect(frame.channels).toHaveLength(39);
    expect(frame.channels[0]).toBe(251);
    expect(frame.channels[13]).toBe(2);
    expect(frame.channels[14]).toBe(221);
    expect(frame.page).toBe(2);
    expect(frame.cue).toBe(221);
    expect(frame.cueShape).toBe("textured circle");
  });

  it("can still build legacy page and cue frames within the 16-channel FB4 limits", () => {
    const frame = buildFb4LegacyCueFrame(48, 122, 9);

    expect(frame.profile).toBe("pangolin-fb4-dmx16");
    expect(frame.channels).toHaveLength(16);
    expect(frame.page).toBe(9);
    expect(frame.cue).toBe(48);
    expect(frame.channels[1]).toBe(129);
    expect(frame.channels[2]).toBe(cueIndexValue(48));
  });

  it("flags cues outside the FB4 16-channel bank as requiring 39-channel targeting", () => {
    expect(fb4CueRequires39Channel(1, 1)).toBe(false);
    expect(fb4CueRequires39Channel(9, 48)).toBe(false);
    expect(fb4CueRequires39Channel(1, 49)).toBe(true);
    expect(fb4CueRequires39Channel(10, 1)).toBe(true);
  });

  it("changes FB4 color mode without changing cue shape, size, or position", () => {
    const base = buildFb4CueFrame(4, 122);
    const original = buildFb4ColorModeFrame(base, "original");
    const white = buildFb4ColorModeFrame(base, "white");
    const cyan = buildFb4ColorScrollFrame(base, 118, "Cyan");
    const repeatedWhite = buildFb4ColorModeFrame(white, "white");

    expect(original.channels[14]).toBe(base.channels[14]);
    expect(original.channels[19]).toBe(base.channels[19]);
    expect(original.channels[20]).toBe(base.channels[20]);
    expect(original.channels[35]).toBe(0);
    expect(white.channels[14]).toBe(base.channels[14]);
    expect(white.channels[19]).toBe(base.channels[19]);
    expect(white.channels[20]).toBe(base.channels[20]);
    expect(white.channels[32]).toBe(255);
    expect(white.channels[35]).toBe(255);
    expect(cyan.channels[14]).toBe(base.channels[14]);
    expect(cyan.channels[19]).toBe(base.channels[19]);
    expect(cyan.channels[20]).toBe(base.channels[20]);
    expect(cyan.colorValue).toBe(118);
    expect(cyan.colorLabel).toBe("Cyan");
    expect(repeatedWhite.label).toBe("P1 C4 / White");
  });

  it("catalogs observed FB4 page-one cue shapes", () => {
    expect(fb4CueCatalog).toHaveLength(1500);
    expect(fb4CueCatalog.filter((entry) => entry.page === 1)).toHaveLength(240);
    expect(fb4CueCatalog.filter((entry) => entry.page === 2)).toHaveLength(240);
    expect(fb4CueCatalog.filter((entry) => entry.page === 3)).toHaveLength(240);
    expect(fb4CueCatalog.filter((entry) => entry.page === 4)).toHaveLength(240);
    expect(fb4CueCatalog.filter((entry) => entry.page === 5)).toHaveLength(100);
    expect(fb4CueCatalog.filter((entry) => entry.page === 6)).toHaveLength(100);
    expect(fb4CueCatalog.filter((entry) => entry.page === 7)).toHaveLength(100);
    expect(fb4CueCatalog.filter((entry) => entry.page === 8)).toHaveLength(100);
    expect(fb4CueCatalog.filter((entry) => entry.page === 9)).toHaveLength(100);
    expect(fb4CueCatalog.filter((entry) => entry.page === 10)).toHaveLength(40);
    expect(describeFb4Cue(1, 1)?.observedShape).toBe("circle");
    expect(describeFb4Cue(1, 2)?.observedShape).toBe("horizontal line");
    expect(describeFb4Cue(1, 3)?.observedShape).toBe("upside-down triangle");
    expect(describeFb4Cue(1, 4)?.observedShape).toBe("square");
    expect(describeFb4Cue(1, 21)?.name).toBe("Red Circle with White NESW");
    expect(describeFb4Cue(1, 25)?.thumbnailPath).toBe("/fb4-thumbnails/p1-c25.png");
    expect(describeFb4Cue(1, 221)?.thumbnailPath).toBe("/fb4-thumbnails/p1-c221.svg");
    expect(describeFb4Cue(1, 221)?.source).toBe("placeholder-generated");
    expect(describeFb4Cue(2, 221)?.thumbnailPath).toBe("/fb4-thumbnails/p2-c221.png");
    expect(describeFb4Cue(2, 221)?.source).toBe("packet-generated");
    expect(describeFb4Cue(5, 14)?.category).toBe("Sheets");
    expect(describeFb4Cue(1, 41)?.name).toBe("Circle / Orange");
    expect(describeFb4Cue(10, 40)?.thumbnailPath).toBe("/fb4-thumbnails/p10-c40.png");
    expect(describeFb4Cue(10, 41)).toBeNull();
  });

  it("treats local cue metadata as description-only and preserves generated cue names", () => {
    const entry = describeFb4Cue(1, 41);
    expect(entry).not.toBeNull();
    const applied = applyCatalogOverride(entry!, { name: "Legacy handwritten note", description: "" });
    expect(applied.name).toBe(entry!.name);
    expect(applied.description).toBe("Legacy handwritten note");
    expect(applied.source).toBe("local-override");
  });

  it("builds a full-zone square frame for projector zone tuning", () => {
    const frame = buildFb4ZoneFrame(122);

    expect(frame.label).toBe("Zone frame / Square");
    expect(frame.cue).toBe(4);
    expect(frame.cueShape).toBe("square");
    expect(frame.channels[2]).toBe(cueIndexValue(4));
    expect(frame.channels[6]).toBe(255);
    expect(frame.channels[7]).toBe(255);
    expect(frame.channels[9]).toBe(128);
    expect(frame.channels[10]).toBe(128);
    expect(frame.channels[11]).toBe(255);
    expect(frame.channels[14]).toBe(240);
  });

  it("builds a valid ArtDmx packet around a 512-channel universe", () => {
    const packet = buildArtDmxPacket(0, [240, 0, 34]);
    expect(packet.subarray(0, 8).toString("ascii")).toBe("Art-Net\0");
    expect(packet[8]).toBe(0x00);
    expect(packet[9]).toBe(0x50);
    expect(packet.length).toBe(530);
    expect(packet[18]).toBe(240);
  });
});

// Channel semantics pinned against Pangolin's official FB4 profiles:
// 16-channel: https://wiki.pangolin.com/doku.php?id=hardware:fb4:dmx16
// 39-channel: https://wiki.pangolin.com/doku.php?id=hardware:fb4:dmx39
describe("FB4 spec conformance (Pangolin wiki)", () => {
  it("streams uncapped full-area setup neutrals on the 39-channel profile", () => {
    const frame = buildFb4CueFrame(8, 122);

    // ch2 Max Intensity ranges 0-100: 0 caps playback to dark.
    expect(frame.channels[1]).toBe(255);
    // ch4-7 Setup Size X/Y range -100..100% with 0 = 32768; 65535 = full area.
    expect(frame.channels[3]).toBe(255);
    expect(frame.channels[4]).toBe(255);
    expect(frame.channels[5]).toBe(255);
    expect(frame.channels[6]).toBe(255);
    // ch8-11 Setup Position X/Y: 32768 is center.
    expect(frame.channels[7]).toBe(128);
    expect(frame.channels[8]).toBe(0);
    expect(frame.channels[9]).toBe(128);
    expect(frame.channels[10]).toBe(0);
    // ch12-13 Setup Rotation Z: 0 degrees.
    expect(frame.channels[11]).toBe(0);
    expect(frame.channels[12]).toBe(0);
  });

  it("keeps 39-channel points, rotation, alpha, and strobe at their no-op values", () => {
    const frame = buildFb4CueFrame(8, 122);

    // ch26/27 Z Rotation: 0 = original cue rotation.
    expect(frame.channels[25]).toBe(0);
    expect(frame.channels[26]).toBe(0);
    // ch37/38 Points Start/End remove points; 0 = 100% visibility.
    expect(frame.channels[36]).toBe(0);
    expect(frame.channels[37]).toBe(0);
    // ch39 Strobe: 0 = disabled.
    expect(frame.channels[38]).toBe(0);
  });

  it("keeps 16-channel show frames at 100% visible points, 30K scan, and loop release", () => {
    const frame = buildFb4Dmx16Frame({
      show,
      phrase: show.phrases[0],
      lightingCue: null,
      phraseProgress: 0,
      paletteOverride: "white"
    });

    // ch12 Visible points: 0 = zero points, 255 = 100% visible.
    expect(frame.channels[11]).toBe(255);
    // ch13 Scan rate: 225-255 = 30K.
    expect(frame.channels[12]).toBe(240);
    // ch14 Cue release: 97-159 = loop.
    expect(frame.channels[13]).toBe(128);
    // ch15 Color scroll: 225-255 = white.
    expect(frame.channels[14]).toBe(240);
  });
});

function phraseVariant(
  slug: string,
  name: string,
  level: "low" | "mid" | "high" | "peak",
  composition: string,
  motionStyle: string
): (index: number) => ShowPackage["phrases"][number] {
  return (index) => ({
    phrase_id: `${slug}_${index}`,
    name: `${name} ${index + 1}`,
    range: { start_bar_beat: `${index * 8 + 1}|1`, end_bar_beat: `${index * 8 + 9}|1`, start_locator_id: null, end_locator_id: null },
    locators: [],
    track_features: [],
    energy: {
      level,
      dynamics: level === "low" ? 0.22 : level === "mid" ? 0.52 : level === "high" ? 0.74 : 0.96,
      tension: level === "peak" ? 0.62 : level === "high" ? 0.48 : 0.22
    },
    visual_look: {
      palette: level === "low" ? "smoke-cool" : level === "mid" ? "nocturne-glow" : level === "high" ? "warm-cinematic" : "acid-contrast",
      motion_style: motionStyle,
      composition,
      notes: []
    },
    transition_in: null,
    transition_out: null
  });
}
