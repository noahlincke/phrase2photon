import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { PositionFollower, buildFollowPrint } from "../../src/audio/follower.js";
import { SpectralAnalyzer, analyzeBuffer } from "../../src/audio/spectral.js";
import { decodeMono } from "./decodeAudio.js";

/**
 * Measures position following against real tracks performed like a DJ would.
 *
 * Synthetic audio is useless for this. A click track is self-similar by
 * construction, so a follower that cannot tell bar 3 from bar 11 scores
 * perfectly on it, and one that can has nothing to prove. Real tracks with
 * Mixed In Key's beat grid as ground truth are the only honest test.
 *
 * Each track is replayed as a performance - straight playback, a four-beat
 * loop held for a few rounds, a release, a cue jump, an eight-beat loop - and
 * scored on whether the follower knew where it was throughout.
 */

interface TruthSong {
  path: string;
  bpm: number;
  beatTimes: number[];
}

/** One contiguous stretch of the reference, as played. */
interface Segment {
  startSeconds: number;
  endSeconds: number;
}

interface InjectedEvent {
  kind: "loop" | "seek";
  /** Time in the performance stream at which it happens. */
  atStreamSeconds: number;
  /** Loop length in beats, for loops. */
  beats?: number;
}

interface Performance {
  samples: Float32Array;
  /** Reference position for each performance second, as a step function. */
  segments: { streamStart: number; streamEnd: number; referenceStart: number }[];
  events: InjectedEvent[];
}

interface FollowResult {
  path: string;
  ok: boolean;
  error?: string;
  /** Median absolute position error in seconds, settled columns only. */
  medianErrorSeconds?: number;
  withinHundredMs?: number;
  withinBeat?: number;
  loopsInjected?: number;
  loopsDetected?: number;
  loopsWithRightLength?: number;
  seeksInjected?: number;
  seeksDetected?: number;
  falseLoops?: number;
  /** Median seconds from an injected event to the follower reporting it. */
  medianEventLatency?: number;
}

const SETTLE_SECONDS = 2.5;
const EVENT_MATCH_WINDOW = 2.5;

function nearestBeat(beatTimes: number[], seconds: number): number {
  let best = beatTimes[0] ?? seconds;
  let bestDistance = Infinity;
  for (const time of beatTimes) {
    const distance = Math.abs(time - seconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = time;
    }
  }
  return best;
}

/** Splices the track into the performance described above. */
function buildPerformance(samples: Float32Array, sampleRate: number, song: TruthSong): Performance {
  const beat = 60 / song.bpm;
  const duration = samples.length / sampleRate;
  const beatTimes = song.beatTimes;

  const entry = nearestBeat(beatTimes, Math.max(20, duration * 0.2));
  const loopOneIn = nearestBeat(beatTimes, entry + 20);
  const loopOneOut = loopOneIn + 4 * beat;
  const afterLoopOne = loopOneOut;
  const seekTarget = nearestBeat(beatTimes, Math.min(duration - 45, entry + 100));
  const loopTwoIn = nearestBeat(beatTimes, seekTarget + 15);
  const loopTwoOut = loopTwoIn + 8 * beat;

  const plan: Segment[] = [
    { startSeconds: entry, endSeconds: loopOneIn },
    // Four rounds of a four-beat loop.
    { startSeconds: loopOneIn, endSeconds: loopOneOut },
    { startSeconds: loopOneIn, endSeconds: loopOneOut },
    { startSeconds: loopOneIn, endSeconds: loopOneOut },
    { startSeconds: loopOneIn, endSeconds: loopOneOut },
    // Released: playback continues past the loop-out point.
    { startSeconds: afterLoopOne, endSeconds: afterLoopOne + 10 },
    // Cue jump.
    { startSeconds: seekTarget, endSeconds: loopTwoIn },
    { startSeconds: loopTwoIn, endSeconds: loopTwoOut },
    { startSeconds: loopTwoIn, endSeconds: loopTwoOut },
    { startSeconds: loopTwoIn, endSeconds: loopTwoOut },
    { startSeconds: loopTwoOut, endSeconds: loopTwoOut + 10 }
  ];

  const segments: Performance["segments"] = [];
  const events: InjectedEvent[] = [];
  let totalSamples = 0;
  const slices: Float32Array[] = [];
  let streamSeconds = 0;

  for (let index = 0; index < plan.length; index += 1) {
    const segment = plan[index];
    const start = Math.max(0, Math.floor(segment.startSeconds * sampleRate));
    const end = Math.min(samples.length, Math.floor(segment.endSeconds * sampleRate));
    if (end <= start) {
      continue;
    }
    const slice = samples.subarray(start, end);
    slices.push(slice);
    totalSamples += slice.length;

    const lengthSeconds = slice.length / sampleRate;
    if (index > 0) {
      const previous = segments[segments.length - 1];
      const expectedContinuation = previous.referenceStart + (previous.streamEnd - previous.streamStart);
      const delta = segment.startSeconds - expectedContinuation;
      if (Math.abs(delta) > 0.35) {
        const beats = delta / beat;
        events.push(
          delta < 0
            ? { kind: "loop", atStreamSeconds: streamSeconds, beats: Math.abs(Math.round(beats)) }
            : { kind: "seek", atStreamSeconds: streamSeconds }
        );
      }
    }
    segments.push({
      streamStart: streamSeconds,
      streamEnd: streamSeconds + lengthSeconds,
      referenceStart: segment.startSeconds
    });
    streamSeconds += lengthSeconds;
  }

  const performance = new Float32Array(totalSamples);
  let offset = 0;
  for (const slice of slices) {
    performance.set(slice, offset);
    offset += slice.length;
  }
  return { samples: performance, segments, events };
}

