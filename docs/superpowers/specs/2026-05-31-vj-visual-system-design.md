# Phrase2Photon VJ Visual System Design

## Goal

Vastly improve Phrase2Photon's web graphics so the runtime can drive a curated library of 32 authored electronic-music visuals, mostly abstract and geometry-driven, with approximately 8 clip-chop presets and 24 abstract presets, plus an offline render/export path that produces synced 10-second demo videos from analyzed audio.

The system should optimize first for electronic music such as house, techno, trance, drum and bass, and dubstep. The visuals should be usable across deterministic library playback, cached now-playing songs, and freer live mic VJ behavior without losing artistic intent.

## Constraints And Intent

- The initial 32 presets must be individually authored and intentionally distinct.
- The preset batch should go wide stylistically rather than over-focus on a single narrow aesthetic.
- The system must avoid random-feeling parameter mashups and "rainbow barf" visual behavior.
- Texture-led atmospherics are an important branch, especially for calmer presets, but they are not the whole system.
- Symbolic motifs and Greek/classical architectural references belong to the same family and should appear with intent, not as pasted-on decoration.
- Centered kaleidoscopic geometry, 3D cyber-psychedelic forms, abstract line/symmetry studies, and slow-moving texture fields all belong in the initial preset set.
- Clip-chop presets should optimize first for anime/fantasy fight-scene chopping, with public-domain anime/fantasy or abstract footage as fallback placeholder material.
- Laser/Art-Net output should be ignored for offline rendered demo videos for now; the deliverable is the web-graphics lane only.

## Visual Taxonomy

The first 32 presets should be treated as a curated anthology rather than a parameter sweep.

### Clip-Chop Presets

The system should include approximately 8 clip-chop presets.

These presets should share a source-material lane oriented around anime/fantasy fight-scene chopping, but differ in authored cut grammar, motion treatment, framing, freeze/hold behavior, smear/strobe handling, repetition patterns, and beat-locking style.

When ideal source material is not available, placeholder clip sourcing should fall back in this order:

1. public-domain anime/fantasy-adjacent material
2. abstract action or motion-heavy archive footage
3. more generalized abstract footage

### Abstract Presets

The system should include approximately 24 abstract presets, split roughly evenly between calmer/meditative and harder-driving/percussive looks.

The abstract presets should span multiple visual families:

- texture atmospheres: slow pans, light volumes, drifting fog, refracted surfaces, restrained palette motion
- centered kaleidoscopic geometry: symmetrical, meditative, deep-house-friendly looks with ambient backgrounds
- 3D cyber-psychedelic geometry: tunnels, rings, lattices, crystalline or impossible-space movement
- symbolic/architectural family: original glyphs, sigils, Greek/classical letterform motifs, column/temple/diagram language
- line and symmetry studies: arcs, contour systems, grids, oscillating outlines, clean percussive shape motion

Individual presets may borrow lightly across families, but every preset must still read as a single intentional idea with a clear identity.

## Runtime Behavior

The runtime should support three distinct visual-selection modes.

### 1. Deterministic Show Mode

For compiled library songs and cached now-playing songs, phrase visuals should resolve to fixed preset assignments by default.

- a given phrase should replay the same preset each time unless the VJ changes it
- this is the authored playback path
- per-song visual assignments should be durable and saveable

### 2. Live Rotation Mode

For live mic mode, the system should select freely among compatible presets that match the active phrase type and energy profile.

Examples:

- intros, grooves, and calmer sections should prefer atmospheric, symbolic, or centered-geometry pools
- builds and drops should prefer more aggressive kaleidoscopic, cyber-psychedelic, line/symmetry, or clip-chop pools

The system should feel musically coherent while still giving variety in live mode.

### 3. Manual Performance Mode

The VJ should be able to hard-set a preset live, similar to current cue overrides.

- manual override should win immediately
- override should stay pinned until released
- override should be ephemeral by default unless explicitly saved back into a deterministic show assignment

## Preset Authoring Model

Presets should be first-class authored assets rather than hidden code branches.

Each preset should have stable metadata including:

