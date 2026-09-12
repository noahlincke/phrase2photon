import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { PositionFollower, buildFollowPrint } from "../../src/audio/follower.js";
import { SpectralAnalyzer, analyzeBuffer } from "../../src/audio/spectral.js";
import { decodeMono } from "./decodeAudio.js";

/**
 * Measures how separable a DJ loop is from the arrangement repeating itself.
 *
 * The loop detector rests on the claim that a looping deck replays the same
 * samples while musical repetition only sounds similar. Dance music is built
 * out of copy-pasted bars, so that claim needs a number on it rather than an
 * assumption: this samples live self-similarity while a loop is running and
 * while the track simply plays, and reports the two distributions.
 */

interface TruthSong { path: string; bpm: number; beatTimes: number[] }
interface StudyResult { path: string; ok: boolean; looping: number[]; playing: number[] }

const PROBE_BEATS = [1, 2, 4, 8, 16];

async function runTrack(song: TruthSong, sampleRate: number): Promise<StudyResult> {
  const samples = await decodeMono(song.path, sampleRate);
  const print = buildFollowPrint(analyzeBuffer(samples, sampleRate), { tempo: song.bpm });
  const beat = 60 / song.bpm;
  const sr = sampleRate;

  const slice = (a: number, b: number): Float32Array =>
    samples.subarray(Math.max(0, Math.floor(a * sr)), Math.min(samples.length, Math.floor(b * sr)));

  const entry = Math.max(30, (samples.length / sr) * 0.25);
  const loopIn = entry + 25;
  const parts: Float32Array[] = [slice(entry, loopIn)];
  for (let round = 0; round < 4; round += 1) parts.push(slice(loopIn, loopIn + 4 * beat));
  const loopStartStream = (parts[0].length) / sr;
  const loopEndStream = loopStartStream + (4 * 4 * beat);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const stream = new Float32Array(total);
  let off = 0;
  for (const p of parts) { stream.set(p, off); off += p.length; }

  const follower = new PositionFollower(print);
  const analyzer = new SpectralAnalyzer(sampleRate);
  const looping: number[] = [];
  const playing: number[] = [];

  analyzer.push(stream, (frame) => {
    follower.pushFrame(frame.bands);
    const t = frame.timeSeconds;
    let best = -1;
    for (const beats of PROBE_BEATS) {
      best = Math.max(best, follower.selfSimilarityForBeats(beats));
    }
    if (best < 0) return;
    // Inside the loop, past the first round so a full lag of history exists.
    if (t > loopStartStream + 4 * beat + 1 && t < loopEndStream) looping.push(best);
    else if (t > 20 && t < loopStartStream - 2) playing.push(best);
  });

  return { path: song.path, ok: looping.length > 10 && playing.length > 10, looping, playing };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { sampleRate } = workerData as { sampleRate: number };
  port.on("message", async (song: TruthSong | null) => {
    if (song === null) return;
    try { port.postMessage(await runTrack(song, sampleRate)); }
    catch { port.postMessage({ path: song.path, ok: false, looping: [], playing: [] } satisfies StudyResult); }
  });
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, "..", "..", "..", "..");
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : fallback;
  };
  const limit = read("--limit", 24);
  const sampleRate = 44100;
  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (s) => s.beatTimes.length >= 256 && s.bpm >= read("--min-bpm", 115) && s.bpm <= read("--max-bpm", 145)
  );
  let state = 11 * 2654435761 + 1;
  const indices = eligible.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const queue = indices.slice(0, limit).map((i) => eligible[i]);

  const results: StudyResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, cpus().length - 2), queue.length) }, () =>
      new Promise<void>((res, rej) => {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { sampleRate } });
        const dispatch = (): void => {
          if (next >= queue.length) { worker.postMessage(null); void worker.terminate().then(() => res()); return; }
          worker.postMessage(queue[next]); next += 1;
        };
        worker.on("message", (r: StudyResult) => { results.push(r); dispatch(); });
        worker.on("error", rej);
        dispatch();
      })
    )
  );

  const ok = results.filter((r) => r.ok);
  const looping = ok.flatMap((r) => r.looping);
  const playing = ok.flatMap((r) => r.playing);
  console.log(`tracks: ${ok.length}/${results.length}\n`);
  console.log("live self-similarity, best over 1/2/4/8/16-beat lags");
  console.log("                       p05    p25    median   p75    p95");
  const row = (label: string, v: number[]): void =>
    console.log(
      `${label.padEnd(22)}${[0.05, 0.25, 0.5, 0.75, 0.95].map((q) => quantile(v, q).toFixed(3).padEnd(7)).join("")}`
    );
  row("deck looping", looping);
  row("just playing", playing);

  console.log("\nthreshold  loop recall   false-positive rate");
  for (const threshold of [0.80, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94, 0.96]) {
    const recall = looping.filter((v) => v >= threshold).length / Math.max(1, looping.length);
    const fpr = playing.filter((v) => v >= threshold).length / Math.max(1, playing.length);
    console.log(`  ${threshold.toFixed(2)}      ${(recall * 100).toFixed(1).padStart(5)}%        ${(fpr * 100).toFixed(1).padStart(5)}%`);
  }
}
