# Now Playing Mode Design

## Goal

Add a third runtime input mode, `now-playing`, that sits between `library` and `mic`.

- Like Mic mode, it should keep producing reactive output continuously so the runtime never goes idle.
- Like Library mode, it should opportunistically upgrade into deterministic show playback once the system has resolved the current track to a local audio file and a compiled show package.
- The mode is macOS-only in v1.

## Scope

v1 includes:

- macOS source detection from Rekordbox, VirtualDJ, and system Now Playing.
- A dedicated local Python orchestration service for source polling, acquisition, cache management, and compile jobs.
- Source-agnostic audio acquisition with fixed priority: disk search, then `scdl`, then `spotdl`.
- Audio-file-first cache identity with duration as a required part of that identity.
- Browser runtime support for `now-playing` mode, including mic-reactive fallback and cue-aware handoff into premade shows.

v1 does not include:

- cross-platform support,
- source-specific acquisition logic after track observation normalization,
- using downloaded assets for end-user playback quality,
- replacing the existing library workflow.

## Architecture

`now-playing` becomes a third peer runtime producer beside `library` and `mic`.

The browser runtime remains responsible for rendering, transport state, and output adapters. A new local Python service owns the long-running local orchestration:

- poll macOS player state and normalize the active observation,
- search local disk and existing show/library metadata,
- run downloader providers when no local asset matches,
- prepare a resolved local audio file,
- reuse or generate a compiled show package under `~/Phrase2PhotonShows`,
- expose a small local API the browser can poll.

This keeps the Vite-side runtime thin and avoids turning the frontend service into a job runner for shell tools, filesystem scans, and compiler invocations.

## Components

### Python Orchestrator

The new service should be packaged with the repo and run hermetically via `uv`.

Responsibilities:

- source polling and observation normalization,
- acquisition-provider scheduling,
- local cache and metadata management,
- show compile job ownership,
- cancellation and obsolescence tracking when the active observation changes,
- HTTP endpoints for current status and ready-show metadata.

### Runtime UI and Producer

The runtime adds:

- `now-playing` as a valid `RuntimeInputMode`,
- a mode button and status surface,
- a producer path that always has a live mic-reactive baseline,
- polling of the Python orchestrator,
- handoff logic from reactive output to premade show playback.

### Shared Show Shape

The renderer, timeline, and output adapters should continue consuming the same broad runtime state shape regardless of source:

- active show,
- current BPM,
- active phrase identity,
- normalized phrase progress,
- audio bands,
- output intents derived from the active phrase.

## Track Observation

The orchestrator normalizes all sources into a common `TrackObservation`.

Required fields:

- `sourceApp`,
- `title`,
- `artist`,
- `durationSeconds`,
- `observedAt`.

Optional fields:

- `album`,
- source-native file/path hints,
- source-native identifiers,
- confidence notes.

After normalization, acquisition is source-agnostic. Rekordbox being active may make a local-disk hit more likely, but it should not change provider order or cache identity rules.

## Acquisition Pipeline

Provider order is fixed for every observation:

1. disk search,
2. `scdl`,
3. `spotdl`.

### Disk Search

Search in this order:

1. existing `~/Phrase2PhotonShows` metadata and generated caches,
2. `/Volumes/MUSIC`,
3. any source-provided direct file hint if available.

Disk candidates should be filtered by metadata similarity and measured duration before acceptance.

### Remote Providers

`scdl` and `spotdl` should be wrapped as providers behind a common interface.

Provider contract:

- accept a normalized `TrackObservation`,
- return zero or more candidates with metadata confidence and duration confidence,
- avoid downloading candidates whose reported duration is already outside the configured tolerance when provider metadata allows prefiltering,
- materialize a local audio file only for candidates that pass the pre-download duration gate.

The repository should bring the provider toolchain with it so a fresh checkout can run without separate operator installation.

## Audio Identity and Cache Keys

Cache identity is audio-file-first, not source-app-first.

Identity inputs:

- normalized title,
- normalized artist,
- measured duration,
- prepared local audio fingerprint or hash.

Duration is mandatory. Different edits, radio versions, extended versions, and long-form DJ sets must not collapse into the same generated show if their durations differ materially.

The same song coming from Spotify, Apple Music, SoundCloud, Rekordbox, or VirtualDJ should hit the same cache entry only when it resolves to the same effective audio identity.

## Cache Layout