- `presetId`
- display name
- family/category
- intent notes
- compatibility tags such as `intro`, `groove`, `build`, `drop`, `outro`, `calm`, `percussive`, `symbolic`, `kaleidoscopic`, `clip-chop`
- palette behavior rules
- motion rules
- whether the preset is valid for deterministic playback, live rotation, or both
- any asset dependencies such as clip/video sources

The system should be structured in two layers.

### Preset Catalog

The global library of authored presets, including metadata, thumbnails, notes, and media dependencies.

### Show Visual Assignments

Per-song mappings from phrase IDs to preset IDs, with optional per-song overrides for parameters or palette locks.

This preserves a clean separation between:

- reusable preset definitions
- deterministic song-specific assignments
- ephemeral live overrides

## Relationship To Existing Phrase Metadata

The current phrase metadata such as `motion_style`, `composition`, energy level, dynamics, tension, and notes should still exist as inputs and compatibility hints.

However, authored playback should not rely only on loose text fields. The system should gain explicit preset references so a phrase can durably resolve to a specific preset.

Phrase metadata should be used for:

- default preset suggestion
- compatibility filtering in live mode
- migration and fallback when a show has not yet been manually assigned

## Preset Compatibility Model

Every preset should expose compatibility metadata that allows the runtime to choose presets intentionally rather than randomly.

Minimum compatibility axes:

- phrase suitability: intro, groove, build, drop, outro, breakdown
- energy suitability: low, mid, high, peak
- motion intensity: calm, steady, driving, aggressive
- stylistic tags: texture, symbolic, kaleidoscopic, cyber-psychedelic, linework, clip-chop
- mode suitability: deterministic, live-rotation, or both

Live rotation should filter first by phrase/energy suitability, then by mode suitability, then rotate only within the resulting compatible set.

## Offline Render And Demo Export

The runtime should gain an offline render lane that uses the same preset system as live playback but runs from analyzed audio plus deterministic timeline state to export web-graphics demo videos.

The offline render path should support:

- selecting an analyzed song/show source
- selecting a preset ID
- selecting a fixed 10-second time window
- rendering deterministically so beat sync is stable
- capturing frames from the web-graphics runtime
- muxing those frames with the corresponding 10-second audio slice
- writing the result to a stable demos output directory

For the initial 32-video deliverable, the export flow should be preset-centric:

- each preset gets one authored 10-second demo
- the same analyzed song source may be reused across many presets for comparability
- different time windows may be chosen when needed to better match a preset's intended energy profile

The offline render lane should ignore laser/Art-Net output for now.

## Initial Deliverables

The design is complete only when the implementation produces all of the following:

1. a runtime-capable preset system that can represent and play authored visual presets
2. a preset catalog containing 32 authored presets
3. approximately 24 abstract presets spanning the approved families
4. approximately 8 anime/fantasy-style clip-chop presets with fallback placeholder clip sourcing
5. deterministic phrase-to-preset assignment support for library and cached now-playing playback
6. free compatible preset rotation for live mic mode
7. manual live hard-set override behavior
8. an offline render/export path for synced 10-second demo videos
9. 32 rendered demo videos, one per preset

## Non-Goals For This Phase

- rendering laser/Art-Net output into the exported demo videos
- building a formal vector-laser graphics lane
- making every preset perfectly polished before breadth is established
- collapsing the preset library into a small parameterized sandbox that generates breadth through shallow variation

## Risks And Anti-Patterns

The implementation should actively avoid these failure modes:

- treating 32 presets as superficial parameter variations of one effect
- overusing random combinatorics that erase preset identity
- letting symbolic material become tacky or overly literal
- making calmer presets feel empty instead of intentional
- making percussive presets rely only on color flashing rather than motion grammar
- allowing clip-chop presets to become the default language instead of a distinct family

## Recommended Implementation Direction

The implementation should follow a texture-led but taxonomy-wide preset orchestra:

- texture atmospherics are one major branch and especially important for calmer looks
- symbolic/architectural accents are used intentionally as one family among several
- centered kaleidoscopic geometry, 3D cyber-psychedelia, and line/symmetry studies are mandatory parts of the initial 32
- the runtime should treat the preset library as authored content first and selection logic second

This keeps the system broad, intentional, and musically legible while preserving deterministic playback where needed and freer variation where desired.
