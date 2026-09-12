# Phrase2Photon

Beat- and phrase-aware visuals for live electronic music. Point it at a
microphone, and it locks to the tempo, finds the bar and phrase grid, tracks
where the track is in its arrangement, and drives GPU-rendered visuals and an
optional laser lane from that.

It also runs from a file, or from a show package compiled ahead of time out of
an Ableton arrangement, but the microphone is the primary path and the one that
gets measured.

## Why

Most audio-reactive visuals react to *level*. They flash on loud things. That
reads as noise on a dancefloor, because dance music is not about loudness, it
is about where you are in an eight-bar phrase and what is about to happen.

Phrase2Photon tries to answer the musical question instead: what is the tempo,
which beat starts the bar, is this a groove or a build or a drop, and how far
through the phrase are we. Everything drawn on screen is locked to that.

## Accuracy

Detection is scored against Mixed In Key's static analysis, which provides
ground-truth tempo, complete beat grids and 8-bar energy segments. On a
house/techno corpus (115-145 BPM), 250 tracks analysed offline and 200 streamed
through the live microphone path in 128-sample blocks:

| | Offline | Live |
| --- | --- | --- |
| Tempo within 0.1 BPM | 96.8% | 81.0% |
| Tempo within 0.5 BPM | 98.4% | 94.0% |
| Tempo within 2% | 99.6% | 96.5% |
| Octave / metre errors | 0.4% | — |
| Beat grid F-measure | 0.779 | 0.788 |
| Energy correlation (median) | 0.67 | — |
| Time to tempo lock | — | 7.6 s, locks on every track |

The live path is at parity with full static analysis on the beat grid, which is
the number that matters: the microphone is not a degraded mode.

Deciding *which* of four beats starts the bar is the weak point, at roughly 53%
offline and 44% live. In four-to-the-floor music the kick plays on every beat,
so beat 1 has no local signature; every purely local cue measured weakly in
isolation. There is a tap-downbeat control that settles it in one gesture, and
detected phrase changes re-anchor the grid.

See [`runtime/docs-analysis.md`](runtime/docs-analysis.md) for the method, the
measurement harness, and the findings that contradicted the obvious guess.

## How it is put together

```text
runtime/src/audio/      Analysis: onsets, tempo, beats, bar grid, phrases
runtime/src/graphics/   GLSL scenes and the palette system
runtime/src/app/        Application shell, transport, microphone capture
runtime/src/dmx/        Pangolin FB4 Art-Net output lane
runtime/scripts/analysis/  Accuracy harness and parameter studies
src/phrase2photon/      Python compiler: Ableton arrangement -> show package
docs/                   Architecture and research notes
```

The analysis pipeline has a single set of feature definitions that runs in two
places: `analyzeTrack.ts` offline, `liveAnalysis.ts` in the browser on
microphone input. Only the parts that genuinely must differ do - rolling
windows instead of whole-track statistics, a causal phrase state machine
instead of a dynamic programme. That is deliberate: it means the detector that
ships live cannot quietly drift away from the one that gets measured.

Visuals are fragment shaders over a full-screen quad. Six scenes share one
vocabulary of line rendering, beat easing and colour grading, so they read as
one system rather than six unrelated effects.

## Running it

```bash
cd runtime
npm install
npm run dev            # http://127.0.0.1:5173
```

Pick **Source → Mic**, choose an input, press Listen. A loopback device such as
BlackHole works well for feeding it the audio you are already playing.

```bash
npm test               # unit tests
npm run e2e            # end-to-end
npm run typecheck
```

Scenes can be judged on their own, without audio:

```text
http://127.0.0.1:5173/preview.html?grid=1&energy=0.6
http://127.0.0.1:5173/preview.html?scene=tunnel&energy=0.85&palette=acid-contrast&t=12
```

### Measuring detection accuracy

Requires a local Mixed In Key library as the reference, and `ffmpeg`:

```bash
python3 runtime/scripts/mik_export.py --out runtime/.analysis-cache/mik-truth.json
cd runtime
npm run bench:mik  -- --limit 150 --min-bpm 115 --max-bpm 145
npm run bench:live -- --limit 150 --min-bpm 115 --max-bpm 145
```

### Compiling a show from Ableton

The Python side turns an arrangement into a typed show package, so a
pre-planned set can be driven deterministically instead of detected live:

```bash
python -m phrase2photon.cli compile --outdir ~/Phrase2PhotonShows/my-song
pytest
```

Compiled shows land in `~/Phrase2PhotonShows/<song-slug>/`, and the dev server
reads `~/Phrase2PhotonShows/library.json` to list them.

## Laser output

There is an opt-in Pangolin FB4 Art-Net lane, driven from the same phrase
state as the visuals. It previews frames by default and only sends live UDP
when explicitly enabled.

Cue thumbnails are generated from Pangolin's FB4 Beam Content Pack and are not
redistributed here. If you have an FB4 you have the pack; regenerate them with
`node --experimental-strip-types scripts/generateFb4CueCatalog.ts`. The
catalogue works without them, just without preview images.

## Status

Used in practice, still moving. The microphone path, the visuals and the laser
lane work; tempo detection is solid for four-to-the-floor material and less so
outside it, and bar-phase detection is the open problem.

## Licence

MIT. See [LICENSE](LICENSE).
