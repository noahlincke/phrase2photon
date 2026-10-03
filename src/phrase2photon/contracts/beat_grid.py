"""Python twin of runtime/src/show/beatGrid.ts.

Recording shows are assembled on the Python side but played on the runtime
side, so both must agree on how beats and seconds map onto each other across a
tempo map. runtime/fixtures/beat-grid-vectors.json is the shared test vector:
the vitest and pytest suites both reproduce it, so the two implementations
cannot drift.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from phrase2photon.contracts.show_package import ShowPackage, TempoMapSegment

# Tolerance for treating a downbeat as exactly bar-aligned despite float noise,
# mirroring BAR_SNAP_BEATS in beatGrid.ts.
BAR_SNAP_BEATS = 1e-6


@dataclass(frozen=True)
class BeatGrid:
    segments: list[TempoMapSegment]
    beats_per_bar: int


def grid_for_show(show: ShowPackage) -> BeatGrid:
    segments = show.song.tempo_map or [
        TempoMapSegment(start_seconds=0.0, bpm=show.song.tempo, downbeat_seconds=0.0)
    ]
    return BeatGrid(segments=list(segments), beats_per_bar=beats_per_bar_from_signature(show.song.time_signature))


def beats_per_bar_from_signature(signature: str) -> int:
    beats_text = signature.split("/")[0]
    try:
        beats = int(beats_text)
    except ValueError:
        return 4
    return beats if beats > 0 else 4


def _spans(grid: BeatGrid) -> list[tuple[float, float, float]]:
    """(start_seconds, continuous beats at that time, bpm) per segment."""
    spans: list[tuple[float, float, float]] = []
    for index, segment in enumerate(grid.segments):
        if index == 0:
            start_beats = -segment.downbeat_seconds * (segment.bpm / 60)
        else:
            previous_start, previous_beats, previous_bpm = spans[-1]
            accumulated = previous_beats + (segment.start_seconds - previous_start) * (previous_bpm / 60)
            downbeat_offset = (segment.downbeat_seconds - segment.start_seconds) * (segment.bpm / 60)
            bars = math.ceil((accumulated + downbeat_offset - BAR_SNAP_BEATS) / grid.beats_per_bar)
            start_beats = bars * grid.beats_per_bar - downbeat_offset
        spans.append((segment.start_seconds, start_beats, segment.bpm))
    return spans


def _span_for_seconds(grid: BeatGrid, seconds: float) -> tuple[float, float, float]:
    spans = _spans(grid)
    span = spans[0]
    for candidate in spans:
        if candidate[0] <= seconds:
            span = candidate
    return span


def seconds_to_beats(grid: BeatGrid, seconds: float) -> float:
    """Musical beats at a time, counted from the grid's first downbeat."""
    start_seconds, start_beats, bpm = _span_for_seconds(grid, seconds)
    return start_beats + (seconds - start_seconds) * (bpm / 60)


def beats_to_seconds(grid: BeatGrid, beats: float) -> float:
    """Inverse of seconds_to_beats."""
    spans = _spans(grid)
    start_seconds, start_beats, bpm = spans[-1]
    next_start: float | None = None
    for index in range(len(spans) - 1):
        if beats < spans[index + 1][1]:
            start_seconds, start_beats, bpm = spans[index]
            next_start = spans[index + 1][0]
            break
    if beats < start_beats:
        start_seconds, start_beats, bpm = spans[0]
        next_start = spans[1][0] if len(spans) > 1 else None
    seconds = start_seconds + (beats - start_beats) * (60 / bpm)
    # A forward jump at a boundary leaves a band of beats that no time maps to;
    # they clamp to the boundary instead of spilling into the next segment.
    return seconds if next_start is None else min(seconds, next_start)


def bar_beat_for_beats(beats: float, beats_per_bar: int) -> str:
    if beats < 0:
        return "1|1"
    snapped = round(beats) if abs(beats - round(beats)) < 1e-6 else beats
    bar_number = int(snapped // beats_per_bar) + 1
    beat_number = snapped % beats_per_bar + 1
    return f"{bar_number}|{_format_beat_number(beat_number)}"


def bar_beat_for_seconds(grid: BeatGrid, seconds: float) -> str:
    return bar_beat_for_beats(seconds_to_beats(grid, seconds), grid.beats_per_bar)


def beats_for_bar_beat(bar_beat: str, beats_per_bar: int) -> float:
    bar_text, beat_text = bar_beat.split("|")
    try:
        bar = int(bar_text)
        beat = float(beat_text)
    except ValueError:
        raise ValueError(f"Invalid bar beat value: {bar_beat}") from None
    return max(0.0, (bar - 1) * beats_per_bar + (beat - 1))


def _format_beat_number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")