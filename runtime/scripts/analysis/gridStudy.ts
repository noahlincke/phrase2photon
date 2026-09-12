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
  fitRegularGrid,
  metricGridTerms,
  refinePeriodFromBeats,
  selectMetricGrid,
  trackBeats,
  GRID_TERM_NAMES,
  type GridTermName,
  type GridWeights
} from "../../src/audio/beats.js";
import { DEFAULT_ANALYSIS_OPTIONS } from "../../src/audio/analyzeTrack.js";
import { decodeMono } from "./decodeAudio.js";
import type { TruthSong } from "./score.js";

/**
 * Fits the metric-grid weights against Mixed In Key's phrase grids.
 *
 * The per-offset term scores are computed once per track and cached, so the
 * weight search runs over numbers rather than audio. That makes it cheap to
 * re-fit whenever a term definition changes - which is the point, since
 * hand-chosen weights are how a detector ends up confidently wrong.
 */

interface Sample {
  terms: Record<GridTermName, number[]>;
  /** Reference grid origin in beats, 0-31, relative to our first beat. */
  trueOrigin: number;
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
      const broadband = normalizeOnsetEnvelope(features.flux, features.frameRate, firstFrameSeconds);
      const low = normalizeOnsetEnvelope(features.lowFlux, features.frameRate, firstFrameSeconds);
      const tracking = blendOnsetEnvelopes(broadband, low, DEFAULT_ANALYSIS_OPTIONS.trackingKickWeight);
      const tempoEnvelope = blendOnsetEnvelopes(broadband, low, DEFAULT_ANALYSIS_OPTIONS.tempoKickWeight);

      let period = 60 / estimateTempo(tempoEnvelope).bpm;
      let tracked = trackBeats(tracking, period);
      period = refinePeriodFromBeats(tracked, period);
      tracked = trackBeats(tracking, period);
      const grid = fitRegularGrid(
        tracked,
        tracking,
        period,
        samples.length / sampleRate,
        low,
        DEFAULT_ANALYSIS_OPTIONS.halfBeatMargin
      );

      // Only usable if our beat grid actually coincides with the reference
      // grid; otherwise "which beat starts the bar" is not comparable.
      const rawPhase = (grid.beatTimes[0] - song.beatTimes[0]) / grid.periodSeconds;
      const beatPhase = ((rawPhase % 1) + 1) % 1;
      const signed = beatPhase > 0.5 ? beatPhase - 1 : beatPhase;
      if (Math.abs(signed) > 0.1) {
        parentPort?.postMessage(null);
        return;
      }

