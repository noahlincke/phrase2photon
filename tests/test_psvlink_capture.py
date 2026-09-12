"""Tests for the PSvLink capture decoder.

Built around a synthetic pcap so the parsing and the playhead search can be
checked without rekordbox running - and so that when a real capture comes back
empty we know it is rekordbox being quiet rather than this being broken.
"""

from __future__ import annotations

import importlib.util
import json
import struct
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "psvlink_capture.py"
_spec = importlib.util.spec_from_file_location("psvlink_capture", SCRIPT)
assert _spec is not None and _spec.loader is not None
psvlink = importlib.util.module_from_spec(_spec)
# dataclasses resolves annotations through sys.modules, so register before exec.
sys.modules["psvlink_capture"] = psvlink
_spec.loader.exec_module(psvlink)


# Where the test writes the second magic. The disassembly notes only say it
# sits in "the next identifier region" without pinning an offset, and 0x0a is
# spoken for by the message type, so this is a guess that avoids the collision.
# The parser searches for it rather than assuming, which is why that is safe.
SECOND_MAGIC_OFFSET = 0x0B


def psvlink_frame(*, message_type: int, family: int, payload: bytes) -> bytes:
    header = bytearray(psvlink.HEADER_SIZE)
    header[0 : len(psvlink.MAGIC)] = psvlink.MAGIC
    header[SECOND_MAGIC_OFFSET : SECOND_MAGIC_OFFSET + len(psvlink.SECOND_MAGIC)] = psvlink.SECOND_MAGIC
    header[psvlink.TYPE_OFFSET] = message_type
    header[psvlink.FAMILY_OFFSET] = family
    struct.pack_into(">H", header, psvlink.PAYLOAD_LENGTH_OFFSET, len(payload))
    return bytes(header) + payload


def write_pcap(path: Path, packets: list[tuple[float, int, int, bytes]]) -> None:
    """Writes a DLT_NULL (loopback) pcap, which is what tcpdump -i lo0 gives."""
    out = bytearray()
    out += struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, psvlink.DLT_NULL)
    for timestamp, src_port, dst_port, payload in packets:
        udp = struct.pack(">HHHH", src_port, dst_port, len(payload) + 8, 0) + payload
        ip = (
            struct.pack(">BBHHHBBH", 0x45, 0, 20 + len(udp), 0, 0, 64, 17, 0)
            + bytes([127, 0, 0, 1])
            + bytes([127, 0, 0, 1])
        )
        frame = struct.pack("<I", 2) + ip + udp
        seconds = int(timestamp)
        micros = int(round((timestamp - seconds) * 1_000_000))
        out += struct.pack("<IIII", seconds, micros, len(frame), len(frame))
        out += frame
    path.write_bytes(bytes(out))


def deck_capture(
    tmp_path: Path,
    *,
    play_seconds: float = 12.0,
    pause_seconds: float = 5.0,
    after_seek_seconds: float = 8.0,
    sample_rate: float = 44100.0,
    interval: float = 0.05,
) -> tuple[Path, list[dict[str, object]]]:
    """A capture of a deck playing, pausing, resuming, and being jumped."""
    packets: list[tuple[float, int, int, bytes]] = []
    markers: list[dict[str, object]] = []
    base = 1_700_000_000.0
    now = base
    samples = 3_000_000
    sequence = 0

    def emit() -> None:
        nonlocal sequence
        payload = bytearray(32)
        # A sequence counter, to be rejected: it advances while paused too.
        struct.pack_into("<I", payload, 0, sequence)
        struct.pack_into("<Q", payload, 8, samples)
        struct.pack_into("<H", payload, 20, 128)
        sequence += 1
        packets.append((now, 51000, 50002, psvlink_frame(message_type=0x32, family=0x1F, payload=bytes(payload))))

    markers.append({"timestamp": now, "label": "play"})
    steps = int(play_seconds / interval)
    for _ in range(steps):
        emit()
        now += interval
        samples += int(sample_rate * interval)

    markers.append({"timestamp": now, "label": "pause"})
    for _ in range(int(pause_seconds / interval)):
        emit()
        now += interval

    markers.append({"timestamp": now, "label": "seek"})
    samples += int(sample_rate * 90)
    markers.append({"timestamp": now + interval, "label": "play"})
    for _ in range(int(after_seek_seconds / interval)):
        emit()
        now += interval
        samples += int(sample_rate * interval)

    capture = tmp_path / "psvlink.pcap"
    write_pcap(capture, packets)
    capture.with_suffix(".markers.json").write_text(json.dumps(markers))
    return capture, markers


