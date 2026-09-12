import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hydrateShowPackage, parseShowPackage } from "../show/loader.js";
import { coerceShowPackage } from "../show/hydrate.js";
import { visualScenes } from "../graphics/visualScenes.js";

describe("parseShowPackage", () => {
  it("loads the Python compiler example show contract", async () => {
    // A committed fixture, not a build artifact: this used to read
    // `build/example-show.json`, so it only passed on a machine where the
    // Python compiler had already been run. `tests/test_show_package.py`
    // asserts the fixture still matches the compiler's output.
    const raw = await readFile(resolve(import.meta.dirname, "../../fixtures/example-show.json"), "utf8");
    const show = parseShowPackage(raw);

    expect(show.version).toBe("0.1.0");
    expect(show.phrases.length).toBeGreaterThan(0);
    expect(show.phrases[0].visual_look.palette).toBeTruthy();
    expect(show.preset_catalog.length).toBeGreaterThan(0);
    expect(show.phrase_visual_assignments.length).toBeGreaterThan(0);
    expect(show.phrase_visual_assignments[0].preset_id).toBeTruthy();
  });

  it("backfills empty preset fields for legacy shows", () => {
    const raw = JSON.stringify({
      version: "0.1.0",
      song: {
        song_id: "legacy",
        title: "Legacy",
        artist: null,
        tempo: 124,
        time_signature: "4/4"
      },
      phrases: [],
      lighting_cues: [],
      dmx_laser_cues: [],
      manual_overrides: []
    });

    const show = parseShowPackage(raw);
    expect(show.preset_catalog).toEqual([]);
    expect(show.phrase_visual_assignments).toEqual([]);
  });

  it("hydrates legacy shows with authored presets and phrase assignments", () => {
    const raw = JSON.stringify({
      version: "0.1.0",
      song: {
        song_id: "legacy",
        title: "Legacy",
        artist: null,
        tempo: 124,
        time_signature: "4/4"
      },
      phrases: [
        {
          phrase_id: "phrase_intro",
          name: "Intro",
          range: {
            start_bar_beat: "1|1",
            end_bar_beat: "9|1",
            start_locator_id: null,
            end_locator_id: null
          },
          locators: [],
          track_features: [],
          energy: {
            level: "low",
            dynamics: 0.2,
            tension: 0.1
          },
          visual_look: {
            palette: "smoke-cool",
            motion_style: "slow_drift",
            composition: "sparse",
            notes: []
          },
          transition_in: null,
          transition_out: null
        }
      ],
      lighting_cues: [],
      dmx_laser_cues: [],
      manual_overrides: []
    });

    const show = hydrateShowPackage(parseShowPackage(raw));
    expect(show.preset_catalog.length).toBe(visualScenes.length);
    expect(show.phrase_visual_assignments).toHaveLength(1);
    expect(show.phrase_visual_assignments[0].phrase_id).toBe("phrase_intro");
    expect(show.phrase_visual_assignments[0].preset_id).toBeTruthy();
  });

  it("coerces raw legacy payloads into hydrated show packages", () => {
    const show = coerceShowPackage({
      version: "0.1.0",
      song: {
        song_id: "legacy",
        title: "Legacy",
        artist: null,
        tempo: 124,
        time_signature: "4/4"
      },
      phrases: [
        {
          phrase_id: "phrase_intro",
          name: "Intro",
          range: {
            start_bar_beat: "1|1",
            end_bar_beat: "9|1",
            start_locator_id: null,
            end_locator_id: null
          },
          locators: [],
          track_features: [],
          energy: {
            level: "low",
            dynamics: 0.2,
            tension: 0.1
          },
          visual_look: {
            palette: "smoke-cool",
            motion_style: "slow_drift",
            composition: "sparse",
            notes: []
          },
          transition_in: null,
          transition_out: null
        }
      ],
      lighting_cues: [],
      dmx_laser_cues: [],
      manual_overrides: []
    });

    expect(show.preset_catalog.length).toBe(visualScenes.length);
    expect(show.phrase_visual_assignments).toHaveLength(1);
  });
});
