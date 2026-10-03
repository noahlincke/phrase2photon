"""Rekordbox's own beat grid and phrase structure, read from its ANLZ files.

The runtime analyser gets the downbeat phase wrong about half the time, so
downbeat-timed laser looks land on beat 2. For a live set every track is
analysed in Rekordbox and Noah fixes those beat grids by hand, so the ANLZ
files are the exact source: PQTZ in the .DAT holds every beat with its time and
bar position (beat 1 = downbeat), and PSSI in the .EXT holds the phrase
structure when phrase analysis ran.

Rekordbox is only ever read here. master.db is sqlcipher-encrypted; we copy it
to a temp file and open the copy, so a stray WAL checkpoint or recovery write
can never touch the real database.
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from phrase2photon.contracts.show_package import TempoMapSegment


@dataclass(frozen=True)
class RekordboxPhrase:
    start_seconds: float
    end_seconds: float
    label: str
    energy: str


@dataclass(frozen=True)
class RekordboxAnalysis:
    tempo_map: list[TempoMapSegment]
    phrases: list[RekordboxPhrase]
    anlz_files: tuple[Path, ...]
    bar_times: tuple[float, ...]


def snap_sections_to_bar_grid(sections, analysis: RekordboxAnalysis) -> list[dict]:
    """Moves every section boundary to the nearest rekordbox bar (beat 1).

    Adjacent sections share the snapped boundary so the map still tiles the
    track; material before the first bar is part of the first phrase because
    bar|beat clamps it to 1|1.
    """
    snapped = [dict(section) for section in sections]
    boundaries = [float(section["start_seconds"]) for section in snapped]
    boundaries.append(float(snapped[-1]["end_seconds"]))
    snapped_boundaries = [
        min(analysis.bar_times, key=lambda bar_time: abs(bar_time - boundary))
        for boundary in boundaries
    ]
    for index, section in enumerate(snapped):
        section["start_seconds"] = snapped_boundaries[index]
        section["end_seconds"] = snapped_boundaries[index + 1]
    return snapped


def load_rekordbox_analysis(audio_path: Path) -> RekordboxAnalysis | None:
    """Finds the Rekordbox content for this exact file and parses its ANLZ.

    Returns None when the file is not in the collection or has no beat grid,
    which is the normal case for provider-downloaded tracks.
    """
    found = _with_rekordbox_content(audio_path, _analyse_content)
    if found is None:
        return None
    tempo_map, phrases, bar_times, anlz_files = found
    if not tempo_map:
        return None
    return RekordboxAnalysis(tempo_map=tempo_map, phrases=phrases, bar_times=bar_times, anlz_files=anlz_files)


def _with_rekordbox_content(audio_path, use_content):
    """Looks the file up in a copy of master.db and hands the row to use_content.

    Everything that touches the Rekordbox database lives here so tests can stub
    `load_rekordbox_analysis` and never see the database at all.
    """
    db_path = _rekordbox_db_path()
    if db_path is None:
        return None
    from pyrekordbox import Rekordbox6Database
    import pyrekordbox.db6.tables as tables

    with tempfile.TemporaryDirectory(prefix="p2p-rekordbox-") as temp:
        copied = Path(temp) / "master.db"
        shutil.copy2(db_path, copied)
        database = Rekordbox6Database(path=copied, db_dir=db_path.parent, unlock=True)
        try:
            content = database.session.query(tables.DjmdContent).filter(
                tables.DjmdContent.FolderPath == str(audio_path)
            ).first()
            if content is None or not content.AnalysisDataPath:
                return None
            return use_content(content, database)
        finally:
            database.session.close()


def _rekordbox_db_path() -> Path | None:
    path = Path.home() / "Library/Pioneer/rekordbox/master.db"
    return path if path.is_file() else None


def _analyse_content(content, database):
    from pyrekordbox import anlz

    paths = database.get_anlz_paths(content)
    dat_path = paths.get("DAT")
    if dat_path is None or not dat_path.is_file():
        return None
    dat_file = anlz.AnlzFile.parse_file(str(dat_path))
    pqtz = dat_file.getall_tags("PQTZ")
    if not pqtz:
        return None
    beats = pqtz[0].get_beats()
    times = pqtz[0].get_times()
    bpms = pqtz[0].get_bpms()

    anlz_files = [dat_path]
    phrases = _phrases_from_ext(paths.get("EXT"), beats, times, anlz_files)
    bar_times = tuple(times[index] for index, beat in enumerate(beats) if beat == 1)
    return _tempo_map(beats, times, bpms), phrases, bar_times, tuple(anlz_files)


def _tempo_map(beats, times, bpms) -> list[TempoMapSegment]:
    """One segment per stretch of constant tempo, first starting at 0.

    A segment's downbeat is the most recent beat-1 at or before it starts: that
    anchors the bar count to the grid rekordbox plays, even when the tempo
    changes mid-bar and the segment's grid has to extend backwards.
    """
    first_downbeat = next((times[index] for index, beat in enumerate(beats) if beat == 1), times[0])
    latest_downbeat = times[0]
    downbeat_for_index: list[float] = []
    for index, beat in enumerate(beats):
        if beat == 1:
            latest_downbeat = times[index]
        downbeat_for_index.append(latest_downbeat)

    segments: list[TempoMapSegment] = []
    start_index = 0
    for index in range(len(beats)):
        if index + 1 == len(beats) or bpms[index + 1] != bpms[start_index]:
            segments.append(
                TempoMapSegment(
                    start_seconds=0.0 if not segments else times[start_index],
                    bpm=bpms[start_index],
                    downbeat_seconds=first_downbeat if not segments else downbeat_for_index[start_index],
                )
            )
            start_index = index + 1
    return segments


def _phrases_from_ext(ext_path, beats, times, anlz_files) -> list[RekordboxPhrase]:
    """PSSI phrase entries as Phrase2Photon sections, or [] when absent.

    Each PSSI entry carries a 1-based beat number into the PQTZ grid, so a
    phrase starts where the grid says that beat starts. Phrase ends chain from
    the next entry; the last one ends at the grid's final analysed beat.
    """
    if ext_path is None or not ext_path.is_file() or b"PSSI" not in ext_path.read_bytes():
        return []
    from pyrekordbox import anlz

    ext_file = anlz.AnlzFile.parse_file(str(ext_path))
    pssi = ext_file.getall_tags("PSSI")
    if not pssi:
        return []
    anlz_files.append(ext_path)
    structure = pssi[0].content

    phrases: list[RekordboxPhrase] = []
    for entry, next_entry in zip(structure.entries, list(structure.entries[1:]) + [None]):
        start = _beat_time(times, entry.beat)
        end = _beat_time(times, next_entry.beat if next_entry else structure.end_beat)
        label, energy = _phrase_label(mood=structure.mood, kind=entry.kind)
        phrases.append(RekordboxPhrase(start_seconds=start, end_seconds=end, label=label, energy=energy))
    return phrases


def _beat_time(times, beat_number) -> float:
    """Grid time of a 1-based PSSI beat number."""
    return times[min(beat_number, len(times)) - 1]


# PSSI kinds are mood-dependent (pyrekordbox ANLZ docs, verified against this
# collection's 378 PSSI files): mood 1 (High) uses 1=Intro, 2=Up, 3=Down,
# 5=Chorus, 6=Outro; moods 2/3 (Mid/Low) use 1=Intro, verses for 2..7, 8=Bridge,
# 9=Chorus, 10=Outro. Verses and Bridge have no counterpart in the runtime's
# six phrase kinds, so they become the neutral "Groove" the analyser uses for
# body sections. Energies follow the live phrase table in runtime/src/app/liveShow.ts.
_PHRASE_LABELS = {
    1: ("Intro", "low"),
    2: ("Build", "high"),
    3: ("Breakdown", "low"),
    5: ("Drop", "peak"),
    6: ("Outro", "low"),
    9: ("Drop", "peak"),
    10: ("Outro", "low"),
}
GROOVE_LABEL = ("Groove", "mid")


def _phrase_label(*, mood: int, kind: int) -> tuple[str, str]:
    if mood != 1 and kind in {2, 3, 4, 5, 6, 7, 8}:
        return GROOVE_LABEL
    return _PHRASE_LABELS.get(kind, GROOVE_LABEL)