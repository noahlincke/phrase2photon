import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeTrack } from "../../src/audio/analyzeTrack.js";
import { decodeMono } from "./decodeAudio.js";
import { scoreBeats, type TruthSong } from "./score.js";

/** Prints a side-by-side comparison of our grid and the reference grid. */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, "..", "..", "..", "..");
  const needle = process.argv[2] ?? "";
  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const song = truth.songs.find((candidate) =>
    `${candidate.artist} ${candidate.title}`.toLowerCase().includes(needle.toLowerCase())
  );
  if (!song) {
    console.log(`no song matching "${needle}"`);
    return;
  }

  const sampleRate = 44100;
  const samples = await decodeMono(song.path, sampleRate);
  const analysis = analyzeTrack(samples, sampleRate);
  const score = scoreBeats(analysis.beatTimes, analysis.firstDownbeatSeconds, analysis.periodSeconds, song.beatTimes);

  const ourIntervals = [...analysis.beatTimes].slice(1).map((time, index) => time - analysis.beatTimes[index]);
  ourIntervals.sort((left, right) => left - right);

  console.log(`${song.artist} - ${song.title}`);
  console.log(`  duration        ${(samples.length / sampleRate).toFixed(1)} s`);
  console.log(`  reference bpm   ${song.bpm.toFixed(3)}   ours ${analysis.bpm.toFixed(3)}`);
  console.log(`  reference beats ${song.beatTimes.length}  span ${song.beatTimes[0].toFixed(2)} .. ${song.beatTimes[song.beatTimes.length - 1].toFixed(2)}`);
  console.log(`  our beats       ${analysis.beatTimes.length}  span ${analysis.beatTimes[0].toFixed(2)} .. ${analysis.beatTimes[analysis.beatTimes.length - 1].toFixed(2)}`);
  console.log(`  our interval    median ${ourIntervals[Math.floor(ourIntervals.length / 2)].toFixed(4)}  min ${ourIntervals[0].toFixed(4)}  max ${ourIntervals[ourIntervals.length - 1].toFixed(4)}  (expected ${analysis.periodSeconds.toFixed(4)})`);
  const irregular = ourIntervals.filter((interval) => Math.abs(interval / analysis.periodSeconds - 1) > 0.05).length;
  console.log(`  irregular gaps  ${irregular}`);
  console.log(`  beat F          ${score.fMeasure.toFixed(3)}  median err ${score.medianErrorMs.toFixed(1)} ms  bar phase ${score.barPhaseOffset.toFixed(3)}`);
  const referenceOrigin = song.energySegments[0]?.start ?? song.beatTimes[0];
  const phraseSeconds = song.energySegments[0]?.length ?? analysis.barSeconds * 8;
  console.log("");
  console.log(`  our downbeat offset ${analysis.downbeatOffset}  phrase origin bar ${analysis.phraseOriginBar}`);
  console.log(`  reference phrase origin ${referenceOrigin.toFixed(3)} s, phrase ${phraseSeconds.toFixed(3)} s (${(phraseSeconds / analysis.barSeconds).toFixed(2)} of our bars)`);
  console.log(`  our bar 0 at ${(analysis.beatTimes[analysis.downbeatOffset] ?? 0).toFixed(3)} s`);
  console.log("");
  console.log("  our phrases (bar, length in bars, offset from reference phrase grid in bars):");
  for (const phrase of analysis.phrases) {
    const phase = (((phrase.startSeconds - referenceOrigin) / phraseSeconds) % 1 + 1) % 1;
    const offsetBars = (Math.min(phase, 1 - phase) * phraseSeconds) / analysis.barSeconds;
    console.log(
      `    bar ${String(phrase.startBar).padStart(4)}  len ${String(phrase.endBar - phrase.startBar).padStart(3)}  ` +
        `t ${phrase.startSeconds.toFixed(2).padStart(7)}  offset ${offsetBars.toFixed(2).padStart(5)}  ` +
        `${phrase.kind.padEnd(10)} energy ${phrase.energy}`
    );
  }
  console.log("");
  console.log("  first 10 pairs (ours vs reference, aligned by nearest):");
  for (let index = 0; index < 10 && index < song.beatTimes.length; index += 1) {
    const reference = song.beatTimes[index];
    let nearest = analysis.beatTimes[0];
    for (const time of analysis.beatTimes) {
      if (Math.abs(time - reference) < Math.abs(nearest - reference)) {
        nearest = time;
      }
    }
    console.log(`    ref ${reference.toFixed(4)}   ours ${nearest.toFixed(4)}   diff ${((nearest - reference) * 1000).toFixed(1)} ms`);
  }
}

void main();
