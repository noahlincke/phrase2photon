from pathlib import Path

from phrase2photon.contracts.show_package import ShowPackage, make_example_show_package


def test_example_package_round_trips() -> None:
    example = make_example_show_package()
    restored = ShowPackage.model_validate_json(example.model_dump_json())

    assert restored.song.title == "Example Song"
    assert restored.phrases[1].phrase_id == "phrase_drop_a"
    assert restored.dmx_laser_cues[0].fixture_group == "laser_main"


def test_schema_contains_expected_v0_fields() -> None:
    schema = ShowPackage.model_json_schema()
    properties = schema["properties"]

    assert "lighting_cues" in properties
    assert "dmx_laser_cues" in properties
    assert "manual_overrides" in properties
    assert "phrases" in properties
    assert "preset_catalog" in properties
    assert "phrase_visual_assignments" in properties


def test_committed_example_fixture_matches_the_compiler() -> None:
    """The runtime's contract test reads a committed copy of this payload.

    A checked-in copy of generated output goes stale silently, so assert here
    that it still matches what the compiler produces. If this fails, refresh it:

        python -m phrase2photon.cli example --out runtime/fixtures/example-show.json
    """
    fixture = Path(__file__).resolve().parents[1] / "runtime" / "fixtures" / "example-show.json"
    # Matches how the CLI writes it, trailing newline included.
    expected = make_example_show_package().model_dump_json(indent=2) + "\n"

    assert fixture.exists(), f"missing runtime fixture at {fixture}"
    assert fixture.read_text() == expected, (
        "runtime/fixtures/example-show.json is out of date with the compiler"
    )
