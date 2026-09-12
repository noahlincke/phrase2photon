# Research Notes

## Current Direction

The project has pivoted away from a TouchDesigner-centered runtime.

TouchDesigner had useful primitives, but the repo should optimize for things agents can edit, diff, test, and run:

- text-authored runtime code,
- screenshot-testable graphics,
- explicit show state,
- explicit output state,
- deterministic package loading.

## Runtime Choice

The preferred v0 runtime is a TypeScript graphics app:

- Three.js for the first graphics host,
- a browser/Electron/Tauri-style fullscreen path later,
- Node-side output adapters later for Art-Net, sACN, OSC, or MIDI,
- a simulator-first DMX monitor before real hardware output.

## Producer Pal Role

Producer Pal remains the Ableton-side semantic extractor and transport helper.

The compiler should not reverse-engineer Ableton through a graphics runtime. It should keep using Producer Pal to derive phrase ranges, section kinds, energy, visual intent, lighting intent, and transition hints.

## Package Boundary

The show package remains the shared boundary:

```text
show.json
phrases.csv
lighting_cues.csv
laser_dmx_cues.csv
fixture_map.json
runtime_overrides.json
```

The graphics runtime should prefer `show.json` for rich state and use CSV files only where they are useful for operator editing or compatibility.

## DMX and Art-Net

DMX/Art-Net should be kept in mind from the start, but not allowed to slow down the first graphics proof of concept.

The right shape is:

- each phrase produces graphics state,
- each phrase produces output intent,
- the runtime can simulate output frames,
- real Art-Net/sACN adapters can subscribe to the same output frame model later.

## Removed TouchDesigner Surface

The old `touchdesigner/` folder was moved out of the workspace to:

```text
/Users/nlincke/phrase2photon-touchdesigner-attic-20260425
```

It can be treated as reference material if needed, but it is not the active runtime path.
