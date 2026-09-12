import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";

import { analyzeBuffer } from "../../src/audio/spectral.js";
import { analyzeSpectralFeatures, type AnalysisOptions } from "../../src/audio/analyzeTrack.js";
import { decodeMono } from "./decodeAudio.js";
import { scoreBeats, scoreTempo, type TruthSong } from "./score.js";

/**
 * Sweeps analysis parameters over a fixed track set.
 *
 * Decoding and the STFT dominate the cost, so each worker does them once per
 * track and then evaluates every configuration against the cached features.
 * That makes a full sweep cheap enough to run after any change.
 */

interface Config {
  label: string;
  options: AnalysisOptions;
}

const CONFIGS: Config[] = [];
for (const halfBeatBand of ["low", "kick"] as const) {
  for (const halfBeatMargin of [0.95, 1, 1.05, 1.15]) {
    CONFIGS.push({
      label: `band ${halfBeatBand.padEnd(4)}  margin ${halfBeatMargin.toFixed(2)}`,
      options: { halfBeatBand, halfBeatMargin }
    });
  }
}

interface ConfigResult {
  onGrid: boolean;
  offbeat: boolean;
  beatF: number;
  barPhaseAligned: boolean;
  tempoExact: boolean;
}

if (!isMainThread) {
  const { sampleRate } = workerData as { sampleRate: number };
  parentPort?.on("message", async (song: TruthSong | null) => {
    if (song === null) {
      parentPort?.close();
      return;
    }
    try {
      const samples = await decodeMono(song.path, sampleRate);
      const features = analyzeBuffer(samples, sampleRate);
      const durationSeconds = samples.length / sampleRate;
      const results = CONFIGS.map((config) => {
        const analysis = analyzeSpectralFeatures(features, durationSeconds, config.options);
        const beats = scoreBeats(
          analysis.beatTimes,
          analysis.firstDownbeatSeconds,
          analysis.periodSeconds,
          song.beatTimes
        );
        return {
          onGrid: Math.abs(beats.signedPhaseBeats) < 0.1,
          offbeat: Math.abs(beats.signedPhaseBeats) > 0.35,
          beatF: beats.fMeasure,
          barPhaseAligned: beats.barPhaseAligned,
          tempoExact: scoreTempo(analysis.bpm, song.bpm).exact
        } satisfies ConfigResult;
      });
      parentPort?.postMessage(results);
    } catch {
      parentPort?.postMessage(null);
    }
  });
} else {
  void main();
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, "..", "..", "..", "..");
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  const limit = read("--limit", 96);
  const workers = read("--workers", Math.max(1, Math.min(10, cpus().length - 2)));
  const sampleRate = read("--sample-rate", 44100);

  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (song) => song.beatTimes.length >= 32 && song.energySegments.length >= 4 && song.bpm >= 115 && song.bpm <= 145
  );
  let state = 7 * 2654435761 + 1;
  const indices = eligible.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  const queue = indices.slice(0, limit).map((index) => eligible[index]);
  console.log(`sweeping ${CONFIGS.length} configs over ${queue.length} tracks`);

  const perConfig: ConfigResult[][] = CONFIGS.map(() => []);
  let nextIndex = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, () =>
      new Promise<void>((resolveWorker, rejectWorker) => {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { sampleRate } });
        const dispatch = (): void => {
          if (nextIndex >= queue.length) {
            worker.postMessage(null);
            void worker.terminate().then(() => resolveWorker());
            return;
          }
          worker.postMessage(queue[nextIndex]);
          nextIndex += 1;
        };
        worker.on("message", (results: ConfigResult[] | null) => {
          if (results) {
            results.forEach((result, index) => perConfig[index].push(result));
          }
          done += 1;
          process.stdout.write(`\r  ${done}/${queue.length}   `);
          dispatch();
        });
        worker.on("error", rejectWorker);
        dispatch();
      })
    )
  );
  process.stdout.write("\n\n");

  const rows = CONFIGS.map((config, index) => {
    const results = perConfig[index];
    const fraction = (predicate: (result: ConfigResult) => boolean): number =>
      results.length ? results.filter(predicate).length / results.length : 0;
    const mean = (select: (result: ConfigResult) => number): number =>
      results.length ? results.reduce((total, result) => total + select(result), 0) / results.length : 0;
    return {
      label: config.label,
      onGrid: fraction((result) => result.onGrid),
      offbeat: fraction((result) => result.offbeat),
      beatF: mean((result) => result.beatF),
      barPhase: fraction((result) => result.barPhaseAligned),
      tempo: fraction((result) => result.tempoExact)
    };
  });

  rows.sort((left, right) => right.onGrid - left.onGrid || right.beatF - left.beatF);
  console.log("  onGrid  offbeat  beatF   barPhase  tempo    config");
  for (const row of rows) {
    console.log(
      `  ${(row.onGrid * 100).toFixed(1).padStart(5)}%  ${(row.offbeat * 100).toFixed(1).padStart(6)}%  ` +
        `${row.beatF.toFixed(3)}  ${(row.barPhase * 100).toFixed(1).padStart(7)}%  ` +
        `${(row.tempo * 100).toFixed(1).padStart(5)}%    ${row.label}`
    );
  }
}
