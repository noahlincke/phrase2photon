# Phrase2Photon Web Runtime

The runtime is a Vite app with a small local library service.

It also proxies the local Now Playing backend so the browser can stay same-origin while polling `/api/now-playing/status` and loading prepared `/api/now-playing/show/<id>` plus `/api/now-playing/audio/<id>` assets.

## Local Library

By default, the dev server reads:

```text
~/Phrase2PhotonShows/library.json
```

Shape:

```json
{
  "version": 1,
  "tracks": [
    {
      "id": "kolter-let-you-go",
      "title": "Kolter - Let You Go",
      "artist": "Kolter",
      "abletonProjectPath": "/path/to/project.als",
      "audioPath": "/path/to/bounce.wav",
      "showPath": "/path/to/compiled-show",
      "bpm": 122
    }
  ]
}
```

`showPath` must contain `show.json`. The app computes phrase playback times from `show.json` using song BPM and phrase bar/beat ranges.

## Commands

```bash
npm install
npm run dev
npm test
npm run e2e
npm run typecheck
npm run build
```

## Audio analysis

`src/audio/` holds the analysis pipeline: STFT front end, SuperFlux onset
detection, tempo estimation, beat tracking and bar-grid phrase segmentation.
The same modules run in two places, which is the point - `liveAnalysis.ts`
drives microphone input in the browser, and `analyzeTrack.ts` is the offline
reference. They share every feature definition, so the live detector cannot
quietly drift away from the one that gets measured.

### Measuring it

Accuracy is scored against Mixed In Key's static analysis, which supplies
ground-truth tempo, complete beat grids and 8-bar energy segments for the local
library. Export the reference set once:

```bash
python3 scripts/mik_export.py --out .analysis-cache/mik-truth.json
```

Then:

```bash
npm run bench:mik  -- --limit 150 --min-bpm 115 --max-bpm 145   # offline
npm run bench:live -- --limit 150 --min-bpm 115 --max-bpm 145   # microphone path
npm run bench:track -- "artist or title"                        # one track, verbose
```

The studies that fit the tunable constants are `bench:phase` (onset weighting
and beat phase), `bench:grid` (bar and phrase grid weights) and `bench:energy`
(the energy composite). Re-run the relevant study after changing a feature
definition; the constants in `beats.ts` and `structure.ts` were fitted, not
chosen, and stale weights are worse than no weights.

## Visuals

`src/graphics/` renders GLSL scenes over a full-screen quad. `visualScenes.ts`
is the catalogue, `glsl/scenes.ts` the shaders, and `glsl/common.ts` the shared
line rendering, easing and colour grading that make the scenes read as one
system rather than six unrelated effects.

Scenes can be judged without audio or a show package:

```text
http://127.0.0.1:5173/preview.html?grid=1&energy=0.6
http://127.0.0.1:5173/preview.html?scene=tunnel&energy=0.85&palette=acid-contrast&t=12
```

`grid=1` shows every scene at once; `t` freezes the clock so screenshots are
comparable between runs.

## Now Playing Dev Contract

Start the Python orchestration service first:

```bash
uv run phrase2photon now-playing-serve
```

Default bind:

```text
http://127.0.0.1:8768
```

Then start the runtime dev server in a second shell:

```bash
cd runtime
npm run dev
```

Default bind:

```text
http://127.0.0.1:5173
```

The Vite middleware fronts `/api/now-playing/*` for the Python service. Status and show requests are proxied directly, while `/api/now-playing/audio/<id>` gets range-aware transport so browser seeking behaves like library playback. Override that backend target when needed with:

```bash
PHRASE2PHOTON_NOW_PLAYING_BASE_URL=http://127.0.0.1:8768 npm run dev
```

In `Now Playing` mode the runtime polls `/api/now-playing/status`, keeps mic-reactive fallback available when no premade show is active, and activates prepared show/audio URLs through the shared runtime loader path used for normal track loads.

Current local Kolter registry:

```text
/Users/nlincke/Phrase2PhotonShows/library.json
```

## E2E Coverage

`npm run e2e` starts the Vite runtime, loads the Kolter show, checks that the Three.js canvas is nonblank, jumps to `Drop 2`, and verifies that a DMX preview frame is published for the active phrase.

## FB4 DMX16 Output

The runtime includes a Pangolin FB4 16-channel DMX profile mapper. It publishes preview frames by default and sends Art-Net only after `Send live Art-Net` is checked in the UI.

Default live target:

```text
host: 127.0.0.1
universe: 0
port: 6454
```

The host and universe are editable in the UI. The live-enable checkbox is intentionally not persisted across reloads.

Cue and overlay controls:

