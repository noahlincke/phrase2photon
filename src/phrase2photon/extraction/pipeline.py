from __future__ import annotations

import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from fractions import Fraction
from typing import Any

from phrase2photon.bridge.producer_pal import ProducerPalClient, ProducerPalError
from phrase2photon.extraction.models import (
    ArrangementClipSnapshot,
    DeviceSnapshot,
    EnergySnapshot,
    LiveSetExtraction,
    LightingIntentSnapshot,
    LocatorSnapshot,
    PhraseSnapshot,
    PhraseSemanticsSnapshot,
    SendSnapshot,
    ToolCatalogEntry,
    TrackSnapshot,
    VisualIntentSnapshot,
)


class ProducerPalExtractionPipeline:
    def __init__(self, client: ProducerPalClient) -> None:
        self.client = client

    def extract(self, include_all_tracks: bool = False) -> LiveSetExtraction:
        connect_info = self.client.connect().result
        tool_catalog = self.client.list_tools()
        live_set = self.client.read_live_set_with_include(["tracks", "locators", "mixer", "color"])
        warnings: list[str] = []

        live_tracks = live_set.get("tracks", [])
        group_name_by_id = {track["id"]: track["name"] for track in live_tracks}

        detail_track_indices = self._select_detail_track_indices(live_tracks, include_all_tracks=include_all_tracks)
        detail_by_index = self._read_track_details(detail_track_indices, warnings)

        tracks = [
            self._build_track_snapshot(track, detail_by_index.get(track["trackIndex"]), group_name_by_id)
            for track in live_tracks
        ]
        locators = build_locator_snapshots(live_set.get("locators", []))
        phrases = derive_phrases(locators, tracks)

        return LiveSetExtraction(
            source_name=live_set["name"],
            tempo=live_set["tempo"],
            time_signature=live_set["timeSignature"],
            scale=live_set.get("scale"),
            scale_pitches=live_set.get("scalePitches"),
            producer_pal_version=connect_info.get("producerPalVersion"),
            ableton_live_version=connect_info.get("abletonLiveVersion"),
            tool_catalog=[
                ToolCatalogEntry(
                    name=tool["name"],
                    title=tool.get("title"),
                    description=tool.get("description"),
                    input_schema=tool.get("inputSchema", {}),
                )
                for tool in tool_catalog.get("tools", [])
            ],
            locators=locators,
            tracks=tracks,
            phrases=phrases,
            warnings=warnings,
        )

    def _select_detail_track_indices(self, live_tracks: list[dict[str, Any]], include_all_tracks: bool) -> list[int]:
        if include_all_tracks:
            return [track["trackIndex"] for track in live_tracks]

        indices: list[int] = []
        for track in live_tracks:
            if track.get("arrangementClipCount", 0) > 0:
                indices.append(track["trackIndex"])
                continue
            if track.get("hasProducerPalDevice"):
                indices.append(track["trackIndex"])

        return indices

    def _read_track_details(self, track_indices: list[int], warnings: list[str]) -> dict[int, dict[str, Any]]:
        detail_by_index: dict[int, dict[str, Any]] = {}
        if not track_indices:
            return detail_by_index

        detail_client = ProducerPalClient(
            base_url=self.client.base_url,
            timeout_seconds=min(self.client.timeout_seconds, 5.0),
        )
        max_workers = min(4, len(track_indices))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {
                executor.submit(
                    detail_client.read_track,
                    track_index,
                    ["arrangement-clips", "devices", "mixer", "color"],
                ): track_index
                for track_index in track_indices
            }
            for future in as_completed(future_map):
                track_index = future_map[future]
                try:
                    detail_by_index[track_index] = future.result()
                except ProducerPalError as exc:
                    warnings.append(f"track {track_index} detail read failed: {exc}")

        return detail_by_index

    def _build_track_snapshot(
        self,
        track: dict[str, Any],
        detail: dict[str, Any] | None,
        group_name_by_id: dict[str, str],
    ) -> TrackSnapshot:
        arrangement_clips = detail.get("arrangementClips", []) if detail else []
        devices = detail.get("devices", []) if detail else []
        sends = detail.get("sends", track.get("sends", [])) if detail else track.get("sends", [])
        group_id = track.get("groupId")

        return TrackSnapshot(
            track_id=track["id"],
            track_index=track["trackIndex"],
            name=track["name"],
            type=track["type"],
            color=track.get("color"),
            group_id=group_id,
            group_name=group_name_by_id.get(group_id),
            is_group=bool(track.get("isGroup", False)),
            is_group_member=bool(track.get("isGroupMember", False)),
            state=track.get("state"),
            instrument=track.get("instrument"),
            gain_db=track.get("gainDb"),
            pan=track.get("pan"),
            arrangement_clip_count=track.get("arrangementClipCount", 0),
            arrangement_clips=[
                ArrangementClipSnapshot(
                    clip_id=clip["id"],
                    arrangement_start=clip["arrangementStart"],
                    color=clip.get("color"),
                    name=clip.get("name"),
                )
                for clip in arrangement_clips
            ],
            devices=[
                DeviceSnapshot(
                    device_id=device["id"],
                    path=device["path"],
                    type=device["type"],
                    name=device.get("name"),
                    deactivated=bool(device.get("deactivated", False)),
                )
                for device in devices
            ],
            sends=[
                SendSnapshot(
                    return_name=send["return"],
                    gain_db=float(send["gainDb"]),
                )
                for send in sends
            ],
            semantic_role=classify_track_role(track["name"], group_name_by_id.get(group_id)),
            tags=classify_track_tags(track["name"], group_name_by_id.get(group_id)),
            has_producer_pal_device=bool(track.get("hasProducerPalDevice", False)),
        )


