# Mic Transport Lock Design

## Goal

Add manual mic-transport controls so the operator can lock Mic mode to a fixed BPM and tap the start of beat 1 to re-align the downbeat anchor without changing that locked BPM.

## Scope

This change includes:

- a `Fixed BPM` checkbox in the existing mic control block,
- a numeric BPM input that is enabled only while `Fixed BPM` is checked,
- a `Tap Beat 1` button in the existing mic control block,
- producer-side support in `LiveMicInput` for locking and unlocking BPM,
- producer-side support in `LiveMicInput` for re-anchoring beat/bar phase from a single tap,
- unit tests for fixed-BPM lock behavior and tap-based phase re-alignment,
- a small browser-facing verification path for the new controls.

This change does not include:

- a multi-tap tempo detector,
- a separate transport model outside `LiveMicInput`,
- persistence across page reloads unless already implied by the existing control wiring,
- any changes to Library mode transport,
- any changes to the earlier early-`Drop` override beyond using the new downbeat anchor naturally.

## Architecture

The existing boundary should stay intact: `main.ts` owns sidebar controls and user intent, while `LiveMicInput` owns the mic transport clock, tempo estimation, beat/bar phase, phrase-slot progression, and phrase-event identity.

The new UI should send explicit transport commands into `LiveMicInput`:

- enable fixed BPM with a numeric value,
- disable fixed BPM and return to live detection,
- tap the start of beat 1 to re-anchor the current downbeat.

The transport model should remain the current elapsed-time clock. The clean extension is to preserve the `estimatedBpm + startedAtSeconds` model and treat both new controls as updates to that model rather than layering a second transport state machine on top.

## UI Behavior

The new controls belong inside the existing `micControls` block, so they appear anywhere Mic-mode controls are already shown.

Required controls:

- `Fixed BPM` checkbox,
- BPM numeric input,
- `Tap Beat 1` button.

Behavior rules:

- when `Fixed BPM` is unchecked, the numeric BPM input is disabled and live onset detection owns tempo,
- when `Fixed BPM` is checked, the numeric BPM input becomes editable and Mic mode uses that BPM verbatim,
- checking `Fixed BPM` should use the current effective mic BPM as the initial value if no explicit override has been entered yet,
- unchecking `Fixed BPM` releases control back to live tempo detection rather than preserving the lock invisibly,
- `Tap Beat 1` should remain a transport-alignment action only and must not modify the current locked BPM value.

`Live BPM` should continue to show the effective BPM, whether it comes from detection or the fixed lock.

## Producer Behavior

`LiveMicInput` needs explicit transport-control methods rather than implicit UI-side mutation.

### Fixed BPM Lock

The producer should support:

- setting a fixed BPM value,
- clearing the fixed BPM value,
- exposing whether a fixed BPM lock is currently active.

When fixed BPM is active:

- `estimatedBpm` should resolve to the locked value,
- live onset detection should stop changing BPM,
- phrase timing, bar counting, and early-`Drop` alignment should all use the locked BPM naturally.

When fixed BPM is released:

- live onset detection should resume,
- any short-term onset accumulators that would be misleading after a long locked period should be reset so detection restarts cleanly.

### Tap Beat 1

`Tap Beat 1` should re-anchor the transport so the tapped moment becomes beat 1 of bar 1 for the mic transport clock.

Interpretation:

- it is a phase-alignment control, not a tempo-estimation control,
- it does not change the current effective BPM,
- it should immediately affect beat/bar reporting and any bar-start-sensitive mic behavior,
- it should reset the local phrase-slot alignment to the new downbeat anchor because the system has no other external musical position reference.

That last point is important: with only one tap and no absolute song position, the tap becomes the new reference point for both bars and 32-beat phrase windows.

## Integration With Existing Mic Logic

The recent early-`Drop` override already keys off bar-start proximity. It should not need a separate code path for manual transport alignment. Once `Tap Beat 1` updates the producer’s anchor, the override should naturally inherit the improved beat-1 alignment.

Likewise, the Mic timeline, phrase list, and DMX cue progression should continue consuming the normal snapshot shape. No new runtime rendering branch should be introduced.

## Error Handling

The feature should fail soft:

- invalid BPM input should never crash the runtime,
- if the user enters an out-of-range or empty BPM value, the UI should clamp or ignore it rather than leaving `LiveMicInput` in a broken state,
- tapping beat 1 while mic capture is stopped should do nothing visible beyond preserving UI state,
- releasing fixed BPM should resume detection even if the current audio is quiet.

## Testing

Implementation should be test-first.

Required unit coverage:

- setting fixed BPM prevents live onset detection from changing tempo,
- clearing fixed BPM allows detection to resume and update tempo again,
- tapping beat 1 re-aligns beat/bar phase without changing the effective BPM,
- fixed BPM and tap-based transport changes preserve the existing mic snapshot shape.

Required end-to-end verification:

- the new mic controls render in the runtime,
- the BPM input is disabled until `Fixed BPM` is checked,
- the transport controls do not regress the existing mic-mode surface.
