import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";

import { LiveAnalyzer } from "../../src/audio/liveAnalysis.js";
import { decodeMono } from "./decodeAudio.js";
import { percentile, scoreBeats, scoreTempo, type TruthSong } from "./score.js";

/**
 * Scores the live (microphone-path) analyser against Mixed In Key.
 *
 * Streams each decoded file through `LiveAnalyzer` in 128-sample blocks -
 * exactly what an AudioWorklet delivers - so the numbers reflect what the
 * real-time path actually does, not what the offline path could do with the
 * whole file in hand. Mic input is the primary way this tool gets used, so it
 * gets measured, not assumed.
 */

const BLOCK_SIZE = 128;

/** True when two declared downbeats sit on the same bar phase. */
function barPhaseAgrees(ours: number, reference: number, periodSeconds: number): boolean {
  const phase = (((ours - reference) / periodSeconds) % 4 + 4) % 4;
  return Math.min(phase, 4 - phase) <= 0.25;
}

/** Ignore the first part of a track: live capture has no lock yet. */
const WARMUP_SECONDS = 25;

interface LiveResult {
  title: string;
  artist: string;
  ok: boolean;
  error?: string;
  bpm?: number;
  truthBpm?: number;
  tempoExact?: boolean;
  tempoTight?: boolean;
  within2Percent?: boolean;
  lockSeconds?: number | null;
  beatF?: number;
  signedPhaseBeats?: number;
  barPhaseAligned?: boolean;
}