- `Blackout`: sends all 16 profile channels as zero.
- `Cue 1`: selects page 1 / cue 1 at the current show BPM.
- `Zone frame`: holds page 1 / cue 4, the observed square cue, at full X/Y size and centered position for projector zone tuning.
- `Cue sweep`: steps through cues 1-8.
- `Brightness sweep`: steps through channel-5 values 0, 64, 128, 192, 255, then 128.
- `Original color`: uses channel 15 original cue color.
- `White`: uses channel 15 white.
- `Hold debug cues`: keeps the next cue/overlay active until `Release hold` is clicked.

Cue/overlay frames temporarily take over the output stream so normal beatmatched show frames do not immediately overwrite the test cue. The output API also honors that hold window, which prevents another open runtime tab or an in-flight show frame from stealing the output during operator checks. Debug hold is explicit server state, not a long timer, so it stays active until release. When live Art-Net is enabled, held overlays are refreshed every 100 ms so fixtures that require a continuous DMX stream do not time out.

The panel always shows the currently active cue and its overlay values:

- cue page/index and known shape,
- brightness,
- size X/Y,
- position X/Y,
- angle,
- color mode,
- scan rate.

Brightness:

- The show mapper now applies a dimmer curve instead of linear phrase intensity.
- Low-energy show frames use larger default X/Y size values so sparse intro cues do not collapse into tiny shapes.
- `Override cue brightness` rewrites FB4 channel 5 for every outgoing preview/live frame.
- The brightness slider value is stored locally; the live-send checkbox still resets off on reload.

Geometry overlays:

- `Override geometry overlays` rewrites FB4 channels 7, 8, 9, 10, 11, 12, and 13 for every outgoing preview/live frame.
- The sliders control size X/Y, position X/Y, angle, visible points, and scan rate.
- The slider values are stored locally; the live-send checkbox still resets off on reload.

Observed cue catalog:

Page 1 is treated as a per-cue mapping, not as a hardcoded FB4 shape-bank formula. The current defaults include observed names for P1 C1-C26 and generic placeholders for P1 C27-C48.

Known examples:

| Cue | Name |
| --- | --- |
| P1 C1 | Circle |
| P1 C2 | Horizontal line |
| P1 C3 | Upside-down triangle |
| P1 C4 | Square |
| P1 C21 | Red Circle with White NESW |
| P1 C25 | Moving Single Sine Wave (w End Point) |

Cataloging mode:

- `Cataloging mode` expands page 1 into cue rows 1-48.
- Each row has an audition button and an editable cue-name field.
- Cue names are stored in browser local storage and immediately update the current cue indicator plus audition labels.
- `Export mappings` writes the current merged cue names to `~/Phrase2PhotonShows/exports/fb4-cue-catalog.json`.

Profile notes:

- Channel 1 is set to the sixteen-channel DMX mode range.
- Channel 3 selects the cue index from the active phrase position.
- Channel 4 tracks song BPM.
- Channel 5 tracks phrase lighting intensity.
- Channels 7, 8, and 9 map visual density/progress into size and angle.
- Channel 15 can only request original cue color, color scroll, or white in this FB4 profile. Show frames now avoid `Original cue color` by default because cue originals can be unexpectedly purple.
- Current closest-color mapping: `smoke-cool` -> cyan, `acid-contrast` -> lime, `warm-cinematic` -> orange, `nocturne-glow` -> purple, `desaturated_decay` -> white.
- The runtime displays both the graphics color hex and the chosen laser color/channel value so color mismatches are explicit.

Reference: https://wiki.pangolin.com/doku.php?id=hardware:fb4:dmx16

## Zoning and Geometry

Art-Net in this runtime is for live cue and overlay control. It should not be treated as the primary safety or zoning layer.

Recommended split:

- Use Pangolin/FB4 projector settings and projection zones for scan area, geometric correction, masking/attenuation, test patterns, and any venue-specific safety geometry.
- Use this runtime for page/cue selection and live overlays: brightness, size, position, angle, color mode, scan rate, and visible points.
- Keep live Art-Net off until the physical projector is aimed, bounded, and verified.

Pangolin docs describe Projection Zones as the place to configure scanner output, geometric correction, preview appearance, and zone test patterns. Projector Settings provide global size/position, scan-rate, color-shift, and projector test-pattern workflows. In other words: pre-zone the laser in Pangolin/FB4 first, then drive bounded cues from here.

References:

- https://wiki.pangolin.com/quickshow:projection_zones
- https://wiki.pangolin.com/doku.php?id=beyond:projector_settings-new
- https://wiki.pangolin.com/doku.php?id=beyond:artnet_dmx_sacn
