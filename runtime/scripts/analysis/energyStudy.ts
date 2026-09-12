import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";

import { analyzeTrack } from "../../src/audio/analyzeTrack.js";
import { BAR_FEATURE_COUNT } from "../../src/audio/structure.js";
import { decodeMono } from "./decodeAudio.js";
import { pearson, type TruthSong } from "./score.js";

/**
 * Fits the energy composite against Mixed In Key's 1-10 energy segments.
 *
 * Caches each track as (mean bar features per reference segment, reference
 * energy), so the weight search is over a few thousand numbers rather than
 * over audio.
 */

const FEATURE_NAMES = ["sub", "bass", "body", "mid", "air", "rms", "kick", "hats"];

interface Sample {
  /** One row of `BAR_FEATURE_COUNT` means per reference segment. */
  rows: number[][];
  energies: number[];
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
      const analysis = analyzeTrack(samples, sampleRate);
      const rows: number[][] = [];
      const energies: number[] = [];
      for (const segment of song.energySegments) {
        const start = segment.start;
        const end = segment.start + segment.length;
        // Average our bar features across the whole reference window rather
        // than sampling its midpoint, so the comparison is like for like.
        const totals = new Float64Array(BAR_FEATURE_COUNT);
        let bars = 0;
        for (let bar = 0; bar < analysis.bars.barCount; bar += 1) {
          const time = analysis.bars.times[bar];
          if (time < start || time >= end) {
            continue;
          }
          for (let column = 0; column < BAR_FEATURE_COUNT; column += 1) {
            totals[column] += analysis.bars.values[bar * BAR_FEATURE_COUNT + column];
          }
          bars += 1;
        }
        if (!bars) {
          continue;
        }
        rows.push([...totals].map((total) => total / bars));
        energies.push(segment.energy);
      }
      parentPort?.postMessage(rows.length >= 4 ? ({ rows, energies } satisfies Sample) : null);
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
  const limit = read("--limit", 150);
  const workers = read("--workers", Math.max(1, Math.min(10, cpus().length - 2)));
  const sampleRate = read("--sample-rate", 44100);

  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (song) => song.beatTimes.length >= 128 && song.energySegments.length >= 5 && song.bpm >= 115 && song.bpm <= 145
  );
  let state = 7 * 2654435761 + 1;
  const indices = eligible.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  const queue = indices.slice(0, limit).map((index) => eligible[index]);

  const samples: Sample[] = [];
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
        worker.on("message", (sample: Sample | null) => {
          if (sample) {
            samples.push(sample);
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

  const meanCorrelation = (weights: number[]): number => {
    let total = 0;
    for (const sample of samples) {
      const predicted = sample.rows.map((row) =>
        row.reduce((sum, value, index) => sum + value * weights[index], 0)
      );
      total += pearson(predicted, sample.energies);
    }
    return total / samples.length;
  };

  console.log(`${samples.length} tracks, ${samples.reduce((total, s2) => total + s2.rows.length, 0)} segments`);
  console.log("");
  console.log("single-feature correlation with reference energy");
  FEATURE_NAMES.forEach((name, index) => {
    const weights = FEATURE_NAMES.map((_, candidate) => (candidate === index ? 1 : 0));
    console.log(`  ${name.padEnd(6)} ${meanCorrelation(weights).toFixed(3)}`);
  });

  const current = [0, 0.16, 0, 0.09, 0, 0.5, 0, 0.09];
  console.log("");
  console.log(`current composite      ${meanCorrelation(current).toFixed(3)}`);

  // Coordinate ascent over the eight bar features.
  let weights = FEATURE_NAMES.map(() => 0);
  weights[5] = 1;
  let best = meanCorrelation(weights);
  const options = [-0.4, -0.2, -0.1, 0, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
  for (let pass = 0; pass < 12; pass += 1) {
    let improved = false;
    for (let index = 0; index < weights.length; index += 1) {
      for (const option of options) {
        const candidate = [...weights];
        candidate[index] = option;
        const score = meanCorrelation(candidate);
        if (score > best + 1e-6) {
          best = score;
          weights = candidate;
          improved = true;
        }
      }
    }
    if (!improved) {
      break;
    }
  }

  console.log("");
  console.log("fitted composite");
  const scale = weights.reduce((total, value) => total + Math.abs(value), 0) || 1;
  FEATURE_NAMES.forEach((name, index) => {
    console.log(`  ${name.padEnd(6)} ${weights[index].toFixed(2)}   (normalised ${(weights[index] / scale).toFixed(3)})`);
  });
  console.log("");
  console.log(`fitted correlation     ${best.toFixed(3)}`);
}