if (!isMainThread) {
  const { sampleRate } = workerData as { sampleRate: number };
  parentPort?.on("message", async (song: TruthSong | null) => {
    if (song === null) {
      parentPort?.close();
      return;
    }
    const base = { title: song.title, artist: song.artist };
    try {
      const samples = await decodeMono(song.path, sampleRate);
      const analyzer = new LiveAnalyzer(sampleRate);
      const beatTimes: number[] = [];
      let firstDownbeat: number | null = null;
      let lockSeconds: number | null = null;

      analyzer.onBeat = (beat) => {
        if (beat.time < WARMUP_SECONDS) {
          return;
        }
        beatTimes.push(beat.time);
        if (firstDownbeat === null && beat.beatInBar === 1) {
          firstDownbeat = beat.time;
        }
      };

      for (let offset = 0; offset < samples.length; offset += BLOCK_SIZE) {
        analyzer.push(samples.subarray(offset, Math.min(samples.length, offset + BLOCK_SIZE)), offset / sampleRate);
        if (lockSeconds === null && analyzer.snapshot(offset / sampleRate).tempoState === "locked") {
          lockSeconds = offset / sampleRate;
        }
      }

      const duration = samples.length / sampleRate;
      const state = analyzer.snapshot(duration);
      if (beatTimes.length < 32) {
        parentPort?.postMessage({ ...base, ok: false, error: "too few beats after warmup" } satisfies LiveResult);
        return;
      }

      // Compare only over the span where the live grid exists.
      const truthBeats = song.beatTimes.filter((time) => time >= WARMUP_SECONDS);
      // Bar phase has to be measured against a beat the reference itself calls
      // beat 1. Its grid starts at beatTimes[0], so downbeats are the indices
      // divisible by four - not simply the first beat past the warmup.
      const firstAfterWarmup = song.beatTimes.findIndex((time) => time >= WARMUP_SECONDS);
      const referenceDownbeatIndex = firstAfterWarmup < 0 ? -1 : Math.ceil(firstAfterWarmup / 4) * 4;
      const referenceDownbeat =
        referenceDownbeatIndex >= 0 && referenceDownbeatIndex < song.beatTimes.length
          ? song.beatTimes[referenceDownbeatIndex]
          : null;
      const period = 60 / state.bpm;
      // Bar phase must be measured from a beat the analyser actually calls
      // beat 1, not from whichever beat happened to come first.
      const beats = scoreBeats(
        Float64Array.from(beatTimes),
        firstDownbeat ?? beatTimes[0],
        period,
        truthBeats
      );
      const barPhaseAligned =
        firstDownbeat !== null && referenceDownbeat !== null
          ? barPhaseAgrees(firstDownbeat, referenceDownbeat, period)
          : false;
      const tempo = scoreTempo(state.bpm, song.bpm);

      parentPort?.postMessage({
        ...base,
        ok: true,
        bpm: state.bpm,
        truthBpm: song.bpm,
        tempoExact: tempo.exact,
        tempoTight: tempo.tight,
        within2Percent: tempo.within2Percent,
        lockSeconds,
        beatF: beats.fMeasure,
        signedPhaseBeats: beats.signedPhaseBeats,
        barPhaseAligned
      } satisfies LiveResult);
    } catch (error) {
      parentPort?.postMessage({
        ...base,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies LiveResult);
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
  const limit = read("--limit", 120);
  const workers = read("--workers", Math.max(1, Math.min(10, cpus().length - 2)));
  const sampleRate = read("--sample-rate", 44100);
  const minBpm = read("--min-bpm", 0);
  const maxBpm = read("--max-bpm", 400);

  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (song) => song.beatTimes.length >= 128 && song.bpm >= minBpm && song.bpm <= maxBpm
  );
  let state = 7 * 2654435761 + 1;
  const indices = eligible.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  const queue = indices.slice(0, limit).map((index) => eligible[index]);
  console.log(`streaming ${queue.length} tracks through the live analyser`);

  const results: LiveResult[] = [];
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
        worker.on("message", (result: LiveResult) => {
          results.push(result);
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

  const ok = results.filter((result) => result.ok);
  const rate = (predicate: (result: LiveResult) => boolean): string =>
    `${((ok.filter(predicate).length / Math.max(1, ok.length)) * 100).toFixed(1)}%`;
  const mean = (values: number[]): number =>
    values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN;

  console.log(`${ok.length} tracks analysed live (${results.length - ok.length} failed)`);
  console.log("");
  console.log("LIVE TEMPO");
  console.log(`  within 0.10 BPM      ${rate((result) => result.tempoExact!)}`);
  console.log(`  within 0.50 BPM      ${rate((result) => result.tempoTight!)}`);
  console.log(`  within 2%            ${rate((result) => result.within2Percent!)}`);
  const locks = ok.map((result) => result.lockSeconds).filter((value): value is number => value !== null);
  console.log(`  locked at all        ${((locks.length / Math.max(1, ok.length)) * 100).toFixed(1)}%`);
  console.log(`  time to lock         median ${percentile(locks, 0.5).toFixed(1)} s  p90 ${percentile(locks, 0.9).toFixed(1)} s`);
  console.log("");
  console.log("LIVE BEAT GRID");
  console.log(`  mean F-measure       ${mean(ok.map((result) => result.beatF!)).toFixed(3)}`);
  console.log(`  F >= 0.95            ${rate((result) => result.beatF! >= 0.95)}`);
  console.log(`  beat phase on grid   ${rate((result) => Math.abs(result.signedPhaseBeats!) < 0.1)}`);
  console.log(`  offbeat locks        ${rate((result) => Math.abs(result.signedPhaseBeats!) > 0.35)}`);
  console.log(`  bar phase agrees     ${rate((result) => result.barPhaseAligned!)}`);
  // Bar phase can only be right when the beat phase is; report it both ways so
  // the two failure modes are not confused with each other.
  const onGrid = ok.filter((result) => Math.abs(result.signedPhaseBeats!) < 0.1);
  const onGridBarPhase = onGrid.filter((result) => result.barPhaseAligned!).length;
  console.log(
    `    of those on grid   ${((onGridBarPhase / Math.max(1, onGrid.length)) * 100).toFixed(1)}% ` +
      `(${onGrid.length} tracks)`
  );

  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    console.log("");
    console.log("FAILURES");
    failures.slice(0, 8).forEach((result) => console.log(`  ${result.error} :: ${result.artist} - ${result.title}`));
  }
}
