import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

import { percentile, type TruthSong } from "./score.js";
import type { TrackResult } from "./benchWorker.js";

/**
 * Scores the beat/phrase detector against Mixed In Key's static analysis.
 *
 * Run `python3 scripts/mik_export.py --out .analysis-cache/mik-truth.json`
 * first, then `npm run bench:mik -- --limit 120`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..", "..", "..", "..");

interface Options {
  truthPath: string;
  limit: number;
  workers: number;
  sampleRate: number;
  seed: number;
  minBpm: number;
  maxBpm: number;
  reportPath: string | null;
  showWorst: number;
}

function parseOptions(argv: string[]): Options {
  const read = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };
  return {
    truthPath: read("--truth") ?? resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"),
    limit: Number(read("--limit") ?? 120),
    workers: Number(read("--workers") ?? Math.max(1, Math.min(10, cpus().length - 2))),
    sampleRate: Number(read("--sample-rate") ?? 44100),
    seed: Number(read("--seed") ?? 7),
    minBpm: Number(read("--min-bpm") ?? 0),
    maxBpm: Number(read("--max-bpm") ?? 400),
    reportPath: read("--report"),
    showWorst: Number(read("--show-worst") ?? 12)
  };
}

/** Deterministic sample so runs are comparable across algorithm changes. */
function sampleSongs(songs: TruthSong[], limit: number, seed: number): TruthSong[] {
  if (limit <= 0 || limit >= songs.length) {
    return songs;
  }
  let state = seed * 2654435761 + 1;
  const indices = songs.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  return indices.slice(0, limit).sort((left, right) => left - right).map((index) => songs[index]);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const truth = JSON.parse(readFileSync(options.truthPath, "utf8")) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (song) =>
      song.beatTimes.length >= 32 &&
      song.energySegments.length >= 4 &&
      song.bpm >= options.minBpm &&
      song.bpm <= options.maxBpm
  );
  const queue = sampleSongs(eligible, options.limit, options.seed);

  console.log(
    `scoring ${queue.length} of ${eligible.length} eligible songs ` +
      `with ${options.workers} workers at ${options.sampleRate} Hz`
  );

  const workerPath = resolve(here, "benchWorker.js");
  const results: TrackResult[] = [];
  let nextIndex = 0;
  let completed = 0;
  const startedAt = Date.now();

  await Promise.all(
    Array.from({ length: Math.min(options.workers, queue.length) }, () =>
      new Promise<void>((resolveWorker, rejectWorker) => {
        const worker = new Worker(workerPath, { workerData: { sampleRate: options.sampleRate } });
        const dispatch = (): void => {
          if (nextIndex >= queue.length) {
            worker.postMessage(null);
            void worker.terminate().then(() => resolveWorker());
            return;
          }
          worker.postMessage(queue[nextIndex]);
          nextIndex += 1;
        };
        worker.on("message", (result: TrackResult) => {
          results.push(result);
          completed += 1;
          if (completed % 10 === 0 || completed === queue.length) {
            const elapsed = (Date.now() - startedAt) / 1000;
            const rate = completed / Math.max(0.001, elapsed);
            process.stdout.write(
              `\r  ${completed}/${queue.length} tracks  ${rate.toFixed(2)}/s  ` +
                `eta ${Math.round((queue.length - completed) / Math.max(0.001, rate))}s   `
            );
          }
          dispatch();
        });
        worker.on("error", rejectWorker);
        dispatch();
      })
    )
  );
  process.stdout.write("\n");

  report(results, options);
}