def test_reads_udp_payloads_from_a_loopback_pcap(tmp_path: Path) -> None:
    frame = psvlink_frame(message_type=0x32, family=0x1F, payload=b"\x01\x02\x03\x04")
    capture = tmp_path / "one.pcap"
    write_pcap(capture, [(1_700_000_000.5, 51000, 50002, frame)])

    packets = psvlink.iter_udp_payloads(capture)
    assert len(packets) == 1
    timestamp, src_port, dst_port, payload = packets[0]
    assert timestamp == pytest.approx(1_700_000_000.5)
    assert (src_port, dst_port) == (51000, 50002)
    assert payload == frame


def test_rejects_a_file_that_is_not_a_pcap(tmp_path: Path) -> None:
    bad = tmp_path / "bad.pcap"
    bad.write_bytes(b"this is not a capture at all, not even close")
    with pytest.raises(ValueError, match="not a pcap"):
        psvlink.iter_udp_payloads(bad)


def test_keeps_only_datagrams_carrying_the_psvlink_magic() -> None:
    good = psvlink_frame(message_type=0x27, family=0x20, payload=b"\xaa" * 8)
    packets = [
        (1.0, 51000, 50002, good),
        (1.1, 51000, 50002, b"unrelated traffic on the same port"),
        (1.2, 51000, 50002, b"short"),
    ]
    frames = psvlink.parse_frames(packets)
    assert len(frames) == 1
    assert frames[0].message_type == 0x27
    assert frames[0].family == 0x20
    assert frames[0].payload == b"\xaa" * 8


def test_truncates_the_payload_to_the_declared_length() -> None:
    frame = psvlink_frame(message_type=0x32, family=0x1F, payload=b"\x01\x02") + b"trailing junk"
    frames = psvlink.parse_frames([(1.0, 51000, 50002, frame)])
    assert frames[0].payload == b"\x01\x02"


def test_finds_the_playhead_and_not_the_sequence_counter(tmp_path: Path) -> None:
    capture, marker_rows = deck_capture(tmp_path)
    frames = psvlink.parse_frames(psvlink.iter_udp_payloads(capture))
    markers = [psvlink.Marker(timestamp=float(row["timestamp"]), label=str(row["label"])) for row in marker_rows]

    candidates = psvlink.find_playhead_candidates(frames, markers)
    assert candidates, "expected at least one candidate"

    best = candidates[0]
    assert best.offset == 8
    assert best.endian == "little"
    assert best.rate_per_second == pytest.approx(44100, rel=0.05)
    assert best.stalls_when_paused is True
    assert best.jumps_on_seek is True

    # The sequence counter at offset 0 advances steadily but never pauses and
    # never jumps, so it must not outrank the real playhead.
    sequence_candidates = [item for item in candidates if item.offset == 0 and item.width == 4]
    for item in sequence_candidates:
        assert item.score < best.score


def test_reports_nothing_when_the_deck_never_moves(tmp_path: Path) -> None:
    packets = [
        (1_700_000_000.0 + index * 0.05, 51000, 50002, psvlink_frame(
            message_type=0x32, family=0x1F, payload=struct.pack("<Q", 1234) + bytes(24)
        ))
        for index in range(40)
    ]
    capture = tmp_path / "still.pcap"
    write_pcap(capture, packets)
    frames = psvlink.parse_frames(psvlink.iter_udp_payloads(capture))
    assert psvlink.find_playhead_candidates(frames, []) == []


def test_decode_says_so_when_rekordbox_sent_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    capture = tmp_path / "empty.pcap"
    write_pcap(capture, [])
    assert psvlink.run_decode(capture) == 1
    assert "Nothing was captured" in capsys.readouterr().out
