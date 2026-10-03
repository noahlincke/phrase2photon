from __future__ import annotations

from array import array
from pathlib import Path
import statistics
import subprocess
from typing import Any

from phrase2photon.contracts.beat_grid import BeatGrid, bar_beat_for_seconds
from phrase2photon.contracts.show_package import TempoMapSegment
from phrase2photon.extraction.models import (
    EnergySnapshot,
    LiveSetExtraction,
    LightingIntentSnapshot,
    LocatorSnapshot,
    PhraseSemanticsSnapshot,
    PhraseSnapshot,
    VisualIntentSnapshot,
)


LOW_ENERGY_LABELS = {"intro", "breakdown", "strip", "outro"}


def analyze_audio_sections(
    audio_path: Path,
    *,
    duration_seconds: float | None = None,
    tempo: float = 124.0,
) -> list[dict[str, float | str]]:
    total = max(duration_seconds or 180.0, 1.0)
    try:
        bar_energy = _measure_bar_energy(audio_path, tempo=tempo, duration_seconds=total)
    except Exception:
        bar_energy = []

    sections = _detect_structural_sections_from_bar_energy(bar_energy, tempo=tempo)
    if sections:
        return sections
    return _fallback_sections(total, tempo=tempo)


def build_wav_analysis_extraction(
    *,
    audio_path: Path,
    title: str,
    artist: str | None,
    duration_seconds: float,
    tempo: float,
    sections: list[dict[str, Any]] | None = None,
    downbeat_seconds: float = 0.0,
    tempo_map: list[TempoMapSegment] | None = None,
    subdivide: bool = True,
) -> LiveSetExtraction:
    section_rows = sections or analyze_audio_sections(audio_path, duration_seconds=duration_seconds, tempo=tempo)
    # Rekordbox-backed shows carry their own tempo map and bar-accurate
    # boundaries, so their phrase map is used as-is instead of re-chunked.
    if subdivide and tempo_map is None and _should_subdivide_structural_map(
        section_rows, tempo=tempo, downbeat_seconds=downbeat_seconds
    ):
        section_rows = _subdivide_structural_sections(
            section_rows,
            duration_seconds=duration_seconds,
            tempo=tempo,
            downbeat_seconds=downbeat_seconds,
        )
    locators: list[LocatorSnapshot] = []
    phrases: list[PhraseSnapshot] = []
    grid = (
        BeatGrid(segments=list(tempo_map), beats_per_bar=4)
        if tempo_map
        else None
    )

    for index, section in enumerate(section_rows):
        start_seconds = float(section["start_seconds"])
        end_seconds = float(section["end_seconds"])
        locator = LocatorSnapshot(
            locator_id=f"wav_locator_{index}",
            name=str(section["label"]).title(),
            time=_bar_beat(start_seconds, tempo, downbeat_seconds, grid),
            order_index=index,
        )
        locators.append(locator)
        next_locator_id = f"wav_locator_{index + 1}" if index + 1 < len(section_rows) else None
        phrases.append(
            PhraseSnapshot(
                phrase_id=f"wav_phrase_{index}",
                name=str(section["label"]).title(),
                start_bar_beat=locator.time,
                end_bar_beat=_bar_beat(end_seconds, tempo, downbeat_seconds, grid),
                locator_id=locator.locator_id,
                next_locator_id=next_locator_id,
                active_track_ids=[],
                active_track_count=0,
                active_roles=[],
                active_role_counts={},
                semantics=_build_semantics(
                    label=str(section["label"]),
                    energy_level=str(section["energy"]),
                    phrase_index=index,
                    total_phrases=len(section_rows),
                    artist=artist,
                    audio_path=audio_path,
                ),
            )
        )

    return LiveSetExtraction(
        source_name=title,
        tempo=tempo,
        time_signature="4/4",
        first_downbeat_seconds=downbeat_seconds,
        tempo_map=tempo_map,
        locators=locators,
        tracks=[],
        phrases=phrases,
        warnings=[],
    )


def _bar_beat(seconds: float, tempo: float, downbeat_seconds: float, grid: BeatGrid | None) -> str:
    if grid is not None:
        return bar_beat_for_seconds(grid, seconds)
    return _bar_beat_for_seconds(seconds, tempo, downbeat_seconds)


