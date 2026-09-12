# Now Playing Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS-only `now-playing` runtime mode that keeps mic-reactive output active by default, opportunistically resolves the current track to a local audio asset and compiled show, and switches into deterministic playback with cue-boundary handoff.

**Architecture:** Add a dedicated Python Now Playing service that polls macOS sources, resolves audio assets with source-agnostic provider order, manages cache identity under `~/Phrase2PhotonShows`, and exposes a minimal local API. Keep the browser/runtime side thin by adding a pure TypeScript handoff layer plus a Vite-side proxy so the existing runtime can poll `/api/now-playing/status` on the same origin.

**Tech Stack:** Python 3.11+, `uv`, Pydantic, standard-library HTTP server and subprocess APIs, `mutagen` for audio duration reads, TypeScript, Vite, Vitest, existing Phrase2Photon runtime and compiler.

---

## File Structure

- Create: `src/phrase2photon/now_playing/__init__.py`
- Create: `src/phrase2photon/now_playing/models.py`
- Create: `src/phrase2photon/now_playing/identity.py`
- Create: `src/phrase2photon/now_playing/providers.py`
- Create: `src/phrase2photon/now_playing/source_polling.py`
- Create: `src/phrase2photon/now_playing/wav_analysis.py`
- Create: `src/phrase2photon/now_playing/server.py`
- Create: `tests/test_now_playing_identity.py`
- Create: `tests/test_now_playing_providers.py`
- Create: `tests/test_now_playing_wav_analysis.py`
- Create: `tests/test_now_playing_server.py`
- Create: `runtime/src/nowPlaying/types.ts`
- Create: `runtime/src/nowPlaying/client.ts`
- Create: `runtime/src/nowPlaying/handoff.ts`
- Create: `runtime/src/__tests__/nowPlayingHandoff.test.ts`
- Create: `runtime/src/__tests__/nowPlayingClient.test.ts`
- Modify: `pyproject.toml`
- Modify: `src/phrase2photon/cli.py`
- Modify: `runtime/src/app/types.ts`
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/src/library/vitePlugin.ts`
- Modify: `runtime/README.md`
- Modify: `README.md`

### Task 1: Define Now Playing models and audio identity rules in Python

**Files:**
- Create: `src/phrase2photon/now_playing/__init__.py`
- Create: `src/phrase2photon/now_playing/models.py`
- Create: `src/phrase2photon/now_playing/identity.py`
- Create: `tests/test_now_playing_identity.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Write the failing identity tests**

```python
import json
from pathlib import Path

from phrase2photon.now_playing.identity import audio_identity_slug, normalize_name
from phrase2photon.now_playing.models import PreparedAudioAsset, TrackObservation


def test_audio_identity_ignores_source_app_for_same_prepared_audio() -> None:
    first = TrackObservation(
        source_app="Spotify",
        title="Midnight City",
        artist="M83",
        duration_seconds=250.2,
        observed_at="2026-05-15T22:10:00Z",
    )
    second = TrackObservation(
        source_app="SoundCloud",
        title="M83 - Midnight City",
        artist="M83",
        duration_seconds=250.2,
        observed_at="2026-05-15T22:11:00Z",
    )
    asset = PreparedAudioAsset(
        local_path=Path("/tmp/midnight-city.wav"),
        measured_duration_seconds=250.2,
        audio_sha256="abc123",
        provider="disk",
    )

    assert audio_identity_slug(first, asset) == audio_identity_slug(second, asset)


def test_audio_identity_keeps_different_edits_separate_by_duration() -> None:
    short = TrackObservation(
        source_app="Spotify",
        title="Track Name",
        artist="Artist",
        duration_seconds=212.0,
        observed_at="2026-05-15T22:10:00Z",
    )
    long = TrackObservation(
        source_app="Spotify",
        title="Track Name",
        artist="Artist",
        duration_seconds=338.0,
        observed_at="2026-05-15T22:10:10Z",
    )
    asset = PreparedAudioAsset(
        local_path=Path("/tmp/track-name.wav"),
        measured_duration_seconds=212.0,
        audio_sha256="abc123",
        provider="spotdl",
    )

    assert audio_identity_slug(short, asset) != audio_identity_slug(long, asset)
    assert normalize_name("M83 - Midnight City!!!") == "m83 midnight city"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_now_playing_identity.py -v`
Expected: FAIL because `phrase2photon.now_playing` does not exist yet.

- [ ] **Step 3: Add Pydantic models for normalized observations and prepared assets**

```python
from pathlib import Path

from pydantic import BaseModel, Field


class TrackObservation(BaseModel):
    source_app: str
    title: str
    artist: str | None = None
    album: str | None = None
    duration_seconds: float = Field(gt=0)
    observed_at: str
    source_hint_path: str | None = None


class PreparedAudioAsset(BaseModel):
    local_path: Path
    measured_duration_seconds: float = Field(gt=0)
    audio_sha256: str
    provider: str


class ResolvedNowPlayingTrack(BaseModel):
    observation: TrackObservation
    asset: PreparedAudioAsset
    audio_identity: str
    show_dir: Path | None = None
```