function expectedPosition(performance: Performance, streamSeconds: number): number | null {
  for (const segment of performance.segments) {
    if (streamSeconds >= segment.streamStart && streamSeconds < segment.streamEnd) {
      return segment.referenceStart + (streamSeconds - segment.streamStart);
    }
  }
  return null;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function runTrack(song: TruthSong, sampleRate: number): Promise<FollowResult> {
  const samples = await decodeMono(song.path, sampleRate);
  if (samples.length < sampleRate * 120) {
    return { path: song.path, ok: false, error: "too short" };
  }

  const features = analyzeBuffer(samples, sampleRate);
  const print = buildFollowPrint(features, { tempo: song.bpm });
  const performance = buildPerformance(samples, sampleRate, song);

  const follower = new PositionFollower(print);
  const analyzer = new SpectralAnalyzer(sampleRate);
  const beat = 60 / song.bpm;

  const errors: number[] = [];
  let withinHundred = 0;
  let withinBeat = 0;
  const reported: { kind: string; beats: number; atStreamSeconds: number }[] = [];

  let frameIndex = 0;
  analyzer.push(performance.samples, (frame) => {
    const streamSeconds = frame.timeSeconds;
    const status = follower.pushFrame(frame.bands);
    frameIndex += 1;

    if (status.jump !== null) {
      reported.push({
        kind: status.jump.kind,
        beats: Math.abs(status.jump.beats),
        atStreamSeconds: streamSeconds
      });
    }

    const expected = expectedPosition(performance, streamSeconds);
    if (expected === null || streamSeconds < SETTLE_SECONDS) {
      return;
    }
    // Skip the settling window after each splice; the follower cannot know
    // about an event before it has heard any audio from the other side of it.
    const nearEvent = performance.events.some(
      (event) => streamSeconds >= event.atStreamSeconds && streamSeconds < event.atStreamSeconds + SETTLE_SECONDS
    );
    if (nearEvent) {
      return;
    }
    const error = Math.abs(status.positionSeconds - expected);
    errors.push(error);
    if (error <= 0.1) withinHundred += 1;
    if (error <= beat) withinBeat += 1;
  });

  const injectedLoops = performance.events.filter((event) => event.kind === "loop");
  const injectedSeeks = performance.events.filter((event) => event.kind === "seek");
  const latencies: number[] = [];
  let loopsDetected = 0;
  let loopsRightLength = 0;
  let seeksDetected = 0;
  const consumed = new Set<number>();

  for (const event of performance.events) {
    const matchIndex = reported.findIndex(
      (candidate, index) =>
        !consumed.has(index) &&
        candidate.kind === (event.kind === "loop" ? "loop" : "seek") &&
        candidate.atStreamSeconds >= event.atStreamSeconds - 0.2 &&
        candidate.atStreamSeconds <= event.atStreamSeconds + EVENT_MATCH_WINDOW
    );
    if (matchIndex < 0) {
      continue;
    }
    consumed.add(matchIndex);
    const match = reported[matchIndex];
    latencies.push(match.atStreamSeconds - event.atStreamSeconds);
    if (event.kind === "loop") {
      loopsDetected += 1;
      if (event.beats !== undefined && Math.abs(match.beats - event.beats) <= event.beats * 0.15) {
        loopsRightLength += 1;
      }
    } else {
      seeksDetected += 1;
    }
  }

  const falseLoops = reported.filter(
    (candidate, index) => candidate.kind === "loop" && !consumed.has(index)
  ).length;

  return {
    path: song.path,
    ok: errors.length > 0,
    medianErrorSeconds: median(errors),
    withinHundredMs: withinHundred / Math.max(1, errors.length),
    withinBeat: withinBeat / Math.max(1, errors.length),
    loopsInjected: injectedLoops.length,
    loopsDetected,
    loopsWithRightLength: loopsRightLength,
    seeksInjected: injectedSeeks.length,
    seeksDetected,
    falseLoops,
    medianEventLatency: median(latencies)
  };
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { sampleRate } = workerData as { sampleRate: number };
  port.on("message", async (song: TruthSong | null) => {
    if (song === null) {
      return;
    }
    try {
      port.postMessage(await runTrack(song, sampleRate));
    } catch (error) {
      port.postMessage({ path: song.path, ok: false, error: String(error) } satisfies FollowResult);
    }
  });
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = resolve(here, "..", "..", "..", "..");
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  const limit = read("--limit", 40);
  const workers = read("--workers", Math.max(1, Math.min(8, cpus().length - 2)));
  const sampleRate = read("--sample-rate", 44100);
  const minBpm = read("--min-bpm", 0);
  const maxBpm = read("--max-bpm", 400);

  const truth = JSON.parse(
    readFileSync(resolve(runtimeRoot, ".analysis-cache", "mik-truth.json"), "utf8")
  ) as { songs: TruthSong[] };
  const eligible = truth.songs.filter(
    (song) => song.beatTimes.length >= 256 && song.bpm >= minBpm && song.bpm <= maxBpm
  );
  let state = 11 * 2654435761 + 1;
  const indices = eligible.map((_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  const queue = indices.slice(0, limit).map((index) => eligible[index]);
  console.log(`following ${queue.length} tracks through simulated DJ performances`);

  const results: FollowResult[] = [];
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
        worker.on("message", (result: FollowResult) => {
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
  const sum = (pick: (result: FollowResult) => number): number =>
    ok.reduce((total, result) => total + pick(result), 0);

  const loopsInjected = sum((result) => result.loopsInjected ?? 0);
  const seeksInjected = sum((result) => result.seeksInjected ?? 0);

  console.log(`tracks scored:            ${ok.length}/${results.length}`);
  console.log(`median position error:    ${(median(ok.map((r) => r.medianErrorSeconds ?? 0)) * 1000).toFixed(0)} ms`);
  console.log(
    `within 100 ms:            ${((median(ok.map((r) => r.withinHundredMs ?? 0))) * 100).toFixed(1)}% of columns (median track)`
  );
  console.log(
    `within one beat:          ${((median(ok.map((r) => r.withinBeat ?? 0))) * 100).toFixed(1)}% of columns (median track)`
  );
  console.log(
    `loops detected:           ${sum((r) => r.loopsDetected ?? 0)}/${loopsInjected} (${((sum((r) => r.loopsDetected ?? 0) / Math.max(1, loopsInjected)) * 100).toFixed(1)}%)`
  );
  console.log(
    `  correct loop length:    ${sum((r) => r.loopsWithRightLength ?? 0)}/${loopsInjected} (${((sum((r) => r.loopsWithRightLength ?? 0) / Math.max(1, loopsInjected)) * 100).toFixed(1)}%)`
  );
  console.log(
    `cue jumps detected:       ${sum((r) => r.seeksDetected ?? 0)}/${seeksInjected} (${((sum((r) => r.seeksDetected ?? 0) / Math.max(1, seeksInjected)) * 100).toFixed(1)}%)`
  );
  console.log(`spurious loop reports:    ${sum((r) => r.falseLoops ?? 0)}`);
  console.log(`median event latency:     ${(median(ok.map((r) => r.medianEventLatency ?? 0)) * 1000).toFixed(0)} ms`);

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    console.log(`\nskipped ${failures.length}: ${failures.slice(0, 3).map((f) => f.error).join(", ")}`);
  }
}
