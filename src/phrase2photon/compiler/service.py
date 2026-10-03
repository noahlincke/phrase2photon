from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

from phrase2photon.contracts.show_package import (
    DmxLaserCue,
    EnergyFeatures,
    LightingCue,
    LightingLook,
    LocatorRef,
    Phrase,
    PhraseRange,
    ShowPackage,
    SongMeta,
    TempoMapSegment,
    TrackFeatures,
    Transition,
    VisualLook,
)
from phrase2photon.extraction.models import LiveSetExtraction, PhraseSnapshot, TrackSnapshot


@dataclass(slots=True)
class CompileResult:
    show_package: ShowPackage
    written_files: list[Path]


class Phrase2PhotonCompiler:
    """Deterministic compiler from LiveSetExtraction to runtime package files."""

    def compile(self, extraction: LiveSetExtraction) -> ShowPackage:
        track_map = {track.track_id: track for track in extraction.tracks}
        phrases = [self._compile_phrase(phrase, track_map) for phrase in extraction.phrases]
        lighting_cues = [self._compile_lighting_cue(phrase) for phrase in extraction.phrases]
        dmx_laser_cues = [
            cue
            for phrase in extraction.phrases
            for cue in [self._compile_dmx_laser_cue(phrase)]
            if cue is not None
        ]

        return ShowPackage(
            version="0.1.0",
            song=SongMeta(
                song_id=slugify_name(extraction.source_name),
                title=extraction.source_name,
                artist=None,
                tempo=extraction.tempo,
                time_signature=extraction.time_signature,
                tempo_map=build_tempo_map(extraction),
            ),
            phrases=phrases,
            lighting_cues=lighting_cues,
            dmx_laser_cues=dmx_laser_cues,
            manual_overrides=[],
        )

    def compile_to_directory(self, extraction: LiveSetExtraction, outdir: Path) -> CompileResult:
        outdir.mkdir(parents=True, exist_ok=True)
        show_package = self.compile(extraction)

        written_files = [
            self._write_json(outdir / "show.json", json.loads(show_package.model_dump_json())),
            self._write_csv(outdir / "phrases.csv", build_phrase_rows(show_package, extraction)),
            self._write_csv(outdir / "lighting_cues.csv", build_lighting_rows(show_package)),
            self._write_csv(outdir / "laser_dmx_cues.csv", build_laser_rows(show_package)),
            self._write_csv(outdir / "phrase_scene_map.csv", build_phrase_scene_rows(show_package)),
            self._write_json(outdir / "fixture_map.json", build_fixture_map()),
            self._write_json(outdir / "runtime_overrides.json", build_runtime_overrides()),
        ]

        return CompileResult(show_package=show_package, written_files=written_files)

    def _compile_phrase(self, phrase: PhraseSnapshot, track_map: dict[str, TrackSnapshot]) -> Phrase:
        track_features = build_track_features(phrase, track_map)
        return Phrase(
            phrase_id=phrase.phrase_id,
            name=phrase.name,
            range=PhraseRange(
                start_bar_beat=phrase.start_bar_beat,
                end_bar_beat=phrase.end_bar_beat or phrase.start_bar_beat,
                start_locator_id=phrase.locator_id,
                end_locator_id=phrase.next_locator_id,
            ),
            locators=[
                LocatorRef(
                    locator_id=phrase.locator_id,
                    name=phrase.name,
                    bar_beat=phrase.start_bar_beat,
                )
            ],
            track_features=track_features,
            energy=EnergyFeatures(
                level=phrase.semantics.energy.level,
                dynamics=round(phrase.semantics.energy.rhythmic_drive, 3),
                tension=round(infer_tension(phrase), 3),
            ),
            visual_look=VisualLook(
                palette=phrase.semantics.visual_intent.palette,
                motion_style=phrase.semantics.visual_intent.motion,
                composition=phrase.semantics.visual_intent.density,
                notes=[
                    f"section_kind={phrase.semantics.section_kind}",
                    f"contrast={phrase.semantics.visual_intent.contrast}",
                ],
            ),
            transition_in=build_transition(phrase.semantics.transition_in_hint),
            transition_out=build_transition(phrase.semantics.transition_out_hint),
        )

    def _compile_lighting_cue(self, phrase: PhraseSnapshot) -> LightingCue:
        return LightingCue(
            cue_id=f"lx_{phrase.phrase_id.removeprefix('phrase_').replace('-', '_')}",
            phrase_id=phrase.phrase_id,
            fixture_group=select_fixture_group(phrase),
            look=LightingLook(
                palette=map_visual_to_lighting_palette(phrase.semantics.visual_intent.palette),
                intensity=phrase.semantics.lighting_intent.intensity,
                movement=phrase.semantics.lighting_intent.movement,
                strobe=phrase.semantics.lighting_intent.strobe_bias,
            ),
            priority=lighting_priority(phrase),
        )

    def _compile_dmx_laser_cue(self, phrase: PhraseSnapshot) -> DmxLaserCue | None:
        if not phrase.semantics.lighting_intent.laser_emphasis:
            return None

        mode = "fan_sweep"
        if phrase.semantics.section_kind == "tease":
            mode = "narrow_scan"
        elif phrase.semantics.section_kind == "lift":
            mode = "riser_fan"
        elif phrase.semantics.section_kind == "drop":
            mode = "burst_fan"

        return DmxLaserCue(
            cue_id=f"laser_{phrase.phrase_id.removeprefix('phrase_').replace('-', '_')}",
            phrase_id=phrase.phrase_id,
            fixture_group="laser_main",
            mode=mode,
            parameter_overrides={
                "scan_speed": int(120 + phrase.semantics.energy.score * 90),
                "color_macro": map_visual_to_lighting_palette(phrase.semantics.visual_intent.palette),
                "intensity": round(phrase.semantics.lighting_intent.intensity, 3),
            },
        )

    def _write_json(self, path: Path, payload: object) -> Path:
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return path

    def _write_csv(self, path: Path, rows: list[dict[str, object]]) -> Path:
        if not rows:
            path.write_text("", encoding="utf-8")
            return path

        fieldnames = list(rows[0].keys())
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        return path


