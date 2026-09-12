# Implementation Plan

## Delivery Strategy

Build the system in this order:

1. Keep the existing v0 show contract stable.
2. Remove TouchDesigner as an active runtime surface.
3. Add a TypeScript runtime package with explicit graphics, clock, show, and output interfaces.
4. Build a minimal Three.js preview app that loads `show.json`.
5. Add phrase selection, simulated beat state, and screenshot tests.
6. Add a simulated DMX/Art-Net output monitor.
7. Add real output adapters only after the graphics loop feels strong.

## Parallel Workstreams

### Agent A: Python Contract and Compiler

Owns:

- extraction models,
- `ShowPackage` contract,
- compiler pipeline,
- schema export,
- snapshot tests.

This work remains independent of the graphics runtime.

### Agent B: Runtime Core

Owns:

- TypeScript show models,
- loader and validation boundary,
- clock interface,
- runtime state reducer,
- output event interfaces.

This should stay renderer-agnostic where practical.

### Agent C: Three.js Graphics

Owns:

- renderer interface implementation,
- scene module registry,
- phrase visual mapping,
- debug overlays,
- Playwright screenshot tests once the app exists.

### Agent D: Output Adapters

Owns:

- fixture map typing,
- DMX frame model,
- Art-Net/sACN adapter investigation,
- simulator view.

This starts after the runtime state model is stable enough to publish phrase output events.

## Critical Path

1. Runtime package scaffold
2. Shared show model interfaces
3. Show package loader
4. Shared input-producer state shape
5. Manual/library audio clock
6. Live mic clock and phrase producer
7. WAV-only analysis producer
8. Three.js scene host
9. First phrase-driven visual scene
10. Output event simulator
11. Direct DMX/Art-Net adapter

## Input Producer Plan

Producer Pal, live mic, and WAV-only paths are equal producers for the photon runtime. Each one should emit:

- show identity and phrase/cue vocabulary,
- BPM,
- active phrase,
- normalized phrase progress,
- audio features,
- diagnostics for the operator UI.

Producer Pal remains the high-confidence offline path: extract Ableton structure, compile `show.json`, then let the runtime play the compiled show.

Live mic is the live VJ path: request microphone input, estimate BPM from onsets, classify section energy from audio bands, select a compatible cue phrase at phrase boundaries, and publish the same visual/DMX frames as compiled shows.

WAV-only should sit between those two: analyze a standalone file into phrase candidates, compile or stream those candidates, and then run through the same runtime frame path without needing an `.als` file.

## Milestones

### M0: Repo Reorientation

- TouchDesigner removed from the active repo
- README and docs describe the code-native runtime
- tests still pass

### M1: Runtime Interfaces

- TypeScript package exists
- show, clock, graphics, and output interfaces compile
- a unit test loads an example show package

### M2: Graphics Preview

- Vite/Three.js app loads `show.json`
- active phrase can be selected manually
- phrase visual state changes are visible
- screenshots can be taken in browser tests

### M3: Clocked Playback

- simulated beat clock drives phrase progress
- runtime state exposes beat, bar, phrase, and normalized phrase progress
- graphics scenes receive stable frame context

### M4: Output Simulator

- lighting and DMX cue intents are visible in the UI
- fixture map resolves semantic fixture groups
- output state can be inspected without hardware

### M5: Real Output Adapter

- Art-Net or sACN output is implemented behind an adapter
- simulator and hardware output share the same frame model
- blackout, intensity, and pause controls affect both graphics and output state

### M6: Equal Input Producers

- left-panel runtime mode selects library/compiled show, live mic, or WAV-only producer
- Producer Pal compiled shows, live mic snapshots, and WAV-only analysis snapshots drive the same visualizer and FB4 DMX frame builder
- producer-specific diagnostics stay in the operator UI rather than leaking into renderer/output APIs

## Definition of Done for v0

- The bridge reads one Ableton song through Producer Pal.
- The compiler emits a deterministic phrase-indexed show package.
- The TypeScript runtime loads that package.
- A Three.js preview renders phrase-aware graphics.
- A simulated output lane shows lighting and DMX cue state per phrase.
- The architecture remains agent-editable without a binary GUI project in the critical path.