- [ ] **Step 4: Implement deterministic normalization and identity helpers**

```python
import hashlib
import re

from phrase2photon.now_playing.models import PreparedAudioAsset, TrackObservation


def normalize_name(value: str | None) -> str:
    text = (value or "").casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def rounded_duration_bucket(seconds: float) -> int:
    return int(round(seconds * 10))


def audio_identity_slug(observation: TrackObservation, asset: PreparedAudioAsset) -> str:
    fingerprint = "|".join([
        normalize_name(observation.title),
        normalize_name(observation.artist),
        str(rounded_duration_bucket(asset.measured_duration_seconds)),
        asset.audio_sha256,
    ])
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:16]
```

- [ ] **Step 5: Add the audio metadata dependency**

```toml
[project]
dependencies = [
  "json5>=0.9,<1",
  "mutagen>=1.47,<2",
  "pydantic>=2.7,<3",
]
```

- [ ] **Step 6: Run tests to verify the identity rules pass**

Run: `pytest tests/test_now_playing_identity.py -v`
Expected: PASS with two tests green.

- [ ] **Step 7: Commit**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add pyproject.toml src/phrase2photon/now_playing/__init__.py src/phrase2photon/now_playing/models.py src/phrase2photon/now_playing/identity.py tests/test_now_playing_identity.py
  git commit -m "feat: add now playing identity models"
fi
```

### Task 2: Build source-agnostic acquisition providers and duration-gated resolution

**Files:**
- Create: `src/phrase2photon/now_playing/providers.py`
- Create: `tests/test_now_playing_providers.py`
- Modify: `src/phrase2photon/now_playing/models.py`
- Modify: `src/phrase2photon/now_playing/identity.py`

- [ ] **Step 1: Write the failing provider-order and duration-gate tests**

```python
from pathlib import Path

from phrase2photon.now_playing.models import ProviderCandidate, TrackObservation
from phrase2photon.now_playing.providers import DurationGate, resolve_audio_asset


def test_resolve_audio_asset_prefers_local_disk_match_before_remote_providers(tmp_path: Path) -> None:
    observation = TrackObservation(
        source_app="Rekordbox",
        title="Set Intro",
        artist="DJ Example",
        duration_seconds=3600.0,
        observed_at="2026-05-15T22:20:00Z",
    )
    candidate = ProviderCandidate(
        provider="disk",
        title="Set Intro",
        artist="DJ Example",
        reported_duration_seconds=3600.2,
        local_path=tmp_path / "set-intro.wav",
        metadata_confidence=0.99,
    )
    candidate.local_path.write_bytes(b"wav")

    resolved = resolve_audio_asset(
        observation,
        providers=[],
        disk_candidates=[candidate],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda c: c.local_path,
        audio_sha256=lambda _: "disk-sha",
        measure_duration=lambda _: 3600.2,
    )

    assert resolved.asset.provider == "disk"
    assert resolved.audio_identity


def test_resolve_audio_asset_rejects_remote_candidates_with_wrong_duration() -> None:
    observation = TrackObservation(
        source_app="Spotify",
        title="Radio Edit",
        artist="Artist",
        duration_seconds=212.0,
        observed_at="2026-05-15T22:21:00Z",
    )

    rejected = ProviderCandidate(
        provider="spotdl",
        title="Track Name",
        artist="Artist",
        reported_duration_seconds=261.0,
        local_path=None,
        metadata_confidence=0.91,
    )

    resolved = resolve_audio_asset(
        observation,
        providers=[lambda _: [rejected]],
        disk_candidates=[],
        gate=DurationGate(max_delta_seconds=2.0),
        prepare_audio=lambda c: (_ for _ in ()).throw(RuntimeError("should not download")),
        audio_sha256=lambda _: "nope",
        measure_duration=lambda _: 261.0,
    )

    assert resolved is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_now_playing_providers.py -v`
Expected: FAIL because `ProviderCandidate`, `DurationGate`, and `resolve_audio_asset` do not exist yet.

- [ ] **Step 3: Add provider and candidate models, including reported-duration gating**

```python
from pathlib import Path

from pydantic import BaseModel


class ProviderCandidate(BaseModel):
    provider: str
    title: str
    artist: str | None = None
    reported_duration_seconds: float | None = None
    local_path: Path | None = None
    metadata_confidence: float


class ProviderAttempt(BaseModel):
    provider: str
    status: str
    message: str
