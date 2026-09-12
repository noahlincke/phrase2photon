import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";

import { analyzeBuffer } from "../../src/audio/spectral.js";
import { blendOnsetEnvelopes, normalizeOnsetEnvelope } from "../../src/audio/odf.js";
import { estimateTempo } from "../../src/audio/tempo.js";
import {
  computeBeatFeatures,
  downbeatCueScores,
  refinePeriodFromBeats,
  trackBeats
} from "../../src/audio/beats.js";
import { decodeMono } from "./decodeAudio.js";
import type { TruthSong } from "./score.js";

/**
 * Measures each downbeat cue in isolation against Mixed In Key's grid.
 *
 * Weighting the cues by intuition is how you end up with a detector that is
 * confidently wrong; this reports per-cue hit rates so the weights are chosen
 * from evidence.
 */

interface Sample {
  /** Per-cue scores for bar phases 0-3, already normalised. */
  cues: Record<string, number[]>;
  truePhase: number;
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
      const firstFrameSeconds = features.times[0] ?? 0;
      const envelope = blendOnsetEnvelopes(
        normalizeOnsetEnvelope(features.flux, features.frameRate, firstFrameSeconds),
        normalizeOnsetEnvelope(features.lowFlux, features.frameRate, firstFrameSeconds)
      );
      const tempo = estimateTempo(envelope);
      let periodSeconds = 60 / tempo.bpm;
      let beatTimes = trackBeats(envelope, periodSeconds);
      periodSeconds = refinePeriodFromBeats(beatTimes, periodSeconds);
      beatTimes = trackBeats(envelope, periodSeconds);

      const beats = computeBeatFeatures(features, beatTimes, periodSeconds);
      const cues = downbeatCueScores(beats);
      const raw = Math.round((song.beatTimes[0] - beatTimes[0]) / periodSeconds);
      const truePhase = ((raw % 4) + 4) % 4;
      const drift = Math.abs(song.beatTimes[0] - beatTimes[0] - raw * periodSeconds);
      // Only trust the reference phase when our grid actually agrees with it.
      parentPort?.postMessage(drift < periodSeconds * 0.2 ? { cues, truePhase } : null);
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
  const limit = read("--limit", 80);
  const workers = read("--workers", Math.max(1, Math.min(10, cpus().length - 2)));
  const sampleRate = read("--sample-rate", 44100);

  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter((song) => song.beatTimes.length >= 32 && song.bpm >= 115 && song.bpm <= 145);
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
          dispatch();
        });
        worker.on("error", rejectWorker);
        dispatch();
      })
    )
  );

  if (!samples.length) {
    console.log("no usable samples");
    return;
  }
  const cueNames = Object.keys(samples[0].cues);
  console.log(`${samples.length} tracks with a trustworthy reference phase`);
  console.log("");
  console.log("per-cue accuracy (argmax of the cue equals the reference bar phase)");
  for (const name of cueNames) {
    const hits = samples.filter((sample) => argmax(sample.cues[name]) === sample.truePhase).length;
    // Mean margin between the correct phase and the best wrong phase.
    const margins = samples.map((sample) => {
      const scores = sample.cues[name];
      const correct = scores[sample.truePhase];
      const best = Math.max(...scores.filter((_, index) => index !== sample.truePhase));
      return correct - best;
    });
    const meanMargin = margins.reduce((total, value) => total + value, 0) / margins.length;
    console.log(
      `  ${name.padEnd(12)} ${((hits / samples.length) * 100).toFixed(1).padStart(5)}%   ` +
        `mean margin ${meanMargin >= 0 ? "+" : ""}${meanMargin.toFixed(3)}`
    );
  }

  console.log("");
  console.log("reference phase distribution (should be roughly uniform)");
  const distribution = [0, 1, 2, 3].map(
    (phase) => samples.filter((sample) => sample.truePhase === phase).length
  );
  console.log(`  ${distribution.join("  ")}`);

  console.log("");
  console.log("best fixed weighting found by coordinate search");
  const best = searchWeights(samples, cueNames);
  console.log(`  accuracy ${(best.accuracy * 100).toFixed(1)}%`);
  cueNames.forEach((name, index) => {
    console.log(`  ${name.padEnd(12)} ${best.weights[index].toFixed(2)}`);
  });
}

function argmax(scores: number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[best]) {
      best = index;
    }
  }
  return best;
}

function accuracyFor(samples: Sample[], cueNames: string[], weights: number[]): number {
  let hits = 0;
  for (const sample of samples) {
    const combined = [0, 1, 2, 3].map((phase) =>
      cueNames.reduce((total, name, index) => total + weights[index] * sample.cues[name][phase], 0)
    );
    if (argmax(combined) === sample.truePhase) {
      hits += 1;
    }
  }
  return hits / samples.length;
}

/** Simple coordinate ascent; the search space is only a handful of weights. */
function searchWeights(
  samples: Sample[],
  cueNames: string[]
): { weights: number[]; accuracy: number } {
  let weights = cueNames.map(() => 1);
  let accuracy = accuracyFor(samples, cueNames, weights);
  const options = [0, 0.15, 0.3, 0.5, 0.75, 1, 1.5, 2, 3];
  for (let pass = 0; pass < 6; pass += 1) {
    let improved = false;
    for (let index = 0; index < weights.length; index += 1) {
      for (const option of options) {
        const candidate = [...weights];
        candidate[index] = option;
        const score = accuracyFor(samples, cueNames, candidate);
        if (score > accuracy + 1e-9) {
          accuracy = score;
          weights = candidate;
          improved = true;
        }
      }
    }
    if (!improved) {
      break;
    }
  }
  return { weights, accuracy };
}