def build_tempo_map(extraction: LiveSetExtraction) -> list[TempoMapSegment] | None:
    if extraction.first_downbeat_seconds <= 0:
        return None
    return [
        TempoMapSegment(
            start_seconds=0.0,
            bpm=extraction.tempo,
            downbeat_seconds=extraction.first_downbeat_seconds,
        )
    ]


def build_track_features(phrase: PhraseSnapshot, track_map: dict[str, TrackSnapshot]) -> list[TrackFeatures]:
    active_tracks = [track_map[track_id] for track_id in phrase.active_track_ids if track_id in track_map]
    if not active_tracks:
        return []

    max_clip_count = max(track.arrangement_clip_count for track in active_tracks) or 1
    ranked_tracks = sorted(
        active_tracks,
        key=lambda track: (
            phrase.active_role_counts.get(track.semantic_role, 0),
            track.arrangement_clip_count,
            -track.track_index,
        ),
        reverse=True,
    )

    features: list[TrackFeatures] = []
    for track in ranked_tracks[:8]:
        activity = clamp(track.arrangement_clip_count / max_clip_count)
        density = clamp(
            0.4 * activity
            + 0.3 * phrase.semantics.energy.harmonic_density
            + 0.3 * phrase.semantics.energy.rhythmic_drive
        )
        features.append(
            TrackFeatures(
                track_id=track.track_id,
                name=track.name,
                role=track.semantic_role,
                activity=round(activity, 3),
                density=round(density, 3),
            )
        )
    return features


def infer_tension(phrase: PhraseSnapshot) -> float:
    base = 0.35 * phrase.semantics.energy.fx_presence + 0.25 * phrase.semantics.energy.harmonic_density
    if phrase.semantics.transition_out_hint in {"build", "set_up_drop"}:
        base += 0.25
    if phrase.semantics.transition_in_hint in {"impact", "build_release"}:
        base += 0.15
    if phrase.semantics.section_kind in {"strip", "outro"}:
        base -= 0.1
    return clamp(base)


def build_transition(hint: str) -> Transition | None:
    mapping: dict[str, tuple[str, float, str | None]] = {
        "fade_in": ("fade", 4.0, "soft arrival"),
        "arrive": ("cut", 1.0, None),
        "impact": ("strobe-hit", 1.0, "hard phrase impact"),
        "pullback": ("fade", 2.0, "reduce density"),
        "build_release": ("ramp", 4.0, "build and release"),
        "step_down": ("fade", 2.0, "energy step down"),
        "build": ("ramp", 4.0, "build intensity"),
        "set_up_drop": ("ramp", 4.0, "set up next drop"),
        "release": ("fade", 4.0, "release energy"),
        "carry": ("hold", 0.0, None),
        "fade_out": ("fade", 8.0, "exit phrase"),
        "end": ("fade", 8.0, "end phrase"),
    }
    if hint not in mapping:
        return None

    kind, duration, notes = mapping[hint]
    return Transition(type=kind, duration_beats=duration, notes=notes)


def select_fixture_group(phrase: PhraseSnapshot) -> str:
    if phrase.semantics.section_kind in {"intro", "strip", "breakdown", "outro"}:
        return "wash_all"
    if "lead" in phrase.active_roles or "vocal" in phrase.active_roles:
        return "spots_front"
    if phrase.semantics.energy.level in {"high", "peak"}:
        return "spots_front"
    return "wash_all"


