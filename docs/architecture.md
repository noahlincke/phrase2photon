# Architecture

## Core Goal

Phrase-to-Photon turns Ableton arrangement semantics into a deterministic show package, then plays that package through a code-native runtime.

The durable product is not a TouchDesigner network. It is:

- an extraction layer,
- a typed show contract,
- a deterministic compiler,
- a graphics-first runtime,
- output adapters for lighting, DMX, Art-Net, and later external tools.

## v0 Contract

The source of truth is a phrase-indexed `ShowPackage`.

For v0, the contract contains:

- `SongMeta`
- `LocatorRef`
- `PhraseRange`
- `Phrase`
- `TrackFeatures`
- `EnergyFeatures`
- `VisualLook`
- `LightingLook`
- `LightingCue`
- `DmxLaserCue`
- `Transition`
- `ManualOverride`
- `ShowPackage`

Deferred to later phases:

- direct Art-Net/sACN packet output,
- vector-laser graphics,
- a formal software safety subsystem.

## System Boundaries

### 1. Runtime Input Producers

All runtime input paths should produce the same phrase runtime state:

- a `ShowPackage` or live-generated show equivalent,
- current BPM,
- active phrase identity,
- normalized phrase progress,
- audio feature bands,
- output intents derived from the active phrase.

The three peer producers are:

- Producer Pal analyzed inputs: Ableton truth is extracted and compiled into an editable show folder.
- Live mic input: the browser listens to the room, estimates BPM and phrase changes, and acts as a VJ by selecting compatible live cue phrases.
- WAV-only input: a standalone audio file is analyzed without requiring an Ableton project, then compiled or streamed through the same runtime state shape.

The renderer and output adapters should not care which producer supplied the state.

### 2. Producer Pal Adapter

Responsibilities:

- connect to local Producer Pal REST,
- discover enabled tools,
- cache JSON Schema definitions,
- validate outbound requests,
- fetch Live Set, locators, tracks, arrangement clips, device state, and project memory,
- optionally use raw Live API for detail reads not covered by normal tools.

This layer is pure Python and fully testable without the runtime.

### 3. Compiler

Responsibilities:

- normalize Ableton reads into internal extraction models,
- derive phrase ranges from locators and arrangement structure,
- derive visual and lighting intent,
- compile deterministic cue outputs,
- write a show package directory.

Primary invariants:

- deterministic output for the same inputs,
- stable IDs,
- explicit diffs,
- reproducible fixture targeting.

### 4. Code-Native Runtime

Responsibilities:

- load package files from disk or HTTP,
- keep song, phrase, and beat state,
- render screen visuals with Three.js,
- expose preview and debug state,
- publish phrase output events for lighting and DMX adapters,
- eventually emit Art-Net/sACN/DMX from the same phrase state.

The runtime is authored as text, not a binary GUI project. Agents should be able to edit, diff, test, and screenshot it end to end.

## Runtime Planes

### Data Plane

Files written per package:

- `show.json`
- `phrases.csv`
- `lighting_cues.csv`
- `laser_dmx_cues.csv`
- `fixture_map.json`
- `runtime_overrides.json`

### Clock Plane

Runtime clock sources:

- manual phrase selection,
- simulated beat clock,
- library audio playback,
- live microphone BPM and phrase detection,
- WAV-only analysis/playback,
- later Ableton Link,
- later Producer Pal transport polling,
- later OSC/MIDI clock.

### Graphics Plane

Three.js is the primary graphics surface. The first runtime should provide:

- a phrase renderer interface,
- reusable scene modules,
- a deterministic frame context,
- a fullscreen preview path,
- screenshot-testable visual states.

### Output Plane

DMX and Art-Net are parallel output types, not the initial runtime foundation. Each phrase can produce:

- graphics commands,
- lighting cue intents,
- DMX laser cue intents,
- future direct universe/channel frames.

The runtime should make the output state visible even before real hardware output exists.

## Human GUI Boundaries

Human-required work is now limited to external tools and hardware verification:

- Ableton setup,
- Producer Pal device availability,
- fixture profile authoring,
- universe/channel verification against real or simulated hardware,
- final projection/stage art direction.

The main renderer should not require GUI authoring to change topology or behavior.