function report(results: TrackResult[], options: Options): void {
  const ok = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);

  const tempoErrors = ok.map((result) => result.tempo!.absoluteError);
  const beatF = ok.map((result) => result.beats!.fMeasure);
  const beatErrors = ok.map((result) => result.beats!.medianErrorMs).filter(Number.isFinite);
  const boundaryF = ok.map((result) => result.boundaries!.fMeasure);
  const energy = ok.map((result) => result.energyCorrelation!);

  const rate = (predicate: (result: TrackResult) => boolean): string =>
    `${((ok.filter(predicate).length / Math.max(1, ok.length)) * 100).toFixed(1)}%`;
  const mean = (values: number[]): number =>
    values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN;

  console.log("");
  console.log(`analysed ${ok.length} tracks (${failed.length} failed)`);
  console.log("");
  console.log("TEMPO vs Mixed In Key");
  console.log(`  within 0.10 BPM      ${rate((result) => result.tempo!.exact)}`);
  console.log(`  within 0.50 BPM      ${rate((result) => result.tempo!.tight)}`);
  console.log(`  within 2%            ${rate((result) => result.tempo!.within2Percent)}`);
  console.log(`  octave/metre errors  ${rate((result) => result.tempo!.octaveError)}`);
  console.log(
    `  abs error  median ${percentile(tempoErrors, 0.5).toFixed(3)}  ` +
      `p90 ${percentile(tempoErrors, 0.9).toFixed(3)}  max ${percentile(tempoErrors, 1).toFixed(2)} BPM`
  );
  console.log("");
  console.log("BEAT GRID vs Mixed In Key (70 ms tolerance)");
  console.log(`  mean F-measure       ${mean(beatF).toFixed(3)}`);
  console.log(`  F >= 0.95            ${rate((result) => result.beats!.fMeasure >= 0.95)}`);
  console.log(`  median beat error    ${percentile(beatErrors, 0.5).toFixed(1)} ms`);
  console.log(`  bar phase agrees     ${rate((result) => result.beats!.barPhaseAligned)}`);
  const phases = ok.map((result) => Math.abs(result.beats!.signedPhaseBeats));
  console.log(`  beat phase on grid   ${rate((result) => Math.abs(result.beats!.signedPhaseBeats) < 0.1)}`);
  console.log(`  offbeat locks        ${rate((result) => Math.abs(result.beats!.signedPhaseBeats) > 0.35)}`);
  console.log(`  other phase errors   ${rate((result) => {
    const phase = Math.abs(result.beats!.signedPhaseBeats);
    return phase >= 0.1 && phase <= 0.35;
  })}`);
  console.log(`  signed phase  median ${percentile(ok.map((result) => result.beats!.signedPhaseBeats), 0.5).toFixed(4)} beats  ` +
    `abs p90 ${percentile(phases, 0.9).toFixed(4)}`);
  console.log("");
  console.log("PHRASE GRID (do our boundaries land on the 8-bar grid?)");
  console.log(`  on grid              ${mean(ok.map((result) => result.grid!.onGridFraction)).toFixed(3)}`);
  console.log(`  median offset        ${percentile(ok.map((result) => result.grid!.medianOffsetBars), 0.5).toFixed(3)} bars`);
  console.log(`  fully on grid        ${rate((result) => result.grid!.onGridFraction >= 0.999)}`);
  console.log("");
  console.log("PHRASE BOUNDARIES vs Mixed In Key energy changes (1 bar tolerance)");
  console.log(`  all boundaries    F  ${mean(boundaryF).toFixed(3)}  ` +
    `P ${mean(ok.map((result) => result.boundaries!.precision)).toFixed(3)}  ` +
    `R ${mean(ok.map((result) => result.boundaries!.recall)).toFixed(3)}`);
  console.log(`  role changes only F  ${mean(ok.map((result) => result.sectionBoundaries!.fMeasure)).toFixed(3)}  ` +
    `P ${mean(ok.map((result) => result.sectionBoundaries!.precision)).toFixed(3)}  ` +
    `R ${mean(ok.map((result) => result.sectionBoundaries!.recall)).toFixed(3)}`);
  console.log("");
  const barEnergy = ok.map((result) => result.barEnergyCorrelation!);
  console.log("ENERGY CONTOUR vs Mixed In Key energy segments");
  console.log(`  per bar    mean ${mean(barEnergy).toFixed(3)}  median ${percentile(barEnergy, 0.5).toFixed(3)}`);
  console.log(`  per phrase mean ${mean(energy).toFixed(3)}  median ${percentile(energy, 0.5).toFixed(3)}`);
  console.log("");
  console.log(`  mean analysis time   ${mean(ok.map((result) => result.analysisMs!)).toFixed(0)} ms/track`);

  if (options.showWorst > 0) {
    console.log("");
    console.log(`WORST ${options.showWorst} BY TEMPO ERROR`);
    [...ok]
      .sort((left, right) => right.tempo!.absoluteError - left.tempo!.absoluteError)
      .slice(0, options.showWorst)
      .forEach((result) => {
        console.log(
          `  ${result.tempo!.bpm.toFixed(2).padStart(7)} vs ${result.tempo!.truthBpm.toFixed(2).padStart(7)}  ` +
            `beatF ${result.beats!.fMeasure.toFixed(2)}  phase ${result.beats!.barPhaseOffset.toFixed(2)}  ` +
            `${result.artist} - ${result.title}`.slice(0, 78)
        );
      });
  }

  if (failed.length) {
    console.log("");
    console.log("FAILURES");
    failed.slice(0, 10).forEach((result) => {
      console.log(`  ${result.error} :: ${result.path}`);
    });
  }

  if (options.reportPath) {
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, JSON.stringify({ options, results }, null, 2));
    console.log("");
    console.log(`wrote ${options.reportPath}`);
  }
}

void main();
