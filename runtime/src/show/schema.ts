import { z } from "zod";

export const TempoMapSegmentSchema = z.object({
  start_seconds: z.number().min(0),
  bpm: z.number().positive(),
  downbeat_seconds: z.number()
});

export const ShowPackageSchema = z.object({
  version: z.literal("0.1.0"),
  song: z.object({
    song_id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    tempo: z.number().positive(),
    time_signature: z.string(),
    tempo_map: z.array(TempoMapSegmentSchema).nullish()
  }),
  phrases: z.array(
    z.object({
      phrase_id: z.string(),
      name: z.string(),
      range: z.object({
        start_bar_beat: z.string(),
        end_bar_beat: z.string(),
        start_locator_id: z.string().nullable(),
        end_locator_id: z.string().nullable()
      }),
      locators: z.array(
        z.object({
          locator_id: z.string(),
          name: z.string(),
          bar_beat: z.string(),
          seconds: z.number().nullable()
        })
      ),
      track_features: z.array(
        z.object({
          track_id: z.string(),
          name: z.string(),
          role: z.string(),
          activity: z.number().min(0).max(1),
          density: z.number().min(0).max(1)
        })
      ),
      energy: z.object({
        level: z.enum(["low", "mid", "high", "peak"]),
        dynamics: z.number().min(0).max(1),
        tension: z.number().min(0).max(1)
      }),
      visual_look: z.object({
        palette: z.string(),
        motion_style: z.string(),
        composition: z.string(),
        notes: z.array(z.string())
      }),
      transition_in: z
        .object({
          type: z.enum(["cut", "fade", "strobe-hit", "hold", "ramp"]),
          duration_beats: z.number().min(0),
          notes: z.string().nullable()
        })
        .nullable(),
      transition_out: z
        .object({
          type: z.enum(["cut", "fade", "strobe-hit", "hold", "ramp"]),
          duration_beats: z.number().min(0),
          notes: z.string().nullable()
        })
        .nullable()
    })
  ),
  preset_catalog: z
    .array(
      z.object({
        preset_id: z.string(),
        name: z.string(),
        family: z.string(),
        mode_support: z.array(z.enum(["deterministic", "live-rotation"])),
        phrase_tags: z.array(z.string()),
        energy_tags: z.array(z.enum(["low", "mid", "high", "peak"])),
        style_tags: z.array(z.string()),
        palette_key: z.string(),
        engine: z.string(),
        thumbnail_url: z.string().nullable(),
        clip_source: z.string().nullable(),
        notes: z.array(z.string())
      })
    )
    .default([]),
  phrase_visual_assignments: z
    .array(
      z.object({
        phrase_id: z.string(),
        preset_id: z.string(),
        locked: z.boolean(),
        palette_override: z.string().nullable(),
        parameter_overrides: z.record(z.union([z.string(), z.number(), z.boolean()]))
      })
    )
    .default([]),
  lighting_cues: z.array(
    z.object({
      cue_id: z.string(),
      phrase_id: z.string(),
      fixture_group: z.string(),
      look: z.object({
        palette: z.string(),
        intensity: z.number().min(0).max(1),
        movement: z.string(),
        strobe: z.boolean()
      }),
      priority: z.number().int()
    })
  ),
  dmx_laser_cues: z.array(
    z.object({
      cue_id: z.string(),
      phrase_id: z.string(),
      fixture_group: z.string(),
      mode: z.string(),
      parameter_overrides: z.record(z.union([z.number(), z.string()]))
    })
  ),
  manual_overrides: z.array(
    z.object({
      target_type: z.enum(["phrase", "lighting_cue", "laser_cue", "visual"]),
      target_id: z.string(),
      payload: z.record(z.union([z.string(), z.number(), z.boolean()]))
    })
  )
});
