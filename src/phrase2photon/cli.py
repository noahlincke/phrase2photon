from __future__ import annotations

import argparse
import json
from pathlib import Path

from phrase2photon.bridge.producer_pal import ProducerPalClient
from phrase2photon.compiler.service import Phrase2PhotonCompiler, slugify_name
from phrase2photon.contracts.show_package import ShowPackage, make_example_show_package
from phrase2photon.extraction.models import LiveSetExtraction, LocatorSnapshot, TrackSnapshot
from phrase2photon.extraction.pipeline import ProducerPalExtractionPipeline, derive_phrases


def _write_output(path: str | None, payload: str) -> None:
    if path is None:
        print(payload)
        return

    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(payload + "\n", encoding="utf-8")


def _load_extraction(path: str) -> LiveSetExtraction:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    locators_data = data.get("locators") or []
    phrases = data.get("phrases")
    needs_phrase_derivation = bool(locators_data) and (
        not phrases or (isinstance(phrases, list) and "semantics" not in phrases[0])
    )
    if needs_phrase_derivation:
        locators = [LocatorSnapshot.model_validate(locator) for locator in data.get("locators", [])]
        tracks = [TrackSnapshot.model_validate(track) for track in data.get("tracks", [])]
        data["phrases"] = [phrase.model_dump() for phrase in derive_phrases(locators, tracks)]
    return LiveSetExtraction.model_validate(data)


def _default_show_outdir(extraction: LiveSetExtraction) -> Path:
    return Path.home() / "Phrase2PhotonShows" / slugify_name(extraction.source_name)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="phrase2photon")
    subparsers = parser.add_subparsers(dest="command", required=True)

    schema_parser = subparsers.add_parser("schema", help="Export the v0 JSON Schema.")
    schema_parser.add_argument("--out", help="Write the schema to a file instead of stdout.")

    example_parser = subparsers.add_parser("example", help="Export an example show package.")
    example_parser.add_argument("--out", help="Write the example payload to a file instead of stdout.")

    extract_parser = subparsers.add_parser(
        "extract",
        help="Connect to Producer Pal and extract the current Ableton project snapshot.",
    )
    extract_parser.add_argument("--out", help="Write the extraction payload to a file instead of stdout.")
    extract_parser.add_argument(
        "--base-url",
        default="http://localhost:3350",
        help="Producer Pal REST API base URL.",
    )
    extract_parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Producer Pal request timeout in seconds.",
    )
    extract_parser.add_argument(
        "--all-tracks",
        action="store_true",
        help="Fetch detailed track data for all tracks, not just active arrangement tracks.",
    )

    compile_parser = subparsers.add_parser(
        "compile",
        help="Compile a live set extraction into renderer-agnostic show package files.",
    )
    compile_parser.add_argument(
        "--outdir",
        help="Output directory for compiled runtime files. Defaults to ~/Phrase2PhotonShows/<song-slug>.",
    )
    compile_parser.add_argument(
        "--extraction-in",
        help="Use an existing extraction JSON file instead of connecting to Producer Pal.",
    )
    compile_parser.add_argument(
        "--base-url",
        default="http://localhost:3350",
        help="Producer Pal REST API base URL.",
    )
    compile_parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Producer Pal request timeout in seconds.",
    )
    compile_parser.add_argument(
        "--all-tracks",
        action="store_true",
        help="Fetch detailed track data for all tracks during live compile.",
    )

    serve_parser = subparsers.add_parser(
        "now-playing-serve",
        help="Run the local macOS-only Now Playing orchestration service.",
    )
    serve_parser.add_argument("--host", default="127.0.0.1", help="Bind host for the local service.")
    serve_parser.add_argument("--port", type=int, default=8768, help="Bind port for the local service.")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "schema":
        payload = json.dumps(ShowPackage.model_json_schema(), indent=2)
        _write_output(args.out, payload)
        return

    if args.command == "example":
        payload = make_example_show_package().model_dump_json(indent=2)
        _write_output(args.out, payload)
        return

    if args.command == "extract":
        client = ProducerPalClient(base_url=args.base_url, timeout_seconds=args.timeout)
        pipeline = ProducerPalExtractionPipeline(client)
        extraction = pipeline.extract(include_all_tracks=args.all_tracks)
        _write_output(args.out, extraction.model_dump_json(indent=2))
        return

    if args.command == "compile":
        if args.extraction_in:
            extraction = _load_extraction(args.extraction_in)
        else:
            client = ProducerPalClient(base_url=args.base_url, timeout_seconds=args.timeout)
            pipeline = ProducerPalExtractionPipeline(client)
            extraction = pipeline.extract(include_all_tracks=args.all_tracks)

        compiler = Phrase2PhotonCompiler()
        outdir = Path(args.outdir).expanduser() if args.outdir else _default_show_outdir(extraction)
        result = compiler.compile_to_directory(extraction, outdir)
        payload = {
            "song": result.show_package.song.title,
            "outdir": str(outdir),
            "phrase_count": len(result.show_package.phrases),
            "lighting_cue_count": len(result.show_package.lighting_cues),
            "laser_cue_count": len(result.show_package.dmx_laser_cues),
            "written_files": [str(path) for path in result.written_files],
        }
        print(json.dumps(payload, indent=2))
        return

    if args.command == "now-playing-serve":
        from phrase2photon.now_playing.server import run_server

        run_server(host=args.host, port=args.port)
        return

    parser.error(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
