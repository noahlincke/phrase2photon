# Phrase2Photon

Beat- and phrase-aware visuals for live electronic music. It locks to the
tempo, finds the bar and phrase grid, tracks where a track is in its
arrangement, and drives GPU-rendered visuals and an optional laser lane from
that.

Three ways to feed it, all first-class:

- **Mic** — listen to the room or a loopback device and analyse in real time.
  Nothing to prepare; works with any DJ setup, including someone else's.
- **Library** — play a show compiled ahead of time from an Ableton
  arrangement. The arrangement *is* the ground truth, so the phrase map is
  exact and repeatable, which is what you want for a planned set.
- **Now Playing** — watch rekordbox, VirtualDJ or macOS Now Playing, find the
  file that is actually playing, analyse it once, cache the show, and follow
  along. Full-track accuracy with no preparation, and it follows the deck's
  own transport clock where one is available.

They share one analysis core and one rendering system; the difference is only
where the musical timeline comes from.

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
the number that matters: the microphone is not a degraded mode. The offline
column is also what Now Playing gets, since it analyses the whole file before
the show is compiled.

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
runtime/src/audio/follower.ts  Deck following: position, loops, cue jumps
runtime/src/app/        Application shell, transport, microphone capture
runtime/src/dmx/        Pangolin FB4 Art-Net output lane
runtime/scripts/analysis/  Accuracy harness and parameter studies
src/phrase2photon/      Python compiler: arrangement or audio -> show package
src/phrase2photon/now_playing/  DJ-application watcher and show cache
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

Pick a source:

- **Mic** — choose an input and press Listen. A loopback device such as
  BlackHole works well for feeding it the audio you are already playing.
- **Library** — pick a compiled show. The search box filters by title and
  artist as the library grows.
- **Now Playing** — start the watcher (below) and it arms whatever your DJ
  application is playing.

**Show** pops the render out into a bare window with no HUD, meant to be
dragged to a projector or second display; the controls stay on the main window.

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

### Library: compiling a show from Ableton

The Python side turns an arrangement into a typed show package, so a
pre-planned set can be driven deterministically instead of detected live:

```bash
python -m phrase2photon.cli compile --outdir ~/Phrase2PhotonShows/my-song
pytest
```

Compiled shows land in `~/Phrase2PhotonShows/<song-slug>/`, and the dev server
reads `~/Phrase2PhotonShows/library.json` to list them.

### Now Playing: following a DJ application

```bash
python -m phrase2photon.cli now-playing-serve
```

It polls rekordbox, VirtualDJ and the macOS Now Playing service, resolves the
track to a file on disk, decodes it, runs the same analyser used everywhere
else, compiles a show from the detected tempo and phrase map, and caches it
under `~/.cache/phrase2photon/now-playing/`. The second time you play a track
it arms instantly.

The analyser is a bundled build of the runtime detector:

```bash
cd runtime && npm run build:analyzer
```

`npm run build` does this too. Without it, Now Playing falls back to a
level-based heuristic at an assumed tempo and says so in its status.

## Where the playhead comes from

A DJ does not play a track from start to finish. They loop four bars over a
transition, drop back to a hot cue, ride the pitch fader. A show driven from a
position that only ever moves forward is running on a timeline the DJ has
already left.

Now Playing takes the playhead from the best source available, in this order:

1. **The source app's own transport clock**, when it reports one. Nothing beats
   being told. Observations carry a `position_source` of `exact` in that case.
2. **Listening**, when it does not. See below.
3. **Projecting the app's estimate forward**, as a last resort. Rekordbox's
   position is inferred from how far through the file it has read, so it is
   coarse and never moves backwards - marked `estimated`, and only used when
   there is nothing better.

`docs/rekordbox-reverse-engineering.md` covers the work to get an exact clock
out of rekordbox specifically, which is ongoing.

### Following by ear

For sources that cannot be asked - a club CDJ, someone else's laptop, an app
with no position of its own - the analysed track becomes a reference and the
microphone signal is matched against it continuously. A loop is then not a
special case to be told about: it is the matched position going back by a round
number of beats.

This is a fallback and it earns its place, but it is a lot of signal processing
to work out something the source app already knows. Measured over 40 Mixed In
Key tracks replayed as simulated performances (`npm run bench:follow`):

| | |
| --- | --- |
| Median position error | 27 ms |
| Position within 100 ms | 77.8% of the time |
| Cue jumps detected | 100% |
| Loops detected | 53.5% |
| Loop length correct when detected | 94% |
| Spurious loop reports | 4 across 40 tracks |
| Detection latency | 1.1 s |

Cue jumps are easy because the audio after one is unrelated to the audio
before. Loops are hard for a reason worth stating: the detector rests on a
looping deck replaying the *same samples*, while musical repetition only sounds
similar - but dance music is built from copy-pasted bars, so a track can repeat
at a four-beat lag almost as exactly as a deck does. `npm run bench:loopsep`
measures that overlap directly, and the threshold is chosen from it rather than
guessed. Roughly half of loops are caught; the ones that are not are in
material so repetitive that carrying on straight through looks the same and
mostly *is* the same.

## Laser output

There is an opt-in Pangolin FB4 Art-Net lane, driven from the same phrase
state as the visuals. It previews frames by default and only sends live UDP
when explicitly enabled.

Cue thumbnails are generated from Pangolin's FB4 Beam Content Pack and are not
redistributed here. If you have an FB4 you have the pack; regenerate them with
`node --experimental-strip-types scripts/generateFb4CueCatalog.ts`. The
catalogue works without them, just without preview images.

## Status

Used in practice, still moving. All three sources, the visuals and the laser
lane work; tempo detection is solid for four-to-the-floor material and less so
outside it, and bar-phase detection is the open problem.

## Licence

MIT. See [LICENSE](LICENSE).
