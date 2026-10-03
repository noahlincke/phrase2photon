from pathlib import Path

from phrase2photon.compiler.service import Phrase2PhotonCompiler, scene_name_for_phrase
from phrase2photon.contracts.show_package import TempoMapSegment
from phrase2photon.extraction.models import (
    EnergySnapshot,
    LiveSetExtraction,
    LightingIntentSnapshot,
    LocatorSnapshot,
    PhraseSemanticsSnapshot,
    PhraseSnapshot,
    TrackSnapshot,
    VisualIntentSnapshot,
)


def make_test_extraction() -> LiveSetExtraction:
    return LiveSetExtraction(
        source_name="Test Song",
        tempo=124.0,
        time_signature="4/4",
        locators=[
            LocatorSnapshot(locator_id="l0", name="Intro", time="1|1", order_index=0),
            LocatorSnapshot(locator_id="l1", name="Drop 2", time="17|1", order_index=1),
        ],
        tracks=[
            TrackSnapshot(
                track_id="t_pad",
                track_index=1,
                name="Atmos Pad",
                type="audio",
                arrangement_clip_count=8,
                semantic_role="pad",
            ),
            TrackSnapshot(
                track_id="t_bass",
                track_index=2,
                name="Bass",
                type="midi",
                arrangement_clip_count=16,
                semantic_role="bass",
            ),
            TrackSnapshot(
                track_id="t_lead",
                track_index=3,
                name="Lead",
                type="midi",
                arrangement_clip_count=16,
                semantic_role="lead",
            ),
        ],
        phrases=[
            PhraseSnapshot(
                phrase_id="phrase_intro",
                name="Intro",
                start_bar_beat="1|1",
                end_bar_beat="17|1",
                locator_id="l0",
                next_locator_id="l1",
                active_track_ids=["t_pad"],
                active_track_count=1,
                active_roles=["pad"],
                active_role_counts={"pad": 1},
                semantics=PhraseSemanticsSnapshot(
                    section_kind="intro",
                    dominant_roles=["pad"],
                    transition_in_hint="fade_in",
                    transition_out_hint="build",
                    energy=EnergySnapshot(
                        score=0.22,
                        level="low",
                        rhythmic_drive=0.1,
                        harmonic_density=0.6,
                        melodic_presence=0.0,
                        bass_presence=0.0,
                        fx_presence=0.0,
                    ),
                    visual_intent=VisualIntentSnapshot(
                        palette="smoke-cool",
                        motion="slow_drift",
                        density="sparse",
                        contrast="low",
                    ),
                    lighting_intent=LightingIntentSnapshot(
                        intensity=0.28,
                        movement="slow_sweep",
                        strobe_bias=False,
                        laser_emphasis=False,
                    ),
                ),
            ),
            PhraseSnapshot(
                phrase_id="phrase_drop_2",
                name="Drop 2",
                start_bar_beat="17|1",
                end_bar_beat="33|1",
                locator_id="l1",
                active_track_ids=["t_bass", "t_lead"],
                active_track_count=2,
                active_roles=["bass", "lead"],
                active_role_counts={"bass": 1, "lead": 1},
                semantics=PhraseSemanticsSnapshot(
                    section_kind="drop",
                    dominant_roles=["bass", "lead"],
                    transition_in_hint="impact",
                    transition_out_hint="release",
                    energy=EnergySnapshot(
                        score=0.88,
                        level="peak",
                        rhythmic_drive=0.9,
                        harmonic_density=0.2,
                        melodic_presence=0.8,
                        bass_presence=0.9,
                        fx_presence=0.2,
                    ),
                    visual_intent=VisualIntentSnapshot(
                        palette="acid-contrast",
                        motion="beat_locked_cuts",
                        density="dense",
                        contrast="high",
                    ),
                    lighting_intent=LightingIntentSnapshot(
                        intensity=0.9,
                        movement="beat_chase",
                        strobe_bias=True,
                        laser_emphasis=True,
                    ),
                ),
            ),
        ],
    )


def test_compile_to_directory_writes_runtime_files(tmp_path: Path) -> None:
    compiler = Phrase2PhotonCompiler()
    result = compiler.compile_to_directory(make_test_extraction(), tmp_path)

    assert result.show_package.song.title == "Test Song"
    assert len(result.show_package.phrases) == 2
    assert len(result.show_package.lighting_cues) == 2
    assert len(result.show_package.dmx_laser_cues) == 1

    expected = {
        "show.json",
        "phrases.csv",
        "lighting_cues.csv",
        "laser_dmx_cues.csv",
        "phrase_scene_map.csv",
        "fixture_map.json",
        "runtime_overrides.json",
    }
    assert expected == {path.name for path in result.written_files}
    assert (tmp_path / "phrases.csv").read_text(encoding="utf-8").startswith("phrase_id,")


def test_scene_name_for_phrase_is_runtime_safe() -> None:
    assert scene_name_for_phrase("phrase_intro") == "scene_intro"
    assert scene_name_for_phrase("phrase_drop-2") == "scene_drop_2"


def test_compiled_show_carries_the_measured_downbeat() -> None:
    compiler = Phrase2PhotonCompiler()
    extraction = make_test_extraction().model_copy(update={"first_downbeat_seconds": 0.487})

    show = compiler.compile(extraction)

    assert show.song.tempo_map == [
        TempoMapSegment(start_seconds=0.0, bpm=124.0, downbeat_seconds=0.487)
    ]


def test_compiled_show_omits_the_tempo_map_without_a_downbeat() -> None:
    compiler = Phrase2PhotonCompiler()

    show = compiler.compile(make_test_extraction())

    assert show.song.tempo_map is None