def _bar_beat_for_seconds(seconds: float, tempo: float, downbeat_seconds: float = 0.0) -> str:
    total_beats = (seconds - downbeat_seconds) * tempo / 60.0
    if total_beats < 0:
        # Material before the first downbeat belongs to the first phrase.
        return "1|1"
    bar_number = int(total_beats // 4) + 1
    beat_number = (total_beats % 4) + 1
    return f"{bar_number}|{_format_beat_number(beat_number)}"


def _format_beat_number(value: float) -> str:
    formatted = f"{value:.3f}".rstrip("0").rstrip(".")
    return formatted or "0"


def _build_semantics(
    *,
    label: str,
    energy_level: str,
    phrase_index: int,
    total_phrases: int,
    artist: str | None,
    audio_path: Path,
) -> PhraseSemanticsSnapshot:
    score_map = {
        "low": 0.25,
        "mid": 0.55,
        "high": 0.75,
        "peak": 0.95,
    }
    score = score_map.get(energy_level, 0.5)
    section_kind = _section_kind(label=label, energy_level=energy_level, phrase_index=phrase_index, total_phrases=total_phrases)
    if section_kind == "lift":
        palette = "nocturne-glow"
        motion = "suspended_tension"
        density = "medium"
        contrast = "high"
    elif energy_level == "peak":
        palette = "acid-contrast"
        motion = "beat_locked_cuts"
        density = "dense"
        contrast = "high"
    elif energy_level == "high":
        palette = "warm-cinematic"
        motion = "pulse_chase"
        density = "medium"
        contrast = "high"
    else:
        palette = "smoke-cool"
        motion = "slow_drift"
        density = "sparse"
        contrast = "low"

    return PhraseSemanticsSnapshot(
        section_kind=section_kind,
        dominant_roles=[],
        transition_in_hint=
        "fade_in"
        if phrase_index == 0
        else (
            "build_release"
            if section_kind == "lift"
            else ("impact" if section_kind == "drop" else "arrive")
        ),
        transition_out_hint=
        "end"
        if phrase_index == total_phrases - 1
        else (
            "set_up_drop"
            if section_kind == "lift"
            else ("release" if section_kind == "drop" else "carry")
        ),
        energy=EnergySnapshot(
            score=score,
            level=energy_level,
            rhythmic_drive=min(score, 1.0),
            harmonic_density=0.25 if energy_level == "peak" else (0.35 if energy_level == "high" else 0.5),
            melodic_presence=0.2 if artist else 0.0,
            bass_presence=0.8 if energy_level in {"high", "peak"} else 0.2,
            fx_presence=0.75 if section_kind == "lift" else (0.65 if energy_level in {"high", "peak"} else 0.1),
        ),
        visual_intent=VisualIntentSnapshot(
            palette=palette,
            motion=motion,
            density=density,
            contrast=contrast,
        ),
        lighting_intent=LightingIntentSnapshot(
            intensity=score,
            movement="build_ramp" if section_kind == "lift" else ("beat_chase" if energy_level in {"high", "peak"} else "slow_sweep"),
            strobe_bias=section_kind == "drop" or energy_level == "peak",
            laser_emphasis=section_kind in {"lift", "drop"} or energy_level == "peak",
        ),
    )


def _section_kind(*, label: str, energy_level: str, phrase_index: int, total_phrases: int) -> str:
    lowered = label.casefold()
    if "intro" in lowered:
        return "intro"
    if "lift" in lowered or "build" in lowered:
        return "lift"
    if "drop" in lowered:
        return "drop"
    if "break" in lowered:
        return "breakdown"
    if "strip" in lowered:
        return "strip"
    if "outro" in lowered:
        return "outro"
    if "groove" in lowered or "section" in lowered:
        return "groove"
    if phrase_index == 0:
        return "intro"
    if phrase_index == total_phrases - 1 and energy_level == "low":
        return "outro"
    return "groove"


def _measure_bar_energy(audio_path: Path, *, tempo: float, duration_seconds: float, sample_rate: int = 4000) -> list[float]:
    samples = _decode_mono_samples(audio_path, sample_rate=sample_rate)
    if not samples:
        return []

    seconds_per_bar = 240.0 / tempo
    samples_per_bar = max(1, int(round(sample_rate * seconds_per_bar)))
    expected_bars = max(1, int(round(duration_seconds / seconds_per_bar)))
    energies: list[float] = []
    for index in range(expected_bars):
        start = index * samples_per_bar
        if start >= len(samples):
            break
        end = min(len(samples), start + samples_per_bar)
        chunk = samples[start:end]
        if not chunk:
            break
        square_sum = sum(sample * sample for sample in chunk)
        energies.append((square_sum / len(chunk)) ** 0.5)
    return energies


def _decode_mono_samples(audio_path: Path, *, sample_rate: int) -> list[float]:
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    if not result.stdout:
        return []
    samples = array("f")
    samples.frombytes(result.stdout)
    return list(samples)


def _detect_structural_sections_from_bar_energy(
    bar_energy: list[float],
    *,
    tempo: float,
) -> list[dict[str, float | str]]:
    total_bars = len(bar_energy)
    if total_bars < 24:
        return []

    drop_bars = _detect_drop_bars(bar_energy)
    if not drop_bars:
        return []

    anchors: list[tuple[int, str, str]] = [(1, "intro", "low")]
    if total_bars >= 32:
        anchors.append((17, "groove", "mid"))

    for drop_bar in drop_bars:
        drop_bar = _snap_to_phrase_start(drop_bar)
        lift_bar = max(1, drop_bar - 16)
        if lift_bar - anchors[-1][0] >= 8:
            anchors.append((lift_bar, "lift", "high"))
        anchors.append((drop_bar, "drop", "peak"))
        groove_after_drop = drop_bar + 16
        if total_bars - groove_after_drop >= 16:
            anchors.append((groove_after_drop, "groove", "high"))

    outro_start_bar = _detect_outro_start_bar(bar_energy)
    if outro_start_bar is not None and outro_start_bar - anchors[-1][0] >= 8:
        anchors.append((outro_start_bar, "outro", "low"))

    anchors = _dedupe_and_sort_anchors(anchors, total_bars=total_bars)
    return _sections_from_anchors(anchors, total_bars=total_bars, tempo=tempo)


def _detect_drop_bars(bar_energy: list[float]) -> list[int]:
    if len(bar_energy) < 32:
        return []

    normalized = _normalize_energy(bar_energy)
    smoothed = _moving_average(normalized, radius=2)
    baseline = statistics.median(smoothed)
    candidates: list[tuple[float, int]] = []
    for index in range(16, len(smoothed) - 16):
        pre = _average(smoothed[max(0, index - 8):index])
        post = _average(smoothed[index:min(len(smoothed), index + 8)])
        local = smoothed[index]
        score = (post - pre) * 1.4 + max(0.0, local - baseline) * 0.8
        if post >= baseline + 0.08 and score >= 0.24:
            candidates.append((score, index + 1))

    if not candidates:
        return []

    selected: list[int] = []
    for _score, bar in sorted(candidates, reverse=True):
        if any(abs(bar - existing) < 24 for existing in selected):
            continue
        selected.append(bar)

    return sorted(selected)


def _detect_outro_start_bar(bar_energy: list[float]) -> int | None:
    if len(bar_energy) < 32:
        return None

    normalized = _normalize_energy(bar_energy)
    baseline = statistics.median(normalized)
    tail = normalized[-8:]
    if not tail or _average(tail) > baseline * 0.6:
        return None
    return max(1, len(bar_energy) - 7)


def _dedupe_and_sort_anchors(
    anchors: list[tuple[int, str, str]],
    *,
    total_bars: int,
) -> list[tuple[int, str, str]]:
    deduped: list[tuple[int, str, str]] = []
    seen_bars: set[int] = set()
    for bar, label, energy in sorted(anchors, key=lambda item: item[0]):
        clamped_bar = min(max(bar, 1), total_bars)
        if clamped_bar in seen_bars:
            continue
        deduped.append((clamped_bar, label, energy))
        seen_bars.add(clamped_bar)
    return deduped


def _sections_from_anchors(
    anchors: list[tuple[int, str, str]],
    *,
    total_bars: int,
    tempo: float,
) -> list[dict[str, float | str]]:
    sections: list[dict[str, float | str]] = []
    for index, (start_bar, label, energy) in enumerate(anchors):
        next_start_bar = anchors[index + 1][0] if index + 1 < len(anchors) else total_bars + 1
        sections.append(
            {
                "label": label,
                "start_seconds": _seconds_for_bar(start_bar, tempo),
                "end_seconds": _seconds_for_bar(next_start_bar, tempo),
                "energy": energy,
            }
        )
    return sections


def _subdivide_structural_sections(
    section_rows: list[dict[str, Any]],
    *,
    duration_seconds: float,
    tempo: float,
    downbeat_seconds: float = 0.0,
) -> list[dict[str, Any]]:
    subdivided: list[dict[str, Any]] = []
    groove_count = 0
    drop_count = 0
    lift_count = 0

    for section in section_rows:
        start_seconds = float(section["start_seconds"])
        end_seconds = float(section["end_seconds"])
        start_bar = _bar_index_for_seconds(start_seconds, tempo, downbeat_seconds)
        end_bar = _bar_index_for_seconds(end_seconds, tempo, downbeat_seconds)
        if not _is_structurally_subdividable(start_bar, end_bar):
            subdivided.append(section)
            continue

        total_bars = int(round(end_bar - start_bar))
        label = str(section["label"]).casefold()
        chunk_lengths = _structural_chunk_lengths(total_bars, label=label)
        current_bar = int(round(start_bar))

        for chunk_index, chunk_bars in enumerate(chunk_lengths):
            chunk_label: str
            if label == "intro":
                if chunk_index == 0 and not subdivided:
                    chunk_label = "Intro"
                else:
                    groove_count += 1
                    chunk_label = "Groove" if groove_count == 1 else f"Groove {groove_count}"
            elif label == "drop":
                if chunk_index == 0:
                    drop_count += 1
                    chunk_label = "Drop" if drop_count == 1 else f"Drop {drop_count}"
                else:
                    groove_count += 1
                    chunk_label = "Groove" if groove_count == 1 else f"Groove {groove_count}"
            elif label == "lift":
                lift_count += 1
                chunk_label = "Lift" if lift_count == 1 else f"Lift {lift_count}"
            elif label == "outro":
                chunk_label = "Outro"
            elif label in {"breakdown", "strip"}:
                chunk_label = str(section["label"]).title()
            else:
                groove_count += 1
                chunk_label = "Groove" if groove_count == 1 else f"Groove {groove_count}"

            subdivided.append(
                {
                    "label": chunk_label,
                    "start_seconds": _seconds_for_bar(current_bar + 1, tempo, downbeat_seconds),
                    "end_seconds": _seconds_for_bar(current_bar + chunk_bars + 1, tempo, downbeat_seconds),
                    "energy": section["energy"],
                }
            )
            current_bar += chunk_bars

    if subdivided:
        subdivided[-1]["end_seconds"] = duration_seconds
    return subdivided


def _should_subdivide_structural_map(
    section_rows: list[dict[str, Any]],
    *,
    tempo: float,
    downbeat_seconds: float = 0.0,
) -> bool:
    if len(section_rows) < 4:
        return False
    labels = [str(section["label"]).casefold() for section in section_rows]
    if not any(label in {"lift", "drop", "groove", "outro"} for label in labels):
        return False
    for section in section_rows:
        start_bar = _bar_index_for_seconds(float(section["start_seconds"]), tempo, downbeat_seconds)
        end_bar = _bar_index_for_seconds(float(section["end_seconds"]), tempo, downbeat_seconds)
        if not _is_structurally_subdividable(start_bar, end_bar):
            return False
    return True


def _structural_chunk_lengths(total_bars: int, *, label: str) -> list[int]:
    remaining = total_bars
    chunks: list[int] = []
    while remaining > 0:
        if remaining <= 8:
            chunk = remaining
        elif remaining % 16 == 0:
            chunk = 16
        elif remaining % 8 == 0:
            chunk = 8 if remaining < 16 else 16
        elif label in {"lift", "drop"}:
            chunk = 16
        else:
            chunk = min(remaining, 16)
        chunks.append(chunk)
        remaining -= chunk
    return chunks


def _is_structurally_subdividable(start_bar: float, end_bar: float) -> bool:
    total_bars = end_bar - start_bar
    return _close_to_integer(start_bar) and _close_to_integer(end_bar) and total_bars >= 16.0


def _close_to_integer(value: float, tolerance: float = 0.125) -> bool:
    return abs(value - round(value)) <= tolerance


def _bar_index_for_seconds(seconds: float, tempo: float, downbeat_seconds: float = 0.0) -> float:
    return (seconds - downbeat_seconds) * tempo / 60.0 / 4.0


def _seconds_for_bar(bar_number: int, tempo: float, downbeat_seconds: float = 0.0) -> float:
    return downbeat_seconds + max(bar_number - 1, 0) * 240.0 / tempo


def _snap_to_phrase_start(bar_number: int) -> int:
    if bar_number <= 1:
        return 1
    return ((bar_number - 1 + 15) // 16) * 16 + 1


def _moving_average(values: list[float], *, radius: int) -> list[float]:
    smoothed: list[float] = []
    for index in range(len(values)):
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        smoothed.append(_average(values[start:end]))
    return smoothed


def _normalize_energy(values: list[float]) -> list[float]:
    if not values:
        return []
    floor = min(values)
    ceiling = max(values)
    if ceiling <= floor:
        return [0.0 for _ in values]
    return [(value - floor) / (ceiling - floor) for value in values]


def _average(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _fallback_sections(total_seconds: float, *, tempo: float) -> list[dict[str, float | str]]:
    total_bars = max(1, int(round(_bar_index_for_seconds(total_seconds, tempo))))
    intro_end = 17 if total_bars >= 48 else max(9, total_bars // 4)
    lift_start = max(intro_end + 8, total_bars - 31) if total_bars >= 48 else None
    drop_start = lift_start + 16 if lift_start is not None else max(intro_end + 8, total_bars - 15)

    anchors: list[tuple[int, str, str]] = [(1, "intro", "low")]
    if intro_end > 1 and intro_end < total_bars:
        anchors.append((intro_end, "groove", "mid"))
    if lift_start is not None and lift_start < total_bars:
        anchors.append((lift_start, "lift", "high"))
    if drop_start < total_bars:
        anchors.append((drop_start, "drop", "peak"))

    return _sections_from_anchors(_dedupe_and_sort_anchors(anchors, total_bars=total_bars), total_bars=total_bars, tempo=tempo)