def build_locator_snapshots(raw_locators: list[dict[str, Any]]) -> list[LocatorSnapshot]:
    locators = [
        LocatorSnapshot(
            locator_id=locator["id"],
            name=str(locator["name"]),
            time=locator["time"],
            order_index=index,
        )
        for index, locator in enumerate(raw_locators)
    ]
    return sorted(locators, key=lambda locator: bar_beat_sort_key(locator.time))


def derive_phrases(locators: list[LocatorSnapshot], tracks: list[TrackSnapshot]) -> list[PhraseSnapshot]:
    phrases: list[PhraseSnapshot] = []
    for index, locator in enumerate(locators):
        next_locator = locators[index + 1] if index + 1 < len(locators) else None
        active_track_ids: list[str] = []
        active_roles: Counter[str] = Counter()

        for track in tracks:
            if not track.arrangement_clips:
                continue
            if any(_clip_in_phrase(clip.arrangement_start, locator.time, next_locator.time if next_locator else None) for clip in track.arrangement_clips):
                active_track_ids.append(track.track_id)
                active_roles[track.semantic_role] += 1

        semantics = infer_phrase_semantics(
            phrase_name=locator.name,
            phrase_index=index,
            total_phrases=len(locators),
            active_track_count=len(active_track_ids),
            active_roles=active_roles,
        )
        phrases.append(
            PhraseSnapshot(
                phrase_id=slugify_phrase_name(locator.name, index),
                name=locator.name,
                start_bar_beat=locator.time,
                end_bar_beat=next_locator.time if next_locator else None,
                locator_id=locator.locator_id,
                next_locator_id=next_locator.locator_id if next_locator else None,
                active_track_ids=active_track_ids,
                active_track_count=len(active_track_ids),
                active_roles=[role for role, _ in active_roles.most_common()],
                active_role_counts=dict(active_roles),
                semantics=semantics,
            )
        )

    for index, phrase in enumerate(phrases):
        prev_energy = phrases[index - 1].semantics.energy.score if index > 0 else None
        next_energy = phrases[index + 1].semantics.energy.score if index + 1 < len(phrases) else None
        phrase.semantics.transition_in_hint = infer_transition_in_hint(
            phrase.semantics.section_kind,
            phrase.semantics.energy.score,
            prev_energy,
        )
        phrase.semantics.transition_out_hint = infer_transition_out_hint(
            phrase.semantics.section_kind,
            phrase.semantics.energy.score,
            next_energy,
        )

    return phrases


def _clip_in_phrase(clip_start: str, phrase_start: str, phrase_end: str | None) -> bool:
    clip_key = bar_beat_sort_key(clip_start)
    start_key = bar_beat_sort_key(phrase_start)
    if clip_key < start_key:
        return False
    if phrase_end is None:
        return True
    return clip_key < bar_beat_sort_key(phrase_end)