      const origin = song.energySegments[0]?.start ?? song.beatTimes[0];
      const offset = Math.round((origin - grid.beatTimes[0]) / grid.periodSeconds);
      const beats = computeBeatFeatures(features, grid.beatTimes, grid.periodSeconds);
      parentPort?.postMessage({
        terms: metricGridTerms(beats),
        trueOrigin: ((offset % 32) + 32) % 32
      } satisfies Sample);
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
    (song) => song.beatTimes.length >= 128 && song.energySegments.length >= 4 && song.bpm >= 115 && song.bpm <= 145
  );
  let state = 11 * 2654435761 + 1;
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
          process.stdout.write(`\r  ${done}/${queue.length}  usable ${samples.length}   `);
          dispatch();
        });
        worker.on("error", rejectWorker);
        dispatch();
      })
    )
  );
  process.stdout.write("\n\n");

  if (samples.length < 10) {
    console.log(`only ${samples.length} usable samples; widen the selection`);
    return;
  }
  console.log(`${samples.length} tracks whose beat grid matches the reference`);

  // Produced files almost always start on bar 1 of phrase 1, which makes the
  // reference origin heavily skewed toward 0. Fitting against that skew would
  // bake in a prior that cannot transfer to live capture, where the listener
  // starts recording mid-track. So fit on a rotated copy, where the origin is
  // uniform by construction, and score the positional prior separately.
  const rotated = samples.map((sample, index) => {
    const shift = (index * 7 + 3) % 32;
    const terms = Object.fromEntries(
      GRID_TERM_NAMES.map((name) => [
        name,
        Array.from({ length: 32 }, (_, origin) => sample.terms[name][(origin + shift) % 32])
      ])
    ) as Record<GridTermName, number[]>;
    return { terms, trueOrigin: ((sample.trueOrigin - shift) % 32 + 32) % 32 };
  });

  const evaluate = (weights: GridWeights, set: Sample[]) => {
    let barHits = 0;
    let fourBarHits = 0;
    let phraseHits = 0;
    for (const sample of set) {
      const picked = selectMetricGrid(sample.terms, weights).originBeat;
      if (picked % 4 === sample.trueOrigin % 4) {
        barHits += 1;
      }
      if (picked % 16 === sample.trueOrigin % 16) {
        fourBarHits += 1;
      }
      if (picked === sample.trueOrigin) {
        phraseHits += 1;
      }
    }
    return {
      bar: barHits / set.length,
      fourBar: fourBarHits / set.length,
      phrase: phraseHits / set.length
    };
  };

  const zeroWeights = Object.fromEntries(
    GRID_TERM_NAMES.map((name) => [name, 0])
  ) as GridWeights;

  const show = (label: string, score: { bar: number; fourBar: number; phrase: number }): void => {
    console.log(
      `  ${label.padEnd(22)} ${(score.bar * 100).toFixed(1).padStart(5)}%  ` +
        `${(score.fourBar * 100).toFixed(1).padStart(5)}%  ${(score.phrase * 100).toFixed(1).padStart(5)}%`
    );
  };

  console.log("");
  console.log("reference origin by bar phase, before and after de-biasing");
  console.log(`  raw      ${[0, 1, 2, 3].map((phase) => samples.filter((s2) => s2.trueOrigin % 4 === phase).length).join("  ")}`);
  console.log(`  rotated  ${[0, 1, 2, 3].map((phase) => rotated.filter((s2) => s2.trueOrigin % 4 === phase).length).join("  ")}`);

  console.log("");
  console.log("error histogram for the fitted defaults, (picked - reference) in beats");
  {
    const histogram = new Array<number>(32).fill(0);
    for (const sample of samples) {
      const picked = selectMetricGrid(sample.terms, DEFAULT_ANALYSIS_OPTIONS.gridWeights).originBeat;
      histogram[((picked - sample.trueOrigin) % 32 + 32) % 32] += 1;
    }
    histogram.forEach((hits, offset) => {
      if (hits > 0) {
        console.log(`  ${String(offset).padStart(2)} beats (${(offset / 4).toFixed(2).padStart(5)} bars)  ${"#".repeat(hits)} ${hits}`);
      }
    });
  }

  console.log("");
  console.log("accuracy on the de-biased set   bar / 4-bar / 8-bar   (chance: 25 / 6.3 / 3.1)");
  for (const name of GRID_TERM_NAMES) {
    show(name, evaluate({ ...zeroWeights, [name]: 1 }, rotated));
  }

  // Coordinate ascent, weighting the bar phase highest because every
  // downstream decision depends on it.
  const options = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3];
  const fit = (set: Sample[], terms: GridTermName[]): GridWeights => {
    let weights = Object.fromEntries(
      GRID_TERM_NAMES.map((name) => [name, terms.includes(name) ? 1 : 0])
    ) as GridWeights;
    let bestScore = -Infinity;
    for (let pass = 0; pass < 10; pass += 1) {
      let improved = false;
      for (const name of terms) {
        for (const option of options) {
          const candidate = { ...weights, [name]: option };
          const score = evaluate(candidate, set);
          const combined = score.bar + score.phrase * 0.6 + score.fourBar * 0.3;
          if (combined > bestScore + 1e-9) {
            bestScore = combined;
            weights = candidate;
            improved = true;
          }
        }
      }
      if (!improved) {
        break;
      }
    }
    return weights;
  };

  const structural = GRID_TERM_NAMES.filter((name) => name !== "startPrior");
  const liveWeights = fit(rotated, structural);
  console.log("");
  console.log("fitted weights (de-biased, no positional prior - these are the live weights)");
  for (const name of structural) {
    console.log(`  ${name.padEnd(15)} ${liveWeights[name].toFixed(2)}`);
  }
  console.log("");
  show("fitted (de-biased)", evaluate(liveWeights, rotated));
  show("fitted (real files)", evaluate(liveWeights, samples));
  show("current defaults", evaluate(DEFAULT_ANALYSIS_OPTIONS.gridWeights, rotated));

  // For whole files the positional prior is legitimate, so fit it on top.
  const offlineWeights = fit(samples, GRID_TERM_NAMES);
  console.log("");
  console.log("fitted weights for whole files (positional prior allowed)");
  for (const name of GRID_TERM_NAMES) {
    console.log(`  ${name.padEnd(15)} ${offlineWeights[name].toFixed(2)}`);
  }
  console.log("");
  show("offline fit", evaluate(offlineWeights, samples));
  show("origin-0 baseline", evaluate({ ...zeroWeights, startPrior: 1 }, samples));
}
