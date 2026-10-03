import json
from pathlib import Path

from phrase2photon.contracts.beat_grid import (
    BeatGrid,
    bar_beat_for_beats,
    beats_to_seconds,
    grid_for_show,
    seconds_to_beats,
)
from phrase2photon.contracts.show_package import (
    ShowPackage,
    TempoMapSegment,
    make_example_show_package,
)

VECTORS = Path(__file__).parents[1] / "runtime" / "fixtures" / "beat-grid-vectors.json"


def _load_vectors() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def _grids() -> dict[str, BeatGrid]:
    return {
        name: BeatGrid(
            segments=[TempoMapSegment.model_validate(segment) for segment in grid["segments"]],
            beats_per_bar=grid["beats_per_bar"],
        )
        for name, grid in _load_vectors()["grids"].items()
    }


def test_twin_reproduces_the_shared_vectors() -> None:
    vectors = _load_vectors()
    for name, grid in _grids().items():
        for sample in vectors["samples"][name]:
            assert seconds_to_beats(grid, sample["seconds"]) == sample["beats"]
            # The stored beats are themselves rounded forward results, so the
            # way back may land a few ULPs off the original seconds.
            assert abs(beats_to_seconds(grid, sample["beats"]) - sample["seconds"]) < 1e-9


def test_bar_beat_formatting_matches_the_shared_vectors() -> None:
    for sample in _load_vectors()["bar_beats"]:
        assert bar_beat_for_beats(sample["beats"], 4) == sample["bar_beat"]


def test_grid_for_show_defaults_to_a_single_segment_anchored_at_zero() -> None:
    grid = grid_for_show(make_example_show_package())

    assert grid.segments == [TempoMapSegment(start_seconds=0.0, bpm=128.0, downbeat_seconds=0.0)]
    assert grid.beats_per_bar == 4
    assert seconds_to_beats(grid, 2.0) == 2 * 128 / 60


def test_grid_for_show_uses_the_tempo_map_when_present() -> None:
    package: ShowPackage = make_example_show_package().model_copy(
        update={
            "song": make_example_show_package().song.model_copy(
                update={
                    "tempo": 90.0,
                    "time_signature": "3/4",
                    "tempo_map": [TempoMapSegment(start_seconds=0.0, bpm=128.0, downbeat_seconds=0.25)],
                }
            )
        }
    )

    grid = grid_for_show(package)

    assert grid.segments == [TempoMapSegment(start_seconds=0.0, bpm=128.0, downbeat_seconds=0.25)]
    assert grid.beats_per_bar == 3
