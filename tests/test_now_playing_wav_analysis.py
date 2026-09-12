from pathlib import Path

from phrase2photon.now_playing.wav_analysis import (
    _detect_structural_sections_from_bar_energy,
    build_wav_analysis_extraction,
)


def test_build_wav_analysis_extraction_produces_phrase_ranges_and_energy_from_section_timing() -> None:
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
    assert extraction.time_signature == "4/4"
    assert [phrase.start_bar_beat for phrase in extraction.phrases] == ["1|1", "125|1"]
    assert extraction.phrases[0].end_bar_beat == "125|1"
    assert extraction.phrases[1].semantics.energy.level == "peak"
    assert extraction.phrases[1].semantics.visual_intent.palette == "acid-contrast"


def test_build_wav_analysis_extraction_preserves_fractional_beat_positions() -> None:
    extraction = build_wav_analysis_extraction(
        audio_path=Path("/tmp/off-grid.wav"),
        title="Off Grid",
        artist=None,
        duration_seconds=30.0,
        tempo=120.0,
        sections=[
            {"label": "tease", "start_seconds": 2.25, "end_seconds": 4.75, "energy": "mid"},
            {"label": "drop", "start_seconds": 4.75, "end_seconds": 7.25, "energy": "peak"},
        ],
    )

    assert extraction.phrases[0].start_bar_beat == "2|1.5"
    assert extraction.phrases[0].end_bar_beat == "3|2.5"
    assert extraction.phrases[1].start_bar_beat == "3|2.5"
    assert extraction.phrases[1].end_bar_beat == "4|3.5"


def test_build_wav_analysis_extraction_subdivides_long_sections_around_lift_and_drop() -> None:
    extraction = build_wav_analysis_extraction(
        audio_path=Path("/tmp/structural-house.wav"),
        title="Structural House",
        artist="DJ Example",
        duration_seconds=352.0,
        tempo=120.0,
        sections=[
            {"label": "intro", "start_seconds": 0.0, "end_seconds": 64.0, "energy": "low"},
            {"label": "groove", "start_seconds": 64.0, "end_seconds": 160.0, "energy": "mid"},
            {"label": "lift", "start_seconds": 160.0, "end_seconds": 192.0, "energy": "high"},
            {"label": "drop", "start_seconds": 192.0, "end_seconds": 256.0, "energy": "peak"},
            {"label": "groove", "start_seconds": 256.0, "end_seconds": 320.0, "energy": "high"},
            {"label": "outro", "start_seconds": 320.0, "end_seconds": 352.0, "energy": "low"},
        ],
    )

    assert [phrase.start_bar_beat for phrase in extraction.phrases] == [
        "1|1",
        "17|1",
        "33|1",
        "49|1",
        "65|1",
        "81|1",
        "97|1",
        "113|1",
        "129|1",
        "145|1",
        "161|1",
    ]
    assert [phrase.name for phrase in extraction.phrases] == [
        "Intro",
        "Groove",
        "Groove 2",
        "Groove 3",
        "Groove 4",
        "Lift",
        "Drop",
        "Groove 5",
        "Groove 6",
        "Groove 7",
        "Outro",
    ]
    assert extraction.phrases[5].semantics.section_kind == "lift"
    assert extraction.phrases[6].semantics.section_kind == "drop"
    assert extraction.phrases[5].semantics.lighting_intent.laser_emphasis is True
    assert extraction.phrases[6].semantics.lighting_intent.laser_emphasis is True


def test_detect_structural_sections_from_bar_energy_marks_lift_before_drop() -> None:
    sections = _detect_structural_sections_from_bar_energy(
        [0.12] * 16
        + [0.28] * 16
        + [0.42] * 16
        + [0.74] * 8
        + [0.96] * 16
        + [0.64] * 24
        + [0.18] * 8,
        tempo=120.0,
    )

    labels = [section["label"] for section in sections]
    assert labels == ["intro", "groove", "lift", "drop", "groove", "outro"]
    assert sections[2]["start_seconds"] == 96.0
    assert sections[3]["start_seconds"] == 128.0