v1 stores generated/downloaded working assets under `~/Phrase2PhotonShows`.

Suggested structure:

```text
~/Phrase2PhotonShows/
  library.json
  now-playing/
    tracks/
      <audio-identity-slug>/
        source.json
        acquisition.json
        prepared-audio.wav
        prepared-audio.json
        show/
          show.json
          phrases.csv
          lighting_cues.csv
          laser_dmx_cues.csv
```

`acquisition.json` should capture how the asset was resolved and from which provider. `prepared-audio.json` should include measured duration, fingerprint/hash, and any normalization details needed for later cache hits.

If a generated show proves useful later, it can be promoted into the main library workflow without changing the v1 cache design.

## Runtime Behavior

`now-playing` mode always keeps a mic-reactive baseline active unless a ready premade show is actively driving output.

Behavior rules:

- if no confirmed audio match and compiled show are ready, remain on reactive output,
- if a cached or newly generated show becomes ready, arm it immediately,
- if the runtime is currently in reactive-only output, switch into the ready show immediately,
- if the runtime is currently playing a premade show, preserve phrase continuity by default and switch at the next cue start,
- if the new show becomes ready within 2 seconds after the most recent cue-start edge, switch immediately instead of waiting a full cue,
- if the active observation changes, any obsolete in-flight acquisition or compile work should be cancelled or ignored unless it still resolves to the same audio identity.

The user-visible effect should be that Now Playing feels immediate, but deterministic show takeovers still respect premade phrase structure when one is already active.

## Handoff State Machine

The active-output state machine is:

1. `reactive_fallback`,
2. `premade_armed`,
3. `premade_active`.

Transitions:

- `reactive_fallback -> premade_armed` when a show becomes ready,
- `premade_armed -> premade_active` on immediate-switch eligibility or a valid cue boundary,
- `premade_active -> reactive_fallback` when confidence is lost, the observation changes without a ready replacement, or the active premade context is no longer valid.

The runtime should track the last cue-start timestamp so it can enforce the 2-second grace-window rule deterministically.

## Error Handling

The system should fail soft and visibly.

Rules:

- detection errors should not stop the runtime; the last known observation may be shown as stale while reactive output continues,
- acquisition-provider failures should be recorded per provider and surfaced in status without crashing the mode,
- a duration mismatch is a hard rejection, not a warning,
- compile failures should leave the runtime on reactive output and expose actionable error text,
- stale jobs should never be allowed to hijack output after a newer observation has superseded them,
- if no provider succeeds, the mode should remain usable as a smarter Mic mode rather than entering a broken state.

## API Shape

The Python service should expose a minimal local API such as:

- `GET /api/now-playing/status`
- `POST /api/now-playing/rescan` for manual debug forcing

The status payload should include:

- current observation,
- active acquisition attempt,
- provider results,
- current mode state,
- whether a show is armed or active,
- URLs or local identifiers for the resolved prepared audio and compiled show,
- timestamps needed for handoff decisions.

The runtime should poll rather than hold a complex bidirectional session in v1.

## Testing

The implementation should be driven by tests before production code.

### Python Service Tests

- source normalization from mocked Rekordbox, VirtualDJ, and macOS Now Playing inputs,
- provider ordering and early exit on successful disk match,
- duration-gate rejection of mismatched candidates,
- cache-hit reuse for the same audio identity across different source apps,
- cancellation or obsolescence behavior when observations change,
- show-generation reuse versus compile-on-miss behavior.

### Runtime Tests

- `RuntimeInputMode` accepts `now-playing`,
- Now Playing mode stays on reactive output when no show is ready,
- immediate switch from reactive fallback into a ready show,
- cue-boundary handoff when a premade show is already active,
- 2-second grace-window immediate takeover after a cue edge,
- stale ready events from superseded observations are ignored.

### Integration Tests

- orchestrator status drives runtime mode transitions correctly,
- a cached generated show is reused immediately on repeat playback,
- a mismatched-duration provider candidate never triggers a useless download path.

## Implementation Notes

- Prefer narrow interfaces between the runtime and the Python service so the browser does not learn provider-specific logic.
- Keep acquisition provider implementations interchangeable behind one scheduler.
- Treat generated Now Playing shows as local working assets first; promotion into curated library entries can remain a later workflow.
- Keep the first release operationally honest: if the system is still resolving a track, it should clearly show that it is on reactive fallback rather than pretending deterministic playback is active.
