from phrase2photon.extraction.models import ArrangementClipSnapshot, LocatorSnapshot, TrackSnapshot
from phrase2photon.extraction.pipeline import bar_beat_sort_key, classify_track_role, derive_phrases


def test_bar_beat_sort_key_handles_locator_sorting() -> None:
    assert bar_beat_sort_key("1|1") < bar_beat_sort_key("9|1")
    assert bar_beat_sort_key("104|4.978") < bar_beat_sort_key("120|4.956")


def test_classify_track_role_uses_track_and_group_names() -> None:
    assert classify_track_role("Main Vocs", "Vocal Group") == "vocal"
    assert classify_track_role("Transition Pad", "PAd") == "pad"
    assert classify_track_role("Crash", "FX Group") == "fx"


def test_derive_phrases_assigns_active_tracks_by_locator_window() -> None:
    locators = [
        LocatorSnapshot(locator_id="locator-14", name="Pad Only", time="1|1", order_index=14),
        LocatorSnapshot(locator_id="locator-0", name="Intro", time="9|1", order_index=0),
        LocatorSnapshot(locator_id="locator-1", name="2", time="17|1", order_index=1),
    ]
    tracks = [
        TrackSnapshot(
            track_id="t1",
            track_index=1,
            name="Atmos Pad",
            type="audio",
            semantic_role="pad",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c1", arrangement_start="1|1")],
        ),
        TrackSnapshot(
            track_id="t2",
            track_index=2,
            name="Main Vocs",
            type="audio",
            semantic_role="vocal",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c2", arrangement_start="9|1")],
        ),
    ]

    phrases = derive_phrases(locators, tracks)

    assert phrases[0].name == "Pad Only"
    assert phrases[0].active_track_ids == ["t1"]
    assert phrases[0].semantics.section_kind == "strip"
    assert phrases[0].semantics.energy.level == "low"
    assert phrases[1].name == "Intro"
    assert phrases[1].active_track_ids == ["t2"]
    assert phrases[1].semantics.section_kind == "intro"
    assert phrases[1].semantics.transition_in_hint == "fade_in"


def test_derive_phrases_infers_drop_semantics() -> None:
    locators = [
        LocatorSnapshot(locator_id="l0", name="Breakdown", time="1|1", order_index=0),
        LocatorSnapshot(locator_id="l1", name="Drop 2", time="17|1", order_index=1),
        LocatorSnapshot(locator_id="l2", name="Outro", time="33|1", order_index=2),
    ]
    tracks = [
        TrackSnapshot(
            track_id="kick",
            track_index=1,
            name="Kick",
            type="audio",
            semantic_role="kick",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c1", arrangement_start="17|1")],
        ),
        TrackSnapshot(
            track_id="snare",
            track_index=2,
            name="Snare",
            type="audio",
            semantic_role="snare",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c2", arrangement_start="17|1")],
        ),
        TrackSnapshot(
            track_id="hat",
            track_index=3,
            name="Closed Hat",
            type="audio",
            semantic_role="hihat",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c3", arrangement_start="17|1")],
        ),
        TrackSnapshot(
            track_id="bass",
            track_index=4,
            name="Bass",
            type="midi",
            semantic_role="bass",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c4", arrangement_start="17|1")],
        ),
        TrackSnapshot(
            track_id="lead",
            track_index=5,
            name="Lead",
            type="midi",
            semantic_role="lead",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c5", arrangement_start="17|1")],
        ),
        TrackSnapshot(
            track_id="chords",
            track_index=6,
            name="Chords",
            type="midi",
            semantic_role="chords",
            arrangement_clips=[ArrangementClipSnapshot(clip_id="c6", arrangement_start="17|1")],
        ),
    ]

    phrases = derive_phrases(locators, tracks)
    drop = phrases[1]

    assert drop.name == "Drop 2"
    assert drop.semantics.section_kind == "drop"
    assert drop.semantics.energy.level in {"high", "peak"}
    assert drop.semantics.lighting_intent.strobe_bias is True
    assert drop.semantics.transition_in_hint == "impact"
    assert drop.semantics.transition_out_hint == "release"