def classify_track_role(track_name: str, group_name: str | None = None) -> str:
    haystack = " ".join(part.lower() for part in [group_name or "", track_name] if part)
    rules = [
        ("vocal", ["voc", "ad lib", "vox"]),
        ("kick", ["kick"]),
        ("snare", ["snare", "clap"]),
        ("hihat", ["hat", "shaker"]),
        ("percussion", ["perc", "loop", "fill"]),
        ("bass", ["bass", "sub"]),
        ("lead", ["lead", "acid"]),
        ("chords", ["chord", "piano"]),
        ("pad", ["pad", "string", "atmos"]),
        ("fx", ["fx", "crash", "sweep", "noise", "transition"]),
        ("drums", ["drum"]),
    ]
    for role, tokens in rules:
        if any(token in haystack for token in tokens):
            return role
    return "texture"


def classify_track_tags(track_name: str, group_name: str | None = None) -> list[str]:
    role = classify_track_role(track_name, group_name)
    tags = [role]
    normalized = f"{group_name or ''} {track_name}".lower()
    if "audio" in normalized:
        tags.append("audio")
    if "midi" in normalized:
        tags.append("midi")
    return tags


def infer_phrase_semantics(
    phrase_name: str,
    phrase_index: int,
    total_phrases: int,
    active_track_count: int,
    active_roles: Counter[str],
) -> PhraseSemanticsSnapshot:
    section_kind = infer_section_kind(phrase_name, phrase_index, total_phrases)
    energy = infer_energy(section_kind, active_track_count, active_roles)
    dominant_roles = [role for role, _ in active_roles.most_common(4)]
    visual_intent = infer_visual_intent(section_kind, energy)
    lighting_intent = infer_lighting_intent(section_kind, energy)

    return PhraseSemanticsSnapshot(
        section_kind=section_kind,
        dominant_roles=dominant_roles,
        transition_in_hint="arrive",
        transition_out_hint="carry",
        energy=energy,
        visual_intent=visual_intent,
        lighting_intent=lighting_intent,
    )


def infer_section_kind(phrase_name: str, phrase_index: int, total_phrases: int) -> str:
    name = phrase_name.strip().lower()
    if "outro" in name or phrase_index == total_phrases - 1:
        return "outro"
    if "drop" in name and "teaser" not in name:
        return "drop"
    if "teaser" in name:
        return "tease"
    if "breakdown" in name:
        return "breakdown"
    if "strip" in name or "pad only" in name:
        return "strip"
    if "intro" in name or phrase_index == 0:
        return "intro"
    if "bass in" in name:
        return "lift"
    return "section"


def infer_energy(section_kind: str, active_track_count: int, active_roles: Counter[str]) -> EnergySnapshot:
    track_density = clamp(active_track_count / 32.0)
    rhythmic_drive = clamp(
        (
            active_roles.get("kick", 0) * 1.0
            + active_roles.get("snare", 0) * 0.8
            + active_roles.get("hihat", 0) * 0.7
            + active_roles.get("percussion", 0) * 0.6
            + active_roles.get("drums", 0) * 0.8
        )
        / 6.0
    )
    harmonic_density = clamp(
        (
            active_roles.get("chords", 0) * 1.0
            + active_roles.get("pad", 0) * 0.8
            + active_roles.get("texture", 0) * 0.5
        )
        / 5.0
    )
    melodic_presence = clamp(
        (
            active_roles.get("lead", 0) * 1.0
            + active_roles.get("vocal", 0) * 0.9
        )
        / 4.0
    )
    bass_presence = clamp(active_roles.get("bass", 0) / 2.0)
    fx_presence = clamp(active_roles.get("fx", 0) / 3.0)

    section_bias = {
        "intro": -0.18,
        "strip": -0.22,
        "breakdown": -0.08,
        "lift": 0.05,
        "tease": 0.12,
        "drop": 0.20,
        "outro": -0.20,
        "section": 0.0,
    }[section_kind]

    score = clamp(
        0.28 * track_density
        + 0.28 * rhythmic_drive
        + 0.16 * harmonic_density
        + 0.14 * melodic_presence
        + 0.10 * bass_presence
        + 0.04 * fx_presence
        + section_bias
    )
    if section_kind == "intro":
        score = min(score, 0.42)
    if section_kind == "strip":
        score = min(score, 0.45)
    if section_kind == "breakdown":
        score = min(score, 0.68)
    if section_kind == "outro":
        score = min(score, 0.35)
    if section_kind == "drop":
        score = max(score, 0.58)
    if section_kind == "tease":
        score = max(score, 0.5)
    level = classify_energy_level(score)

    return EnergySnapshot(
        score=score,
        level=level,
        rhythmic_drive=rhythmic_drive,
        harmonic_density=harmonic_density,
        melodic_presence=melodic_presence,
        bass_presence=bass_presence,
        fx_presence=fx_presence,
    )


