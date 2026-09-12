# Audio analysis: how it works and how it is measured

## Why it is built this way

Beat and phrase detection for a VJ tool has one unusual constraint: it has to
be right *live*, from a microphone in a room, with no future context. The
temptation is to write one algorithm for offline files and a simpler one for
live input, and then to only ever measure the offline one.

This codebase does the opposite. `src/audio/` holds a single set of feature
definitions - STFT front end, SuperFlux onsets, beat features, bar features,
energy composite. `analyzeTrack.ts` is the offline reference and
`liveAnalysis.ts` is the real-time tracker, and both consume exactly those
features. The parts that genuinely must differ are named and confined:

| Stage | Offline | Live |
| --- | --- | --- |
| Tempo | Harmonic-comb over the whole track's autocorrelation | Same comb over a rolling 16 s window, locked with hysteresis |
| Beats | Dynamic programme over the full onset envelope | Rolling least-squares fit over the last 128 observed beats |
| Bar phase | Joint 32-offset grid search | Same search over a rolling beat window |
| Phrases | Dynamic programme over the bar grid | Causal state machine |
| Normalisation | Whole-track percentiles | Rolling-window percentiles |

## Ground truth

Mixed In Key's local database is the reference. It stores, per track, the tempo
it settled on, the complete beat grid, 8-bar energy segments rated 1-10, and
cue points at energy changes. That is a far better reference than hand
labelling, and there are ~2450 locally analysed tracks to score against.

```bash
python3 scripts/mik_export.py --out .analysis-cache/mik-truth.json
```

## Results

House and techno (115-145 BPM), 250 tracks offline and 200 live:

| | Offline | Live |
| --- | --- | --- |
| Tempo within 0.1 BPM | 96.8% | 82% |
| Tempo within 0.5 BPM | 98.4% | 93% |
| Tempo within 2% | 99.6% | 95% |
| Octave/metre errors | 0.4% | - |
| Beat grid F-measure | 0.779 | 0.784 |
| Beat phase on grid | 74.0% | 69% |
| Offbeat locks | 12.0% | 17% |
| Energy correlation (median) | 0.67 | - |
| Time to tempo lock | - | 7.6 s median |

Tempo is effectively solved for this genre. The live beat grid is at parity
with full static analysis, which is the result that matters most: the
microphone path is not a degraded mode.

## Known weakness: bar phase

Deciding *which* of four beats starts the bar is right about 53% of the time
offline and a little under 50% live. This is the honest weak point.

The reason is structural: in four-to-the-floor music the kick plays on every
beat, so beat 1 has no local signature at all. Every purely local cue measured
weakly in isolation - backbeat placement 24%, kick emphasis 28%, bar-level
repetition 26%, and the best of them, bass movement, 75% but only as a mod-4
signal. The joint grid search combines them with phrase-scale novelty, which
is why it beats any single cue, but it does not solve the problem.

Two things mitigate it in practice. The Source panel has a tap-downbeat
control that pins the grid outright and outranks the detector. And a detected
phrase transition - a drop, a breakdown, a build - is a phrase start by
definition, so the live tracker re-anchors its 8-bar grid whenever the state
machine fires.

## Fitted, not chosen

Several constants were fitted against the reference set rather than picked:

- Onset blend weights, and the on-beat/offbeat margin (`phaseStudy.ts`)
- Metric grid term weights (`gridStudy.ts`)
- The energy composite over the eight bar features (`energyStudy.ts`)
- Segmentation boundary cost and homogeneity weight (`phaseStudy.ts`)

Re-run the relevant study after changing a feature definition. A stale fitted
weight is worse than an unfitted one, because it looks deliberate.

## Findings worth keeping

Three results that were measured rather than assumed, each of which contradicted
the obvious first guess:

- **A per-beat phase-locked loop is the wrong model.** Chasing the local onset
  peak leaves the grid looser than the music, because the peak is quantised to
  the analysis hop and carries real micro-timing. Live beat F-measure was 0.59
  with a PLL and 0.78 fitting a line over 128 beats of observations.
- **Sub-band energy is a poor on-beat discriminator.** It seems ideal - kicks
  are sub energy - but a sustained bassline keeps it high between kicks, and
  energy has no transient localisation. It measured 52% offbeat locks against
  13% for onset flux over 30-140 Hz.
- **Brightness predicts perceived energy better than loudness.** Fitting the
  energy composite found the 2.9-16 kHz band the single best predictor of Mixed
  In Key's 1-10 rating (r = 0.59), ahead of RMS (0.48). A busy hi-hat pattern
  reads as high energy at modest level. Refitting raised the correlation from
  0.50 to 0.64.