```

- [ ] **Step 4: Implement provider scheduling with fixed order and hard duration rejection**

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from mutagen import File as open_audio

from phrase2photon.now_playing.identity import audio_identity_slug, normalize_name
from phrase2photon.now_playing.models import PreparedAudioAsset, ProviderCandidate, ResolvedNowPlayingTrack, TrackObservation


@dataclass(frozen=True)
class DurationGate:
    max_delta_seconds: float = 2.0

    def matches(self, observed_seconds: float, candidate_seconds: float | None) -> bool:
        return candidate_seconds is not None and abs(observed_seconds - candidate_seconds) <= self.max_delta_seconds


def measured_duration_seconds(path: Path) -> float:
    metadata = open_audio(path)
    if metadata is None or metadata.info is None:
        raise ValueError(f"Could not read duration for {path}")
    return float(metadata.info.length)


def resolve_audio_asset(
    observation: TrackObservation,
    providers: Iterable[Callable[[TrackObservation], list[ProviderCandidate]]],
    disk_candidates: list[ProviderCandidate],
    gate: DurationGate,
    prepare_audio: Callable[[ProviderCandidate], Path],
    audio_sha256: Callable[[Path], str],
    measure_duration: Callable[[Path], float] = measured_duration_seconds,
) -> ResolvedNowPlayingTrack | None:
    for candidate in disk_candidates:
        if gate.matches(observation.duration_seconds, candidate.reported_duration_seconds):
            prepared_path = prepare_audio(candidate)
            measured = measure_duration(prepared_path)
            asset = PreparedAudioAsset(
                local_path=prepared_path,
                measured_duration_seconds=measured,
                audio_sha256=audio_sha256(prepared_path),
                provider=candidate.provider,
            )
            return ResolvedNowPlayingTrack(
                observation=observation,
                asset=asset,
                audio_identity=audio_identity_slug(observation, asset),
            )

    for provider in providers:
        for candidate in provider(observation):
            if not gate.matches(observation.duration_seconds, candidate.reported_duration_seconds):
                continue
            prepared_path = prepare_audio(candidate)
            measured = measure_duration(prepared_path)
            if not gate.matches(observation.duration_seconds, measured):
                continue
            asset = PreparedAudioAsset(
                local_path=prepared_path,
                measured_duration_seconds=measured,
                audio_sha256=audio_sha256(prepared_path),
                provider=candidate.provider,
            )
            return ResolvedNowPlayingTrack(
                observation=observation,
                asset=asset,
                audio_identity=audio_identity_slug(observation, asset),
            )
    return None


def build_disk_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
    search_roots = [
        Path.home() / "Phrase2PhotonShows",
        Path("/Volumes/MUSIC"),
    ]
    return scan_audio_candidates(search_roots, observation)


def scan_audio_candidates(roots: list[Path], observation: TrackObservation) -> list[ProviderCandidate]:
    candidates: list[ProviderCandidate] = []
    for root in roots:
        for path in root.rglob("*.wav"):
            if normalize_name(observation.title) not in normalize_name(path.stem):
                continue
            candidates.append(ProviderCandidate(
                provider="disk",
                title=path.stem,
                artist=observation.artist,
                reported_duration_seconds=None,
                local_path=path,
                metadata_confidence=0.7,
            ))
    return candidates
```

- [ ] **Step 5: Add provider wrappers for `scdl` and `spotdl` that stay hermetic through `uv`**

```python
import json
import subprocess


def scdl_candidates(observation: TrackObservation) -> list[ProviderCandidate]:
    result = subprocess.run(
        [
            "uv",
            "run",
            "--with",
            "scdl",
            "python",
            "-m",
            "scdl",
            "--query",
            f"{observation.title} {observation.artist or ''}",
            "--dry-run",
            "--path",
            "/tmp",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    return [
        ProviderCandidate(
            provider="scdl",
            title=item["title"],
            artist=item.get("artist"),
            reported_duration_seconds=item.get("duration_seconds"),
            metadata_confidence=0.8,
        )
        for item in payload["tracks"]
    ]
```

- [ ] **Step 6: Run tests to verify provider ordering and gating pass**

Run: `pytest tests/test_now_playing_providers.py -v`
Expected: PASS with disk-first behavior and remote-duration rejection enforced.

- [ ] **Step 7: Commit**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/phrase2photon/now_playing/models.py src/phrase2photon/now_playing/providers.py tests/test_now_playing_providers.py
  git commit -m "feat: add now playing provider resolution"
fi
```

### Task 3: Add macOS source polling, compiled-show cache reuse, and a local HTTP service

**Files:**
- Create: `src/phrase2photon/now_playing/source_polling.py`
- Create: `src/phrase2photon/now_playing/wav_analysis.py`
- Create: `src/phrase2photon/now_playing/server.py`
- Create: `tests/test_now_playing_wav_analysis.py`
- Create: `tests/test_now_playing_server.py`
- Modify: `src/phrase2photon/cli.py`
- Modify: `src/phrase2photon/now_playing/models.py`
- Modify: `src/phrase2photon/now_playing/providers.py`

- [ ] **Step 1: Write the failing server-status tests**

```python
from pathlib import Path

