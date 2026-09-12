#!/usr/bin/env python3
"""Export Mixed In Key ground truth to JSON for the analysis benchmark.

Mixed In Key stores a full static analysis per track: the tempo it settled on,
the complete beat grid, 8-bar energy segments (1-10) and the cue points it
places at energy changes. That is a far better reference than hand-labelling,
so the beat/phrase detector is scored against it directly.

Usage:
    python3 scripts/mik_export.py --out .analysis-cache/mik-truth.json
"""
from __future__ import annotations

import argparse
import json
import plistlib
import re
import sqlite3
from pathlib import Path

DEFAULT_DB = Path("~/Library/Application Support/Mixedinkey/Collection11.mikdb").expanduser()
AUDIO_SUFFIXES = ("mp3", "wav", "aiff", "aif", "flac", "m4a")


def normalize_extracted_path(raw: str) -> str:
    path = (raw or "").strip()
    if path.startswith("file:///"):
        path = path.replace("file://", "", 1)
    if "\x00" in path:
        return ""
    volume_index = path.find("/Volumes/")
    if volume_index > 0:
        path = path[volume_index:]
    return re.sub(r"^/+", "/", path)


def extract_path(bookmark: bytes | None) -> str:
    """Pull the POSIX path out of a macOS security-scoped bookmark blob.

    The bookmark format is undocumented, but the path survives as readable
    text, so a targeted regex over both plausible encodings is enough.
    """
    if not bookmark:
        return ""
    suffixes = "|".join(AUDIO_SUFFIXES)
    patterns = (
        rf"(file:///[-A-Za-z0-9_ ./,'()&!\[\]]+?\.(?:{suffixes}))",
        rf"(/[-A-Za-z0-9_ ./,'()&!\[\]]+?\.(?:{suffixes}))",
    )
    for encoding in ("utf-8", "latin1"):
        text = bookmark.decode(encoding, errors="ignore")
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                candidate = normalize_extracted_path(match.group(1))
                if candidate:
                    return candidate

    # Fall back to reassembling path components after the volume marker.
    text = bookmark.decode("latin1", errors="ignore")
    tokens = [
        match.group(0).strip()
        for match in re.finditer(r"[A-Za-z0-9_ .,'()&!\[\]-]+", text)
        if match.group(0).strip()
    ]
    for index, token in enumerate(tokens):
        if token != "Volumes":
            continue
        segments: list[str] = []
        for segment in tokens[index:]:
            cleaned = segment.strip(" /")
            if not cleaned:
                continue
            segments.append(cleaned)
            if re.search(rf"\.({suffixes})$", cleaned, re.IGNORECASE):
                return normalize_extracted_path("/" + "/".join(segments))
    return ""


def decode_beat_times(blob: bytes | None) -> list[float]:
    """Decode the NSKeyedArchiver-wrapped MIKBeats object."""
    if not blob:
        return []
    try:
        archive = plistlib.loads(blob)
    except Exception:
        return []
    objects = archive.get("$objects")
    if not isinstance(objects, list):
        return []
    for entry in objects:
        if not isinstance(entry, dict) or "MIKBeats_beatTimes" in entry:
            break
    else:
        return []

    beats_holder = next(
        (entry for entry in objects if isinstance(entry, dict) and "MIKBeats_beatTimes" in entry),
        None,
    )
    if beats_holder is None:
        return []
    times_uid = beats_holder["MIKBeats_beatTimes"]
    container = objects[times_uid.data if hasattr(times_uid, "data") else int(times_uid)]
    if not isinstance(container, dict):
        return []
    times: list[float] = []
    for uid in container.get("NS.objects", []):
        index = uid.data if hasattr(uid, "data") else int(uid)
        value = objects[index]
        if isinstance(value, (int, float)):
            times.append(float(value))
    return times


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--require-existing-file",
        action="store_true",
        default=True,
        help="Only export songs whose audio file is currently reachable.",
    )
    args = parser.parse_args()

    connection = sqlite3.connect(f"file:{args.db}?mode=ro&immutable=1", uri=True)
    songs = connection.execute(
        """
        SELECT Z_PK, ZNAME, ZARTIST, ZTEMPO, ZKEY, ZENERGY, ZBOOKMARKDATA, ZBEATS
        FROM ZSONG
        WHERE ZTEMPO IS NOT NULL
        ORDER BY Z_PK
        """
    ).fetchall()

    segments_by_song: dict[int, list[dict]] = {}
    for song_id, start, length, energy in connection.execute(
        "SELECT ZSONG, ZSTARTTIME, ZLENGTH, ZENERGY FROM ZENERGYSEGMENT ORDER BY ZSONG, ZSTARTTIME"
    ):
        if song_id is None:
            continue
        segments_by_song.setdefault(int(song_id), []).append(
            {"start": float(start or 0.0), "length": float(length or 0.0), "energy": float(energy or 0.0)}
        )

    cues_by_song: dict[int, list[dict]] = {}
    for song_id, time, energy in connection.execute(
        "SELECT ZSONG, ZTIME, ZENERGYLEVEL FROM ZCUEPOINT ORDER BY ZSONG, ZTIME"
    ):
        if song_id is None:
            continue
        cues_by_song.setdefault(int(song_id), []).append(
            {"time": float(time or 0.0), "energy": int(energy or 0)}
        )

    exported = []
    skipped_no_path = 0
    skipped_missing = 0
    for song_id, name, artist, tempo, key, energy, bookmark, beats in songs:
        path = extract_path(bookmark)
        if not path:
            skipped_no_path += 1
            continue
        if args.require_existing_file and not Path(path).is_file():
            skipped_missing += 1
            continue
        beat_times = decode_beat_times(beats)
        exported.append(
            {
                "songId": int(song_id),
                "title": name or "",
                "artist": artist or "",
                "path": path,
                "bpm": float(tempo),
                "key": key or None,
                "energy": float(energy) if energy is not None else None,
                "beatTimes": beat_times,
                "energySegments": segments_by_song.get(int(song_id), []),
                "cuePoints": cues_by_song.get(int(song_id), []),
            }
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"version": 1, "songs": exported}, indent=None))
    print(
        f"exported {len(exported)} songs "
        f"({skipped_no_path} without a recoverable path, {skipped_missing} with a missing file) "
        f"-> {args.out}"
    )


if __name__ == "__main__":
    main()
