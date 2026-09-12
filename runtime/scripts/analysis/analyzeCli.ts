import { decodeMono } from "./decodeAudio.js";
import { analyzeTrack } from "../../src/audio/analyzeTrack.js";
import type { PhraseKind } from "../../src/audio/structure.js";

/**
 * Command-line front end to the analyser, for the Now Playing service.
 *
 * The Python service prepares shows for whatever a DJ application is playing,
 * and needs the same tempo and phrase map the runtime uses. Rather than keep a
 * second analysis implementation in Python - which is how the two drift - it
 * shells out to this, exactly as it already shells out to ffmpeg.
 *
 *   node analyze.mjs <audio-path> [--sample-rate 44100]
 *
 * Emits a single JSON object on stdout. Errors go to stderr with a non-zero
 * exit so the caller can fall back rather than compile a wrong show.
 */

interface SectionRow {
  start_seconds: number;
  end_seconds: number;
  label: PhraseKind;
  energy: string;
}

/** Maps the analyser's 1-10 energy onto the compiler's level vocabulary. */
function energyLevel(energy: number): string {
  if (energy >= 8) {
    return "peak";
  }
  if (energy >= 6) {
    return "high";
  }
  if (energy >= 4) {
    return "mid";
  }
  return "low";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const audioPath = argv.find((value) => !value.startsWith("--"));
  if (!audioPath) {
    throw new Error("usage: analyze.mjs <audio-path> [--sample-rate 44100]");
  }
  const rateIndex = argv.indexOf("--sample-rate");
  const sampleRate = rateIndex >= 0 ? Number(argv[rateIndex + 1]) : 44100;

  const samples = await decodeMono(audioPath, sampleRate);
  const durationSeconds = samples.length / sampleRate;
  if (durationSeconds < 20) {
    throw new Error(`audio is only ${durationSeconds.toFixed(1)}s; too short to analyse`);
  }

  const analysis = analyzeTrack(samples, sampleRate);
  const sections: SectionRow[] = analysis.phrases.map((phrase) => ({
    start_seconds: phrase.startSeconds,
    end_seconds: phrase.endSeconds,
    label: phrase.kind,
    energy: energyLevel(phrase.energy)
  }));

  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      tempo: analysis.bpm,
      duration_seconds: durationSeconds,
      // The first downbeat, so the compiler's bar grid can be anchored to the
      // music rather than to the start of the file.
      first_downbeat_seconds: analysis.firstDownbeatSeconds,
      downbeat_confidence: analysis.downbeatConfidence,
      tempo_confidence: analysis.tempoConfidence,
      sections
    })}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