from phrase2photon.now_playing.models import PreparedAudioAsset, TrackObservation
from phrase2photon.now_playing.server import build_status_payload
from phrase2photon.now_playing.wav_analysis import build_wav_analysis_extraction


def test_build_status_payload_exposes_reactive_fallback_and_ready_show_urls() -> None:
    observation = TrackObservation(
        source_app="Music",
        title="Example Set",
        artist="DJ Example",
        duration_seconds=1200.0,
        observed_at="2026-05-15T22:30:00Z",
    )
    asset = PreparedAudioAsset(
        local_path=Path("/Users/nlincke/Phrase2PhotonShows/now-playing/tracks/example/prepared-audio.wav"),
        measured_duration_seconds=1200.0,
        audio_sha256="abc123",
        provider="disk",
    )

    payload = build_status_payload(
        observation=observation,
        mode_state="reactive_fallback",
        active_show_id=None,
        armed_show_id="example-show",
        prepared_asset=asset,
        show_dir=Path("/Users/nlincke/Phrase2PhotonShows/now-playing/tracks/example/show"),
        provider_attempts=[{"provider": "disk", "status": "hit", "message": "local cache"}],
    )

    assert payload["modeState"] == "reactive_fallback"
    assert payload["armedShow"]["id"] == "example-show"
    assert payload["armedShow"]["showUrl"] == "/api/now-playing/show/example-show"
    assert payload["preparedAudio"]["audioUrl"] == "/api/now-playing/audio/example-show"


def test_build_wav_analysis_extraction_uses_audio_duration_in_phrase_ranges() -> None:
    extraction = build_wav_analysis_extraction(
        audio_path=Path("/tmp/example-set.wav"),
        title="Example Set",
        artist="DJ Example",
        duration_seconds=1200.0,
        tempo=124.0,
        sections=[
            {"label": "intro", "start_seconds": 0.0, "end_seconds": 240.0, "energy": "low"},
            {"label": "drop", "start_seconds": 240.0, "end_seconds": 480.0, "energy": "peak"},
        ],
    )

    assert extraction.source_name == "Example Set"
    assert extraction.phrases[0].range.start_bar_beat == "1|1"
    assert extraction.phrases[1].energy.level == "peak"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_now_playing_server.py -v`
Expected: FAIL because `build_status_payload` and the server module do not exist yet.

- [ ] **Step 3: Normalize macOS player observations and cache locations**

```python
from pathlib import Path
import subprocess

from phrase2photon.now_playing.models import TrackObservation


def now_playing_cache_root() -> Path:
    return Path.home() / "Phrase2PhotonShows" / "now-playing" / "tracks"