def classify_energy_level(score: float) -> str:
    if score < 0.28:
        return "low"
    if score < 0.5:
        return "mid"
    if score < 0.72:
        return "high"
    return "peak"


def infer_visual_intent(section_kind: str, energy: EnergySnapshot) -> VisualIntentSnapshot:
    if section_kind in {"intro", "strip"}:
        return VisualIntentSnapshot(
            palette="smoke-cool",
            motion="slow_drift",
            density="sparse",
            contrast="low",
        )
    if section_kind == "breakdown":
        return VisualIntentSnapshot(
            palette="nocturne-glow",
            motion="suspended_tension",
            density="open",
            contrast="mid",
        )
    if section_kind in {"drop", "tease"} or energy.level in {"high", "peak"}:
        return VisualIntentSnapshot(
            palette="acid-contrast",
            motion="beat_locked_cuts",
            density="dense",
            contrast="high",
        )
    if section_kind == "outro":
        return VisualIntentSnapshot(
            palette="desaturated_decay",
            motion="slow_falloff",
            density="thinning",
            contrast="mid",
        )
    return VisualIntentSnapshot(
        palette="warm-cinematic",
        motion="measured_pulse",
        density="medium",
        contrast="mid",
    )


def infer_lighting_intent(section_kind: str, energy: EnergySnapshot) -> LightingIntentSnapshot:
    if section_kind in {"intro", "strip"}:
        movement = "slow_sweep"
    elif section_kind == "breakdown":
        movement = "breathing_pulse"
    elif section_kind in {"drop", "tease"} or energy.level in {"high", "peak"}:
        movement = "beat_chase"
    elif section_kind == "outro":
        movement = "decay_hold"
    else:
        movement = "groove_pulse"

    return LightingIntentSnapshot(
        intensity=round(clamp(0.2 + 0.8 * energy.score), 3),
        movement=movement,
        strobe_bias=section_kind == "drop" or energy.level == "peak",
        laser_emphasis=section_kind in {"drop", "tease", "lift"} and energy.level in {"high", "peak"},
    )


def infer_transition_in_hint(section_kind: str, energy_score: float, prev_energy: float | None) -> str:
    if prev_energy is None:
        return "fade_in"
    if section_kind == "intro":
        return "fade_in"
    delta = energy_score - prev_energy
    if section_kind == "drop":
        return "impact"
    if section_kind in {"breakdown", "strip"}:
        return "pullback"
    if delta > 0.18:
        return "build_release"
    if delta < -0.18:
        return "step_down"
    return "arrive"


def infer_transition_out_hint(section_kind: str, energy_score: float, next_energy: float | None) -> str:
    if next_energy is None:
        return "fade_out"
    delta = next_energy - energy_score
    if section_kind in {"tease", "lift"} and delta > 0:
        return "set_up_drop"
    if section_kind == "outro":
        return "end"
    if delta > 0.18:
        return "build"
    if delta < -0.18:
        return "release"
    return "carry"


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def slugify_phrase_name(name: str, index: int) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if slug:
        return f"phrase_{slug}"
    return f"phrase_{index + 1:02d}"


def bar_beat_sort_key(value: str) -> tuple[int, float]:
    bar_text, beat_text = value.split("|", 1)
    return int(bar_text), _parse_numeric_expression(beat_text)


def _parse_numeric_expression(value: str) -> float:
    total = Fraction(0, 1)
    for part in value.split("+"):
        token = part.strip()
        if not token:
            continue
        if "/" in token and "." not in token:
            numerator, denominator = token.split("/", 1)
            if numerator == "":
                numerator = "1"
            total += Fraction(int(numerator), int(denominator))
            continue
        total += Fraction(str(float(token)))
    return float(total)
