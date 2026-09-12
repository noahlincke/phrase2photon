# Mic Drop Override Design

## Goal

Strengthen Mic mode so it can jump into `Drop` earlier when a strong low-frequency change lands close to a bar start, while also making Mic-mode BPM detection more bass-led so bar alignment is reliable enough to use for that decision.

## Scope

This change includes:

- preserving the existing 32-beat phrase-slot structure as the default Mic-mode progression,
- adding a narrow early `Drop` override path that can interrupt the current phrase before the next 32-beat slot,
- restricting that override to moments that land near a bar start,
- using generous timing tolerance around the bar start so the feature still works with imperfect BPM estimation,
- making BPM/onset detection weight low-frequency behavior more strongly than the current broad-band level heuristic,
- adding regression tests around early `Drop` promotion and bass-led tempo detection helpers.

This change does not include:

- general early phrase switching into non-`Drop` phrases,
- changing the existing phrase palette (`Strip`, `Groove`, `Lift`, `Drop`),
- replacing the current Mic-mode timeline or DMX output model,
- introducing a full beat-tracker or separate downbeat-alignment service.

## Architecture

Mic mode should keep its current model: a browser-side live producer emits a show-like runtime snapshot, including phrase identity, BPM, beat/bar counters, and phrase progress. The default behavior still advances by 32-beat phrase slots. The new behavior is an escape hatch layered on top of that model: if the current audio strongly suggests a drop is arriving and the timing is close enough to a bar start, the producer may emit an immediate `Drop` phrase event instead of waiting for the next slot boundary.

The same `LiveMicInput` unit should continue owning:

- audio-band history,
- onset and BPM estimation,
- phrase classification,
- phrase-event identity generation.

That keeps the new override tightly coupled to the existing phrase-selection logic and avoids scattering tempo and phrase decisions across the runtime render loop.

## Components

### Live Phrase Selection

`LiveMicInput` should continue deriving a broad phrase bucket from recent band history, but it now also needs a separate early-override decision:

- first compute the normal slot-driven phrase choice from the current profile,
- then check whether the snapshot is eligible for an immediate `Drop` override,
- if the override fires, return `Drop` for the current snapshot and emit a fresh phrase event immediately,
- if it does not fire, preserve the normal slot-driven phrase behavior.

The override is intentionally one-way and narrow: it only promotes into `Drop`. It should not create arbitrary phrase skipping between `Strip`, `Groove`, and `Lift`.

### Bass-Led Tempo / Onset Detection

The current BPM estimator keys off a weighted full-band level rise. That should shift toward low-end-driven onset scoring:

- low-band energy should be the primary term,
- low-band positive change versus recent baseline should have explicit weight,
- mid/high energy may remain as weaker supporting signal so snare-heavy material still contributes,
- onset acceptance should continue enforcing a minimum spacing guard so one kick does not register multiple times.

This is still a lightweight heuristic estimator, not a new beat-tracking subsystem. The goal is better practical bar alignment for dance music, not formal beat-grid reconstruction.

## Early Drop Override Rules

The early `Drop` override should require all of the following:

1. the current broad phrase context is not already `Drop`,
2. a fresh low-frequency surge is present,
3. the surge represents a large change relative to the immediately preceding low-band baseline,
4. the current beat timing is close enough to a bar start,
5. the override has not already fired for the same bar-start opportunity.

### Low-End Surge

The trigger should be based on recent low-band history rather than a single absolute frame:

- current low-band magnitude,
- current low-band delta versus the recent trailing baseline,
- supporting total energy / sustained energy so random low rumble does not trigger `Drop`.

The thresholds should be intentionally generous rather than surgically tight, because the user explicitly wants Mic mode to react more readily to kick-driven drop arrivals. The tests should lock down qualitative behavior rather than one magic-number interpretation.

### Bar-Start Alignment

The override is only allowed near bar starts, not at arbitrary beat positions.

Interpretation:

- any bar start is eligible,
- timing tolerance around the bar start should be generous so slight BPM drift does not suppress obvious drops,
- the tolerance should be symmetric enough to catch kicks that arrive slightly early or late relative to the estimated beat clock.

This keeps the feature rhythm-aware without pretending the BPM estimator is sample-accurate.

### Re-Arm / Cooldown

Once Mic mode fires an early `Drop` override for a given bar-start opportunity, it should not keep re-firing repeated fresh `Drop` events on adjacent frames. A lightweight guard should suppress duplicate triggers until the next meaningful alignment opportunity or phrase context reset.

## Phrase Event Identity

Mic mode already uses `phraseEventId` and `phraseSlot` so repeated semantic labels can still produce fresh cues. The early `Drop` override should preserve that contract:

- it must emit a fresh phrase event when the override fires,
- the event identity should remain stable enough for timeline rendering and DMX cue selection,
- repeated frames inside the same override window should not manufacture additional event ids.

The runtime should still be able to tell the difference between:

- normal slot-based `Drop`,
- early override `Drop`,
- the same `Drop` continuing across later frames.

## Runtime Behavior

User-visible behavior should be:

- Mic mode still behaves normally most of the time,
- `Drop` can arrive before the next 32-beat phrase boundary when the room audio clearly shifts into kick-heavy impact,
- the early jump only happens near a bar start,
- cueing remains stable because repeated frames do not spam new phrase events,
- BPM readout and bar alignment should feel less erratic on kick-driven dance material than before.

The render loop and output adapters should not need a new control path. They should continue responding to the snapshot emitted by `LiveMicInput`.

## Error Handling

The feature should fail soft:

- if BPM estimation remains uncertain, Mic mode should continue producing normal slot-based phrases,
- if low-band data is noisy, the override should simply not fire rather than thrash,
- if the timing guard rejects the event, Mic mode should remain on the normal phrase path without user-visible errors.

False negatives are preferable to repeated false-positive `Drop` jumps.

## Testing

Implementation should be test-first.

Required regression coverage:

- an early `Drop` override fires when a strong low-band change lands close to a bar start,
- the same low-band change does not fire away from a bar start,
- the override does not repeatedly emit new phrase events inside the same trigger window,
- loud balanced material still does not collapse into `Drop`,
- the bass-led onset/BPM helper prefers kick-like low-end pulses over balanced broad-band spikes.

The tests should focus on the live-input helper behavior in `runtime/src/app/liveMicInput.ts`, because that is where phrase selection and BPM estimation already live.
