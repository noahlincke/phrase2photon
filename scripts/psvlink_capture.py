#!/usr/bin/env python3
"""Capture and decode Rekordbox's local PSvLink traffic.

Rekordbox runs its own Pro DJ Link stack and binds UDP 50000/50001/50002/50004/
50111 locally. `docs/rekordbox-reverse-engineering.md` already establishes the
frame layout from disassembly - a 0x24 header carrying the magic "Qspt1WmJOL"
and "rekordbox", a message-type byte at 0x0a and a 16-bit payload length at
0x22 - and notes that `PSvLinkMonitor::messageReceived()` appends a message
when it observes position changes.

What is not established is which bytes of which message carry the playhead.
This finds out empirically: capture while doing known things to the deck, then
look for a field that behaves the way a playhead has to behave. A playhead
advances at a fixed rate while playing, stops dead while paused, and jumps
discontinuously on a scrub. Very little else in a protocol does all three.

Usage:

    # Terminal 1 - start rekordbox, load a track, then:
    sudo python3 scripts/psvlink_capture.py capture --out /tmp/psvlink.pcap

    # Press keys in terminal 1 to mark what you are doing, then Ctrl-C:
    #   p = started playing   s = paused   j = jumped/scrubbed

    python3 scripts/psvlink_capture.py decode /tmp/psvlink.pcap

`capture` needs sudo because it shells out to tcpdump; `decode` does not.
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# Established by disassembly; see docs/rekordbox-reverse-engineering.md.
HEADER_SIZE = 0x24
MAGIC = b"Qspt1WmJOL"
SECOND_MAGIC = b"rekordbox"
TYPE_OFFSET = 0x0A
FAMILY_OFFSET = 0x1A
# The notes place the second magic in "the next identifier region" without
# pinning an offset, and 0x0a is spoken for by the message type, so frames are
# recognised by searching the header for it rather than by assuming a position.

PAYLOAD_LENGTH_OFFSET = 0x22

PSVLINK_PORTS = (50000, 50001, 50002, 50004, 50111)

# pcap link types we may be handed, and how many bytes precede the IP header.
DLT_NULL = 0
DLT_EN10MB = 1
DLT_LOOP = 108
DLT_RAW = 101
DLT_PKTAP = 149


@dataclass
class Frame:
    """One decoded PSvLink frame."""

    timestamp: float
    src_port: int
    dst_port: int
    message_type: int
    family: int
    payload: bytes

    @property
    def key(self) -> tuple[int, int, int, int]:
        """Groups frames that should have the same layout."""
        return (self.dst_port, self.message_type, self.family, len(self.payload))


@dataclass
class Marker:
    """Something the operator did to the deck, and when."""

    timestamp: float
    label: str


@dataclass
class FieldCandidate:
    offset: int
    width: int
    endian: str
    signed: bool
    rate_per_second: float
    stalls_when_paused: bool
    jumps_on_seek: bool
    score: float
    samples: list[int] = field(default_factory=list)


def _link_header_length(link_type: int, data: bytes) -> int | None:
    """Bytes to skip before the IP header, or None if unsupported."""
    if link_type in (DLT_NULL, DLT_LOOP):
        return 4
    if link_type == DLT_EN10MB:
        return 14
    if link_type == DLT_RAW:
        return 0
    if link_type == DLT_PKTAP:
        # PKTAP prefixes a variable-length header whose length is its first
        # 32-bit word, followed by a link layer of its own.
        if len(data) < 4:
            return None
        pktap_length = struct.unpack_from("<I", data, 0)[0]
        if pktap_length + 14 > len(data):
            return None
        return pktap_length + 14
    return None


def iter_udp_payloads(pcap_path: Path) -> list[tuple[float, int, int, bytes]]:
    """Reads a pcap and yields (timestamp, src_port, dst_port, udp payload).

    Deliberately hand-rolled: this has to run with no third-party packages on
    a machine that is already mid-set, and the subset of pcap needed is small.
    """
    raw = pcap_path.read_bytes()
    if len(raw) < 24:
        raise ValueError("capture file is too short to contain a pcap header")

    magic = raw[:4]
    if magic == b"\xd4\xc3\xb2\xa1":
        endian, nanoseconds = "<", False
    elif magic == b"\xa1\xb2\xc3\xd4":
        endian, nanoseconds = ">", False
    elif magic == b"\x4d\x3c\xb2\xa1":
        endian, nanoseconds = "<", True
    elif magic == b"\xa1\xb2\x3c\x4d":
        endian, nanoseconds = ">", True
    else:
        raise ValueError(f"not a pcap file (magic {magic!r})")

    link_type = struct.unpack_from(f"{endian}I", raw, 20)[0]
    results: list[tuple[float, int, int, bytes]] = []
    offset = 24

    while offset + 16 <= len(raw):
        seconds, fraction, captured, _original = struct.unpack_from(f"{endian}IIII", raw, offset)
        offset += 16
        packet = raw[offset : offset + captured]
        offset += captured
        if len(packet) < captured:
            break
        timestamp = seconds + (fraction / 1_000_000_000 if nanoseconds else fraction / 1_000_000)

        skip = _link_header_length(link_type, packet)
        if skip is None or len(packet) < skip + 20:
            continue
        ip = packet[skip:]
        version = ip[0] >> 4
        if version == 4:
            header_length = (ip[0] & 0x0F) * 4
            protocol = ip[9]
            transport = ip[header_length:]
        elif version == 6:
            protocol = ip[6]
            transport = ip[40:]
        else:
            continue
        if protocol != 17 or len(transport) < 8:  # UDP
            continue
        src_port, dst_port, length = struct.unpack_from(">HHH", transport, 0)
        payload = transport[8 : max(8, length)]
        results.append((timestamp, src_port, dst_port, payload))

    return results


def parse_frames(packets: list[tuple[float, int, int, bytes]]) -> list[Frame]:
    """Keeps only datagrams that really are PSvLink frames."""
    frames: list[Frame] = []
    for timestamp, src_port, dst_port, payload in packets:
        if len(payload) < HEADER_SIZE:
            continue
        if not payload.startswith(MAGIC) or SECOND_MAGIC not in payload[:HEADER_SIZE]:
            continue
        declared = struct.unpack_from(">H", payload, PAYLOAD_LENGTH_OFFSET)[0]
        body = payload[HEADER_SIZE : HEADER_SIZE + declared]
        frames.append(
            Frame(
                timestamp=timestamp,
                src_port=src_port,
                dst_port=dst_port,
                message_type=payload[TYPE_OFFSET],
                family=payload[FAMILY_OFFSET],
                payload=body,
            )
        )
    return frames


def _read_int(data: bytes, offset: int, width: int, endian: str, signed: bool) -> int:
    return int.from_bytes(data[offset : offset + width], endian, signed=signed)


def _intervals(markers: list[Marker], label: str, until: float) -> list[tuple[float, float]]:
    """Time ranges during which the deck was in the state `label` began."""
    ranges: list[tuple[float, float]] = []
    start: float | None = None
    for marker in markers:
        if marker.label == label and start is None:
            start = marker.timestamp
        elif marker.label != label and start is not None:
            ranges.append((start, marker.timestamp))
            start = None
    if start is not None:
        ranges.append((start, until))
    return ranges


def find_playhead_candidates(
    frames: list[Frame], markers: list[Marker], *, sample_rate: float = 44100.0
) -> list[FieldCandidate]:
    """Scores every integer field on how much it behaves like a playhead.

    A playhead advances at a constant rate while playing, does not move while
    paused, and changes discontinuously when the DJ jumps. Anything that does
    all three is almost certainly it; a sequence counter passes the first test
    and fails the other two.
    """
    if not frames:
        return []

    end = frames[-1].timestamp
    playing = _intervals(markers, "play", end)
    paused = _intervals(markers, "pause", end)
    seeks = [marker.timestamp for marker in markers if marker.label == "seek"]

    candidates: list[FieldCandidate] = []
    width_bytes = (2, 4, 8)

    by_key: dict[tuple[int, int, int, int], list[Frame]] = {}
    for frame in frames:
        by_key.setdefault(frame.key, []).append(frame)

    for group in by_key.values():
        if len(group) < 8:
            continue
        size = len(group[0].payload)
        for width in width_bytes:
            for offset in range(0, size - width + 1):
                for endian in ("little", "big"):
                    series = [
                        (frame.timestamp, _read_int(frame.payload, offset, width, endian, False))
                        for frame in group
                    ]
                    candidate = _score_series(series, playing, paused, seeks, sample_rate)
                    if candidate is None:
                        continue
                    candidate.offset = offset
                    candidate.width = width
                    candidate.endian = endian
                    candidates.append(candidate)

    candidates.sort(key=lambda item: item.score, reverse=True)
    return candidates[:20]


def _score_series(
    series: list[tuple[float, int]],
    playing: list[tuple[float, float]],
    paused: list[tuple[float, float]],
    seeks: list[float],
    sample_rate: float,
) -> FieldCandidate | None:
    def within(ranges: list[tuple[float, float]], timestamp: float) -> bool:
        return any(start <= timestamp <= stop for start, stop in ranges)

    play_points = [point for point in series if not playing or within(playing, point[0])]
    if len(play_points) < 6:
        return None

    # Rate while playing, from the median of consecutive slopes so one jump
    # cannot dominate.
    slopes: list[float] = []
    for (time_a, value_a), (time_b, value_b) in zip(play_points, play_points[1:]):
        span = time_b - time_a
        if span <= 0:
            continue
        slopes.append((value_b - value_a) / span)
    if not slopes:
        return None
    slopes.sort()
    rate = slopes[len(slopes) // 2]
    if rate <= 0:
        return None

    # A playhead runs at the sample rate, at 1x for seconds, or at 1000x for
    # milliseconds. Anything else is some other counter.
    plausible = [sample_rate, 1.0, 1000.0, sample_rate / 2]
    closeness = max(
        0.0,
        1.0 - min(abs(rate - target) / target for target in plausible),
    )
    if closeness < 0.5:
        return None

    stalls = True
    if paused:
        pause_points = [point for point in series if within(paused, point[0])]
        if len(pause_points) >= 3:
            spread = max(value for _, value in pause_points) - min(value for _, value in pause_points)
            # Allow a sample or two of slop; require it to be essentially still.
            stalls = spread <= max(2, rate * 0.05)
        else:
            stalls = False

    jumps = False
    if seeks:
        for seek in seeks:
            before = [value for timestamp, value in series if seek - 2.0 <= timestamp < seek]
            after = [value for timestamp, value in series if seek < timestamp <= seek + 2.0]
            if not before or not after:
                continue
            expected = before[-1] + rate * 1.0
            if abs(after[0] - expected) > max(rate * 0.5, 4):
                jumps = True
                break

    score = closeness + (1.0 if stalls else 0.0) + (1.0 if jumps else 0.0)
    return FieldCandidate(
        offset=0,
        width=0,
        endian="little",
        signed=False,
        rate_per_second=rate,
        stalls_when_paused=stalls,
        jumps_on_seek=jumps,
        score=score,
        samples=[value for _, value in series[:6]],
    )


def run_capture(output: Path, interface: str, seconds: int | None) -> int:
    ports = " or ".join(f"port {port}" for port in PSVLINK_PORTS)
    command = [
        "tcpdump",
        "-i",
        interface,
        "-n",
        "-s",
        "0",
        "-U",
        "-w",
        str(output),
        f"udp and ({ports})",
    ]
    print(f"capturing on {interface} -> {output}")
    print("mark what you do with keys, then Ctrl-C to stop:")
    print("  p = playing    s = paused    j = jumped or scrubbed")

    markers_path = output.with_suffix(".markers.json")
    markers: list[dict[str, object]] = []
    process = subprocess.Popen(command)
    started = time.time()
    try:
        import termios
        import tty

        stdin = sys.stdin.fileno()
        old = termios.tcgetattr(stdin)
        try:
            tty.setcbreak(stdin)
            while process.poll() is None:
                if seconds is not None and time.time() - started > seconds:
                    break
                key = sys.stdin.read(1)
                label = {"p": "play", "s": "pause", "j": "seek"}.get(key.lower())
                if label is None:
                    continue
                markers.append({"timestamp": time.time(), "label": label})
                print(f"  [{time.time() - started:7.2f}s] {label}")
        finally:
            termios.tcsetattr(stdin, termios.TCSADRAIN, old)
    except KeyboardInterrupt:
        pass
    finally:
        process.terminate()
        process.wait(timeout=5)

    markers_path.write_text(json.dumps(markers, indent=2) + "\n")
    print(f"\nwrote {output} and {markers_path} ({len(markers)} markers)")
    return 0


def run_decode(capture: Path) -> int:
    packets = iter_udp_payloads(capture)
    frames = parse_frames(packets)

    print(f"{len(packets)} UDP datagrams on PSvLink ports, {len(frames)} valid PSvLink frames")
    if not packets:
        print(
            "\nNothing was captured. Rekordbox binds these ports but a laptop-only\n"
            "setup with no Pro DJ Link peers may never actually send anything, in\n"
            "which case this route is a dead end and the memory-read path is the\n"
            "one to take."
        )
        return 1
    if not frames:
        print(
            "\nDatagrams arrived but none carried the PSvLink magic. Either the\n"
            "framing differs from what disassembly suggested, or this is other\n"
            "traffic on the same ports."
        )
        return 1

    by_key: dict[tuple[int, int, int, int], int] = {}
    for frame in frames:
        by_key[frame.key] = by_key.get(frame.key, 0) + 1
    print("\nmessage streams (dst port, type, family, payload bytes) -> count")
    for key, count in sorted(by_key.items(), key=lambda item: item[1], reverse=True):
        print(f"  {key[0]:>6}  0x{key[1]:02x}  0x{key[2]:02x}  {key[3]:>5}B  -> {count}")

    markers_path = capture.with_suffix(".markers.json")
    markers: list[Marker] = []
    if markers_path.exists():
        markers = [
            Marker(timestamp=float(entry["timestamp"]), label=str(entry["label"]))
            for entry in json.loads(markers_path.read_text())
        ]
        print(f"\n{len(markers)} operator markers loaded from {markers_path.name}")
    else:
        print("\nno marker file; scoring on advance rate alone")

    candidates = find_playhead_candidates(frames, markers)
    if not candidates:
        print("\nNo field behaves like a playhead.")
        return 1

    print("\nplayhead candidates, best first")
    print("  offset  width  endian  rate/s        pauses?  jumps?  score")
    for candidate in candidates[:10]:
        print(
            f"  {candidate.offset:>6}  {candidate.width:>5}  {candidate.endian:>6}  "
            f"{candidate.rate_per_second:>12.1f}  {str(candidate.stalls_when_paused):>7}  "
            f"{str(candidate.jumps_on_seek):>6}  {candidate.score:.2f}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture = subparsers.add_parser("capture", help="record PSvLink traffic (needs sudo)")
    capture.add_argument("--out", type=Path, default=Path("/tmp/psvlink.pcap"))
    capture.add_argument("--interface", default="lo0", help="lo0 for local traffic, en0 for a Link network")
    capture.add_argument("--seconds", type=int, default=None, help="stop automatically after this long")

    decode = subparsers.add_parser("decode", help="find the playhead field in a capture")
    decode.add_argument("capture", type=Path)

    args = parser.parse_args()
    if args.command == "capture":
        return run_capture(args.out, args.interface, args.seconds)
    return run_decode(args.capture)


if __name__ == "__main__":
    raise SystemExit(main())