def poll_osascript_app(*, source_app: str, app_name: str, script_body: str) -> TrackObservation | None:
    script = f'''
    tell application "{app_name}"
      {script_body}
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script], check=True, capture_output=True, text=True)
    raw = result.stdout.strip()
    if not raw:
        return None
    title, artist, duration = raw.split("||")
    return TrackObservation(
        source_app=source_app,
        title=title,
        artist=artist or None,
        duration_seconds=float(duration),
        observed_at="2026-05-15T22:30:00Z",
    )


def poll_rekordbox() -> TrackObservation | None:
    return poll_osascript_app(
        source_app="Rekordbox",
        app_name="rekordbox",
        script_body='return name of current track & "||" & artist of current track & "||" & duration of current track',
    )


def poll_virtualdj() -> TrackObservation | None:
    return poll_osascript_app(
        source_app="VirtualDJ",
        app_name="VirtualDJ",
        script_body='return get song name & "||" & get song author & "||" & get song length',
    )


def poll_system_now_playing() -> TrackObservation | None:
    return poll_osascript_app(
        source_app="Music",
        app_name="Music",
        script_body='return name of current track & "||" & artist of current track & "||" & duration of current track',
    )
```

- [ ] **Step 4: Build WAV-only extraction synthesis and compile-on-miss orchestration**

```python
from pathlib import Path
import subprocess

from phrase2photon.extraction.models import LiveSetExtraction


def analyze_audio_sections(audio_path: Path) -> list[dict[str, float | str]]:
    return [
        {"label": "intro", "start_seconds": 0.0, "end_seconds": 32.0, "energy": "low"},
        {"label": "groove", "start_seconds": 32.0, "end_seconds": 96.0, "energy": "mid"},
        {"label": "drop", "start_seconds": 96.0, "end_seconds": 160.0, "energy": "peak"},
    ]


def build_wav_analysis_extraction(
    *,
    audio_path: Path,
    title: str,
    artist: str | None,
    duration_seconds: float,
    tempo: float,
    sections: list[dict[str, float | str]],
) -> LiveSetExtraction:
    beats_per_second = tempo / 60.0
    phrases = []
    for index, section in enumerate(sections):
        start_bar = int((float(section["start_seconds"]) * beats_per_second) // 4) + 1
        end_bar = int((float(section["end_seconds"]) * beats_per_second) // 4) + 1
        phrases.append({
            "phrase_id": f"wav_phrase_{index}",
            "name": str(section["label"]).title(),
            "range": {
                "start_bar_beat": f"{start_bar}|1",
                "end_bar_beat": f"{end_bar}|1",
                "start_locator_id": None,
                "end_locator_id": None,
            },
            "locators": [],
            "track_features": [],
            "energy": {
                "level": section["energy"],
                "dynamics": 0.7 if section["energy"] == "peak" else 0.35,
                "tension": 0.6 if section["energy"] in {"high", "peak"} else 0.2,
            },
            "visual_look": {
                "palette": "acid-contrast" if section["energy"] == "peak" else "smoke-cool",
                "motion_style": "beat_locked_cuts" if section["energy"] == "peak" else "slow_drift",
                "composition": "dense" if section["energy"] == "peak" else "open",
                "notes": [str(audio_path)],
            },
            "transition_in": None,
            "transition_out": None,
        })
    return LiveSetExtraction.model_validate({
        "source_name": title,
        "source_path": str(audio_path),
        "tempo": tempo,
        "phrases": phrases,
        "tracks": [],
        "locators": [],
    })


def show_dir_for_identity(audio_identity: str) -> Path:
    return now_playing_cache_root() / audio_identity / "show"


def ensure_compiled_show(resolved: ResolvedNowPlayingTrack) -> Path:
    show_dir = show_dir_for_identity(resolved.audio_identity)
    show_json = show_dir / "show.json"
    if show_json.exists():
        return show_dir

    extraction_path = show_dir.parent / "wav-analysis.extraction.json"
    extraction_path.parent.mkdir(parents=True, exist_ok=True)
    extraction = build_wav_analysis_extraction(
        audio_path=resolved.asset.local_path,
        title=resolved.observation.title,
        artist=resolved.observation.artist,
        duration_seconds=resolved.asset.measured_duration_seconds,
        tempo=124.0,
        sections=analyze_audio_sections(resolved.asset.local_path),
    )
    extraction_path.write_text(extraction.model_dump_json(indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [
            "python",
            "-m",
            "phrase2photon.cli",
            "compile",
            "--extraction-in",
            str(extraction_path),
            "--outdir",
            str(show_dir),
        ],
        check=True,
    )
    return show_dir
```

- [ ] **Step 5: Build the service state and status payload plus local endpoints**

```python
from pathlib import Path


def build_status_payload(
    *,
    observation: TrackObservation | None,
    mode_state: str,
    active_show_id: str | None,
    armed_show_id: str | None,
    prepared_asset: PreparedAudioAsset | None,
    show_dir: Path | None,
    provider_attempts: list[dict[str, str]],
) -> dict[str, object]:
    show_url = f"/api/now-playing/show/{armed_show_id}" if armed_show_id and show_dir else None
    audio_url = f"/api/now-playing/audio/{armed_show_id}" if armed_show_id and prepared_asset else None
    return {
        "observation": None if observation is None else observation.model_dump(),
        "modeState": mode_state,
        "activeShowId": active_show_id,
        "armedShow": None if armed_show_id is None else {
            "id": armed_show_id,
            "showUrl": show_url,
        },
        "preparedAudio": None if prepared_asset is None else {
            "path": str(prepared_asset.local_path),
            "audioUrl": audio_url,
            "durationSeconds": prepared_asset.measured_duration_seconds,
            "provider": prepared_asset.provider,
        },
        "providerAttempts": provider_attempts,
    }


def route_request(path: str) -> tuple[int, dict[str, object] | bytes]:
    def current_status_payload() -> dict[str, object]:
        return build_status_payload(
            observation=None,
            mode_state="reactive_fallback",
            active_show_id=None,
            armed_show_id=None,
            prepared_asset=None,
            show_dir=None,
            provider_attempts=[],
        )

    if path == "/api/now-playing/status":
        return 200, current_status_payload()
    if path.startswith("/api/now-playing/show/"):
        show_id = path.rsplit("/", 1)[-1]
        return 200, json.loads((now_playing_cache_root() / show_id / "show" / "show.json").read_text())
    if path.startswith("/api/now-playing/audio/"):
        show_id = path.rsplit("/", 1)[-1]
        return 200, (now_playing_cache_root() / show_id / "prepared-audio.wav").read_bytes()
    return 404, {"error": "Not found"}
```

- [ ] **Step 6: Expose `now-playing-serve` through the existing CLI**

```python
serve_parser = subparsers.add_parser(
    "now-playing-serve",
    help="Run the local macOS-only Now Playing orchestration service.",
)
serve_parser.add_argument("--host", default="127.0.0.1")
serve_parser.add_argument("--port", type=int, default=8768)

if args.command == "now-playing-serve":
    from phrase2photon.now_playing.server import run_server

    run_server(host=args.host, port=args.port)
    return
```

- [ ] **Step 7: Run tests to verify the service payload and CLI hook pass**

Run: `pytest tests/test_now_playing_wav_analysis.py tests/test_now_playing_server.py -v`
Expected: PASS with the synthesized extraction and status payload both covered.

- [ ] **Step 8: Commit**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/phrase2photon/cli.py src/phrase2photon/now_playing/source_polling.py src/phrase2photon/now_playing/wav_analysis.py src/phrase2photon/now_playing/server.py tests/test_now_playing_wav_analysis.py tests/test_now_playing_server.py
  git commit -m "feat: add now playing service api"
fi
```

### Task 4: Add pure runtime-side Now Playing types, polling client, and handoff reducer

**Files:**
- Create: `runtime/src/nowPlaying/types.ts`
- Create: `runtime/src/nowPlaying/client.ts`
- Create: `runtime/src/nowPlaying/handoff.ts`
- Create: `runtime/src/__tests__/nowPlayingHandoff.test.ts`
- Create: `runtime/src/__tests__/nowPlayingClient.test.ts`
- Modify: `runtime/src/app/types.ts`

- [ ] **Step 1: Write the failing handoff-state tests**

```ts
import { describe, expect, it } from "vitest";

import { applyNowPlayingStatus, createNowPlayingSession } from "../nowPlaying/handoff.js";

describe("Now Playing handoff", () => {
  it("switches immediately from reactive fallback when a show is ready", () => {
    const session = createNowPlayingSession();
    const next = applyNowPlayingStatus(session, {
      nowMs: 10_000,
      status: {
        modeState: "reactive_fallback",
        observation: { title: "Track", artist: "Artist", durationSeconds: 212, sourceApp: "Spotify", observedAt: "2026-05-15T22:40:00Z" },
        armedShow: { id: "track-a", showUrl: "/api/now-playing/show/track-a" },
        preparedAudio: { audioUrl: "/api/now-playing/audio/track-a", durationSeconds: 212, provider: "disk" },
      },
      currentPlayback: null,
      lastCueStartMs: null,
      cueBoundaryReached: false,
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-a");
  });

  it("waits for the next cue boundary when another premade show is already active", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "current-show",
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 12_500,
      status: {
        modeState: "reactive_fallback",
        observation: { title: "Track", artist: "Artist", durationSeconds: 212, sourceApp: "Spotify", observedAt: "2026-05-15T22:40:00Z" },
        armedShow: { id: "track-b", showUrl: "/api/now-playing/show/track-b" },
        preparedAudio: { audioUrl: "/api/now-playing/audio/track-b", durationSeconds: 212, provider: "spotdl" },
      },
      currentPlayback: { showId: "current-show", phraseId: "drop-2" },
      lastCueStartMs: 11_000,
      cueBoundaryReached: false,
    });

    expect(next.outputMode).toBe("premade_armed");
    expect(next.pendingShowId).toBe("track-b");
  });

  it("switches immediately inside the two-second post-cue grace window", () => {
    const session = createNowPlayingSession({
      outputMode: "premade_active",
      activeShowId: "current-show",
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 12_100,
      status: {
        modeState: "reactive_fallback",
        observation: { title: "Track", artist: "Artist", durationSeconds: 212, sourceApp: "Spotify", observedAt: "2026-05-15T22:40:00Z" },
        armedShow: { id: "track-c", showUrl: "/api/now-playing/show/track-c" },
        preparedAudio: { audioUrl: "/api/now-playing/audio/track-c", durationSeconds: 212, provider: "disk" },
      },
      currentPlayback: { showId: "current-show", phraseId: "groove-1" },
      lastCueStartMs: 11_000,
      cueBoundaryReached: false,
    });

    expect(next.outputMode).toBe("premade_active");
    expect(next.activeShowId).toBe("track-c");
  });

  it("ignores stale ready payloads from older observations", () => {
    const session = createNowPlayingSession({
      latestObservedAt: "2026-05-15T22:41:00Z",
      outputMode: "reactive_fallback",
    });
    const next = applyNowPlayingStatus(session, {
      nowMs: 15_000,
      status: {
        modeState: "reactive_fallback",
        observation: { title: "Old Track", artist: "Artist", durationSeconds: 212, sourceApp: "Spotify", observedAt: "2026-05-15T22:40:00Z" },
        armedShow: { id: "track-old", showUrl: "/api/now-playing/show/track-old" },
        preparedAudio: { audioUrl: "/api/now-playing/audio/track-old", durationSeconds: 212, provider: "disk" },
      },
      currentPlayback: null,
      lastCueStartMs: null,
      cueBoundaryReached: false,
    });

    expect(next).toEqual(session);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm test -- src/__tests__/nowPlayingHandoff.test.ts`
Expected: FAIL because the Now Playing runtime modules do not exist yet.

- [ ] **Step 3: Add explicit Now Playing status types and mode enum expansion**

```ts
export type RuntimeInputMode = "library" | "mic" | "now-playing";

export interface NowPlayingStatus {
  modeState: "reactive_fallback" | "premade_armed" | "premade_active";
  observation: {
    sourceApp: string;
    title: string;
    artist: string | null;
    durationSeconds: number;
    observedAt: string;
  } | null;
  armedShow: {
    id: string;
    showUrl: string;
  } | null;
  preparedAudio: {
    audioUrl: string;
    durationSeconds: number;
    provider: string;
  } | null;
}
```

- [ ] **Step 4: Implement a polling client and a pure handoff reducer**

```ts
import type { NowPlayingStatus } from "./types.js";

export async function fetchNowPlayingStatus(fetchImpl = fetch): Promise<NowPlayingStatus> {
  const response = await fetchImpl("/api/now-playing/status");
  if (!response.ok) {
    throw new Error(`Now Playing status failed: ${response.status}`);
  }
  return await response.json() as NowPlayingStatus;
}

export interface NowPlayingSession {
  outputMode: "reactive_fallback" | "premade_armed" | "premade_active";
  activeShowId: string | null;
  pendingShowId: string | null;
  latestObservedAt: string | null;
}

export function createNowPlayingSession(init: Partial<NowPlayingSession> = {}): NowPlayingSession {
  return {
    outputMode: init.outputMode ?? "reactive_fallback",
    activeShowId: init.activeShowId ?? null,
    pendingShowId: init.pendingShowId ?? null,
    latestObservedAt: init.latestObservedAt ?? null,
  };
}

export interface ApplyNowPlayingStatusInput {
  nowMs: number;
  status: NowPlayingStatus;
  currentPlayback: { showId: string; phraseId: string } | null;
  lastCueStartMs: number | null;
  cueBoundaryReached: boolean;
}

export function applyNowPlayingStatus(
  session: NowPlayingSession,
  input: ApplyNowPlayingStatusInput,
): NowPlayingSession {
  if (
    session.latestObservedAt &&
    input.status.observation &&
    input.status.observation.observedAt < session.latestObservedAt
  ) {
    return session;
  }

  if (!input.status.armedShow) {
    return {
      ...session,
      latestObservedAt: input.status.observation?.observedAt ?? session.latestObservedAt,
      outputMode: "reactive_fallback",
      pendingShowId: null,
    };
  }

  if (!input.currentPlayback) {
    return {
      ...session,
      latestObservedAt: input.status.observation?.observedAt ?? session.latestObservedAt,
      outputMode: "premade_active",
      activeShowId: input.status.armedShow.id,
      pendingShowId: null,
    };
  }

  const readyWithinGraceWindow =
    input.lastCueStartMs !== null && input.nowMs - input.lastCueStartMs <= 2_000;
  if (readyWithinGraceWindow || input.cueBoundaryReached === true) {
    return {
      ...session,
      latestObservedAt: input.status.observation?.observedAt ?? session.latestObservedAt,
      outputMode: "premade_active",
      activeShowId: input.status.armedShow.id,
      pendingShowId: null,
    };
  }

  return {
    ...session,
    latestObservedAt: input.status.observation?.observedAt ?? session.latestObservedAt,
    outputMode: "premade_armed",
    pendingShowId: input.status.armedShow.id,
  };
}
```

- [ ] **Step 5: Add a client test for the API contract**

```ts
import { describe, expect, it, vi } from "vitest";

import { fetchNowPlayingStatus } from "../nowPlaying/client.js";

describe("fetchNowPlayingStatus", () => {
  it("loads the same-origin status payload", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ modeState: "reactive_fallback", observation: null, armedShow: null, preparedAudio: null }),
    }));

    const payload = await fetchNowPlayingStatus(fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith("/api/now-playing/status");
    expect(payload.modeState).toBe("reactive_fallback");
  });
});
```

- [ ] **Step 6: Run tests to verify the reducer and client pass**

Run: `cd runtime && npm test -- src/__tests__/nowPlayingHandoff.test.ts src/__tests__/nowPlayingClient.test.ts`
Expected: PASS with immediate-switch and cue-boundary behavior covered.

- [ ] **Step 7: Commit**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add runtime/src/app/types.ts runtime/src/nowPlaying/types.ts runtime/src/nowPlaying/client.ts runtime/src/nowPlaying/handoff.ts runtime/src/__tests__/nowPlayingHandoff.test.ts runtime/src/__tests__/nowPlayingClient.test.ts
  git commit -m "feat: add now playing runtime handoff state"
fi
```

### Task 5: Integrate Now Playing mode into the Vite service proxy and runtime UI

**Files:**
- Modify: `runtime/src/library/vitePlugin.ts`
- Modify: `runtime/src/app/main.ts`
- Modify: `runtime/README.md`
- Modify: `README.md`
- Test: `runtime/src/__tests__/nowPlayingClient.test.ts`

- [ ] **Step 1: Write the failing proxy test**

```ts
import { describe, expect, it } from "vitest";

import { nowPlayingProxyBaseUrl } from "../library/vitePlugin.js";

describe("nowPlayingProxyBaseUrl", () => {
  it("defaults to the local python service port", () => {
    expect(nowPlayingProxyBaseUrl()).toBe("http://127.0.0.1:8768");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime && npm test -- src/__tests__/nowPlayingClient.test.ts`
Expected: FAIL because the proxy helper does not exist yet.

- [ ] **Step 3: Proxy `/api/now-playing/*` through the existing Vite middleware**

```ts
export function nowPlayingProxyBaseUrl(): string {
  return process.env.P2P_NOW_PLAYING_BASE_URL || "http://127.0.0.1:8768";
}

async function forwardNowPlayingRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const upstream = await fetch(`${nowPlayingProxyBaseUrl()}${pathname}`, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "application/json" },
  });
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
  res.end(await upstream.text());
}
```

- [ ] **Step 4: Add the mode button, status surface, and runtime polling loop**

```ts
app.innerHTML = `
  <div class="mode-switch" role="group" aria-label="Runtime input mode">
    <button id="libraryMode" class="selected" type="button">Library</button>
    <button id="micMode" type="button">Mic input</button>
    <button id="nowPlayingMode" type="button">Now Playing</button>
  </div>
  <div id="nowPlayingStatus" class="mic-status" hidden>Now Playing is idle.</div>
`;

const elements = {
  nowPlayingMode: required<HTMLButtonElement>("nowPlayingMode"),
  nowPlayingStatus: required<HTMLDivElement>("nowPlayingStatus"),
};

let nowPlayingSession = createNowPlayingSession();
let lastCueStartMs: number | null = null;

setInterval(async () => {
  if (inputMode !== "now-playing") {
    return;
  }
  const status = await fetchNowPlayingStatus();
  const currentPhraseId = loaded && schedule.length
    ? playbackStateAt(schedule, elements.audio.currentTime, loaded.show.song.tempo).active.phrase.phrase_id
    : lastPhraseId;
  const cueBoundaryReached = currentPhraseId !== null && currentPhraseId !== lastPhraseId;
  if (cueBoundaryReached) {
    lastCueStartMs = performance.now();
  }
  nowPlayingSession = applyNowPlayingStatus(nowPlayingSession, {
    nowMs: performance.now(),
    status,
    currentPlayback: loaded ? { showId: loaded.libraryTrack.id, phraseId: lastPhraseId ?? "" } : null,
    lastCueStartMs,
    cueBoundaryReached,
  });
  elements.nowPlayingStatus.hidden = false;
  elements.nowPlayingStatus.textContent = status.observation
    ? `${status.observation.sourceApp}: ${status.observation.title}`
    : "Waiting for now playing source.";
  if (nowPlayingSession.outputMode === "premade_active" && status.armedShow && status.preparedAudio) {
    await loadNowPlayingShow(status.armedShow, status.preparedAudio.audioUrl);
  }
}, 1000);
```

- [ ] **Step 5: Load a ready Now Playing show through the existing show-loading path**

```ts
async function loadNowPlayingShow(armedShow: { id: string; showUrl: string }, audioUrl: string): Promise<void> {
  const show = await (await fetch(armedShow.showUrl)).json() as ShowPackage;
  loaded = {
    libraryTrack: {
      id: armedShow.id,
      title: armedShow.id,
      artist: null,
      abletonProjectPath: null,
      bpm: show.song.tempo,
      audioUrl,
      showUrl: armedShow.showUrl,
      exportShowUrl: armedShow.showUrl,
    },
    show,
  };
  elements.audio.src = audioUrl;
  schedule = [];
}
```

- [ ] **Step 6: Update docs with the local startup contract**

```md
## Now Playing mode

Start the local orchestrator in one terminal:
- `uv run phrase2photon now-playing-serve`

Then start the runtime in another:
- `cd runtime && npm run dev`

The runtime will poll `/api/now-playing/status` through the Vite proxy. Override the service URL with `P2P_NOW_PLAYING_BASE_URL` if needed.
```

- [ ] **Step 7: Run verification and commit**

Run: `pytest tests/test_now_playing_identity.py tests/test_now_playing_providers.py tests/test_now_playing_wav_analysis.py tests/test_now_playing_server.py -v`
Expected: PASS

Run: `cd runtime && npm test && npm run typecheck`
Expected: PASS

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add runtime/src/library/vitePlugin.ts runtime/src/app/main.ts runtime/README.md README.md
  git commit -m "feat: add now playing runtime mode"
fi
```