def map_visual_to_lighting_palette(palette: str) -> str:
    mapping = {
        "smoke-cool": "steel-blue",
        "nocturne-glow": "amber-steel",
        "acid-contrast": "white-acid",
        "desaturated_decay": "cold-white",
        "warm-cinematic": "amber-cyan",
    }
    return mapping.get(palette, palette)


def lighting_priority(phrase: PhraseSnapshot) -> int:
    priorities = {
        "drop": 20,
        "tease": 16,
        "lift": 14,
        "breakdown": 10,
        "intro": 5,
        "strip": 4,
        "outro": 3,
        "section": 8,
    }
    return priorities.get(phrase.semantics.section_kind, 8)


def build_phrase_rows(show_package: ShowPackage, extraction: LiveSetExtraction) -> list[dict[str, object]]:
    phrase_by_id = {phrase.phrase_id: phrase for phrase in extraction.phrases}
    rows: list[dict[str, object]] = []
    for phrase in show_package.phrases:
        raw_phrase = phrase_by_id[phrase.phrase_id]
        rows.append(
            {
                "phrase_id": phrase.phrase_id,
                "name": phrase.name,
                "start_bar_beat": phrase.range.start_bar_beat,
                "end_bar_beat": phrase.range.end_bar_beat,
                "start_locator_id": phrase.range.start_locator_id or "",
                "end_locator_id": phrase.range.end_locator_id or "",
                "section_kind": raw_phrase.semantics.section_kind,
                "energy_level": phrase.energy.level,
                "energy_score": round(raw_phrase.semantics.energy.score, 3),
                "dynamics": round(phrase.energy.dynamics, 3),
                "tension": round(phrase.energy.tension, 3),
                "active_track_count": raw_phrase.active_track_count,
                "dominant_roles": "|".join(raw_phrase.semantics.dominant_roles),
                "visual_palette": phrase.visual_look.palette,
                "motion_style": phrase.visual_look.motion_style,
                "composition": phrase.visual_look.composition,
                "transition_in_type": phrase.transition_in.type if phrase.transition_in else "",
                "transition_in_duration_beats": phrase.transition_in.duration_beats if phrase.transition_in else "",
                "transition_out_type": phrase.transition_out.type if phrase.transition_out else "",
                "transition_out_duration_beats": phrase.transition_out.duration_beats if phrase.transition_out else "",
                "scene_name": scene_name_for_phrase(phrase.phrase_id),
            }
        )
    return rows


def build_lighting_rows(show_package: ShowPackage) -> list[dict[str, object]]:
    return [
        {
            "cue_id": cue.cue_id,
            "phrase_id": cue.phrase_id,
            "fixture_group": cue.fixture_group,
            "palette": cue.look.palette,
            "intensity": cue.look.intensity,
            "movement": cue.look.movement,
            "strobe": int(cue.look.strobe),
            "priority": cue.priority,
        }
        for cue in show_package.lighting_cues
    ]


def build_laser_rows(show_package: ShowPackage) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for cue in show_package.dmx_laser_cues:
        rows.append(
            {
                "cue_id": cue.cue_id,
                "phrase_id": cue.phrase_id,
                "fixture_group": cue.fixture_group,
                "mode": cue.mode,
                "scan_speed": cue.parameter_overrides.get("scan_speed", ""),
                "pattern": cue.parameter_overrides.get("pattern", ""),
                "color_macro": cue.parameter_overrides.get("color_macro", ""),
                "intensity": cue.parameter_overrides.get("intensity", ""),
            }
        )
    return rows


def build_phrase_scene_rows(show_package: ShowPackage) -> list[dict[str, object]]:
    return [
        {
            "phrase_id": phrase.phrase_id,
            "scene_name": scene_name_for_phrase(phrase.phrase_id),
            "notes": phrase.name,
        }
        for phrase in show_package.phrases
    ]


def build_fixture_map() -> dict[str, object]:
    return {
        "fixture_groups": [
            {"group_id": "wash_all", "fixtures": ["wash_1", "wash_2", "wash_3", "wash_4"]},
            {"group_id": "spots_front", "fixtures": ["spot_1", "spot_2"]},
            {"group_id": "laser_main", "fixtures": ["laser_1"]},
        ]
    }


def build_runtime_overrides() -> dict[str, object]:
    return {
        "blackout": False,
        "intensity": 1.0,
        "paused": False,
    }


def scene_name_for_phrase(phrase_id: str) -> str:
    stem = phrase_id.removeprefix("phrase_")
    stem = stem.replace("-", "_")
    stem = re.sub(r"[^a-zA-Z0-9_]+", "_", stem).strip("_")
    return f"scene_{stem}" if stem else "scene_default"


def slugify_name(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "untitled-song"


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))
