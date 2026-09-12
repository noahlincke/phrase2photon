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

## Following a deck through loops and cue jumps

`src/audio/follower.ts` answers a different question from the rest of the
analyser. Everything else asks "what is this audio doing"; the follower already
knows the track and asks "where in it are we". That matters because a DJ
application's reported position cannot answer it - rekordbox's is inferred from
file read offsets, which never move backwards, so a four-bar loop leaves the
show running on a timeline the deck has already left.

The track's analysis becomes a reference print and the live signal is matched
against it. Three design decisions carry the result.

**Whitened bands plus onset deltas, not raw band energy.** Raw log-band
energies correlate at around 0.75 between *any* two moments of a track, because
every moment shares the same broad spectral tilt. Nothing is distinguishable at
that level. Whitening each band by its own mean and spread across the track
removes the shared shape; adding a half-wave-rectified temporal delta adds where
the onsets are. This was measured, not assumed: before the change the match
scored 0.76 at the true position and 0.75 everywhere else.

**Best suffix, not fixed window.** A four-beat loop at 128 BPM is 1.9 s, shorter
than the 2.2 s match window, so the window always straddles the loop seam and no
full window ever matches cleanly. Scoring every suffix length and keeping the
best - with a shrinkage term so short suffixes cannot win on luck - is what
makes short loops detectable at all.

**Live self-similarity, not reference matching, for loops.** Matching against
the reference cannot separate a loop from the arrangement repeating, and in
four-to-the-floor music the arrangement repeats constantly. A looping deck
replays the same samples, so the live signal correlates with its own recent past
far more strongly. `npm run bench:loopsep` measures how far that separates over
24 tracks: median 0.978 while looping against 0.791 while merely playing, with
overlapping tails.

| threshold | loop recall | false positives |
| --- | --- | --- |
| 0.86 | 95.0% | 32.1% |
| 0.90 | 85.5% | 20.1% |
| 0.94 | 76.9% | 9.3% |

0.86 with two-column confirmation and a discount for repetition the reference
already has ended up best end to end. Forcing a wrap every loop length whether
or not the reference agreed was also tried, and measured worse: three points of
recall for nine times the spurious reports, because a loop that has been
released keeps wrapping until it is noticed.

Results over 40 tracks replayed as simulated performances
(`npm run bench:follow`): median position error 27 ms, within 100 ms 77.8% of
the time, all cue jumps detected, 53.5% of loops detected with the length right
94% of the time, four spurious loops in total, 1.1 s latency.

Two bugs found here were worth the benchmark on their own. Reported positions
were systematically 60 ms early because column indices were treated as times,
ignoring that a spectral frame is timed at its centre - most of a 100 ms
accuracy budget spent on an off-by-one. And every jump was reported four times
over, because the status returned between columns still carried the last one;
that alone accounted for three quarters of what looked like spurious detections.
