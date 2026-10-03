"""End-to-end test for pre-generating a show for a multi-track recording.

The wedding plays ~60-minute Apple Music automixes from Rekordbox as one
track. This test builds a small stand-in recording - two click tracks at
different tempos, crossfaded like an automix - with a cue sheet, runs the
real preparation pipeline over it, and checks the assembled show stays on
beat across the tempo change.
"""

import json
import math
import wave
from pathlib import Path

import pytest

from phrase2photon.contracts.beat_grid import BeatGrid, seconds_to_beats
from phrase2photon.contracts.show_package import TempoMapSegment
from phrase2photon.now_playing.prepare import prepare_show_entry
from phrase2photon.now_playing.track_analysis import TrackAnalysis, analyzer_available

pytestmark = pytest.mark.skipif(
    not analyzer_available(),
    reason="analyser bundle not built (cd runtime && npm run build:analyzer)",
)

CROSSFADE_START = 54.0
CROSSFADE_END = 60.0
TOTAL_SECONDS = 114.0
SAMPLE_RATE = 8000


def _click(track: list[float], bpm: float, start: float, end: float) -> None:
    period = 60.0 / bpm
    beat = 0
    while True:
        moment = start + beat * period
        if moment >= end:
            return
        accent = beat % 4 == 0
        amplitude = 0.9 if accent else 0.35
        first = int(moment * SAMPLE_RATE)
        for offset in range(int(0.05 * SAMPLE_RATE)):
            seconds = offset / SAMPLE_RATE
            sample = amplitude * math.exp(-seconds * 60) * math.sin(
                2 * math.pi * (900 if accent else 1300) * seconds
            )
            index = first + offset
            if index < len(track):
                track[index] += sample
        beat += 1


def _write_recording(path: Path) -> None:
    import array

    count = int(TOTAL_SECONDS * SAMPLE_RATE)
    track_a = [0.0] * count
    track_b = [0.0] * count
    _click(track_a, 128.0, 0.0, CROSSFADE_END)
    _click(track_b, 100.0, CROSSFADE_START, TOTAL_SECONDS)

    frames = array.array("h")
    for index in range(count):
        seconds = index / SAMPLE_RATE
        if seconds < CROSSFADE_START:
            gain_a, gain_b = 1.0, 0.0
        elif seconds < CROSSFADE_END:
            gain_a = (CROSSFADE_END - seconds) / (CROSSFADE_END - CROSSFADE_START)
            gain_b = 1.0 - gain_a
        else:
            gain_a, gain_b = 0.0, 1.0
        mixed = track_a[index] * gain_a + track_b[index] * gain_b
        frames.append(int(max(-1.0, min(1.0, mixed)) * 32000))

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(frames.tobytes())


def _cue_sheet_entry(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "title": "Wedding Automix",
        "artist": "Apple Music",
        "label": "first-half",
        "segments": [
            {"title": "Track A", "artist": "Artist A", "start_seconds": 0.0, "full_seconds": 0.0},
            {
                "title": "Track B",
                "artist": "Artist B",
                "start_seconds": CROSSFADE_START,
                "full_seconds": CROSSFADE_END,
            },
        ],
    }


def test_prepare_recording_stays_on_beat_across_the_tempo_change(tmp_path: Path) -> None:
    audio_path = tmp_path / "wedding-automix.wav"
    _write_recording(audio_path)

    row = prepare_show_entry(_cue_sheet_entry(audio_path), cache_root=tmp_path / "cache")

    assert row["status"] == "ok", row["problems"]
    assert row["track_count"] == 2
    show = json.loads((Path(str(row["show_dir"])) / "show.json").read_text(encoding="utf-8"))
    tempo_map = show["song"]["tempo_map"]
    assert [segment["start_seconds"] for segment in tempo_map] == [0.0, 57.0]
    assert abs(tempo_map[0]["bpm"] - 128.0) <= 1.0
    assert abs(tempo_map[1]["bpm"] - 100.0) <= 1.0

    # Clicks land on whole beats of the assembled grid, in both segments.
    grid = BeatGrid(
        segments=[TempoMapSegment.model_validate(segment) for segment in tempo_map],
        beats_per_bar=4,
    )
    click_times = [4.6875, 7.5, 12.65625] + [61.2, 66.0, 72.0]
    for seconds in click_times:
        beats = seconds_to_beats(grid, seconds)
        assert abs(beats - round(beats)) <= 0.05, f"{seconds}s landed on {beats} beats"


def test_prepare_recording_reuses_the_single_track_cache_identity(tmp_path: Path) -> None:
    audio_path = tmp_path / "wedding-automix.wav"
    _write_recording(audio_path)

    first = prepare_show_entry(_cue_sheet_entry(audio_path), cache_root=tmp_path / "cache")
    second = prepare_show_entry(_cue_sheet_entry(audio_path), cache_root=tmp_path / "cache")

    assert first["identity"] == second["identity"]
    assert second["status"] == "ok"


def _fake_cut_analysis(duration: float, tempo: float) -> TrackAnalysis:
    return TrackAnalysis(
        tempo=tempo,
        duration_seconds=duration,
        first_downbeat_seconds=0.0,
        tempo_confidence=1.0,
        downbeat_confidence=1.0,
        sections=[
            {"start_seconds": 0.0, "end_seconds": duration / 2, "label": "intro", "energy": "low"},
            {"start_seconds": duration / 2, "end_seconds": duration, "label": "groove", "energy": "mid"},
        ],
    )


def test_prepare_recording_falls_back_to_the_cue_sheet_bpm(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "wedding-automix.wav"
    _write_recording(audio_path)
    monkeypatch.setattr("phrase2photon.now_playing.prepare.analyze_track", lambda _path, **_: None)

    entry = _cue_sheet_entry(audio_path)
    entry["segments"][0]["bpm"] = 128.0
    entry["segments"][1]["bpm"] = 100.0

    row = prepare_show_entry(entry, cache_root=tmp_path / "cache")

    # The declared tempos keep the grid honest, but preparation still reports
    # that the analyser did not measure them.
    assert row["status"] == "failed"
    assert row["problems"] == ["compiled with the fallback tempo heuristic instead of the analyser"]
    show = json.loads((Path(str(row["show_dir"])) / "show.json").read_text(encoding="utf-8"))
    assert [segment["bpm"] for segment in show["song"]["tempo_map"]] == [128.0, 100.0]


def test_prepare_recording_flags_a_tempo_outside_the_valid_range(tmp_path: Path, monkeypatch) -> None:
    audio_path = tmp_path / "wedding-automix.wav"
    _write_recording(audio_path)
    monkeypatch.setattr(
        "phrase2photon.now_playing.prepare.analyze_track",
        lambda _path, **_: _fake_cut_analysis(57.0, 300.0),
    )

    row = prepare_show_entry(_cue_sheet_entry(audio_path), cache_root=tmp_path / "cache")

    assert row["status"] == "failed"
    assert "track 0 tempo 300 is outside 60-200" in row["problems"]
    assert "track 1 tempo 300 is outside 60-200" in row["problems"]