import { describe, expect, it, vi } from "vitest";

import { buildFollowPrint } from "../audio/follower.js";
import { analyzeBuffer } from "../audio/spectral.js";
import { TrackFollowerSession, describeFollower } from "../app/trackFollower.js";
import type { BuildPrintRequest, BuildPrintResponse } from "../app/followerWorker.js";

const SAMPLE_RATE = 22050;
const TEMPO = 128;

/** A short varied signal; the detector itself is tested against real audio. */
function signal(seconds: number): Float32Array {
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  let seed = 4242;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const time = index / SAMPLE_RATE;
    samples[index] =
      0.5 * Math.sin(2 * Math.PI * (110 + 40 * Math.sin(time)) * time) +
      0.2 * (seed / 0x3fffffff - 1);
  }
  return samples;
}

/** Runs the worker's job inline, so the glue can be tested without a Worker. */
function fakeWorkerFactory(onPost?: () => void): () => Worker {
  return () => {
    const worker = {
      onmessage: null as ((event: MessageEvent<BuildPrintResponse>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      terminate: vi.fn(),
      postMessage(request: BuildPrintRequest) {
        onPost?.();
        const print = buildFollowPrint(analyzeBuffer(request.samples, request.sampleRate), {
          tempo: request.tempo
        });
        queueMicrotask(() => {
          this.onmessage?.({ data: { ok: true, print } } as MessageEvent<BuildPrintResponse>);
        });
      }
    };
    return worker as unknown as Worker;
  };
}

function failingWorkerFactory(error: string): () => Worker {
  return () =>
    ({
      onmessage: null,
      onerror: null,
      terminate: vi.fn(),
      postMessage() {
        queueMicrotask(() => {
          (this as unknown as { onmessage: ((event: MessageEvent<BuildPrintResponse>) => void) | null }).onmessage?.({
            data: { ok: false, error }
          } as MessageEvent<BuildPrintResponse>);
        });
      }
    }) as unknown as Worker;
}

function session(options: Partial<{ createWorker: () => Worker; decode: () => Promise<{ samples: Float32Array; sampleRate: number }> }> = {}) {
  return new TrackFollowerSession({
    createWorker: options.createWorker ?? fakeWorkerFactory(),
    decode: options.decode ?? (async () => ({ samples: signal(25), sampleRate: SAMPLE_RATE }))
  });
}

describe("TrackFollowerSession", () => {
  it("follows a prepared track once audio arrives", async () => {
    const follower = session();
    await follower.prepare({ audioUrl: "/audio", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    expect(follower.snapshot.state).toBe("following");

    const source = signal(25);
    // Play from ten seconds in, in blocks, as the microphone would deliver it.
    const start = Math.floor(10 * SAMPLE_RATE);
    for (let offset = start; offset < start + SAMPLE_RATE * 8; offset += 2048) {
      follower.push(source.subarray(offset, offset + 2048));
    }
    expect(follower.following).toBe(true);
    expect(follower.snapshot.follow?.positionSeconds).toBeCloseTo(18, 0);
  });

  it("ignores microphone audio before a track is prepared", () => {
    const follower = session();
    expect(() => follower.push(signal(0.5))).not.toThrow();
    expect(follower.snapshot.state).toBe("idle");
    expect(follower.following).toBe(false);
  });

  it("reports a failed reference instead of following the wrong thing", async () => {
    const follower = session({ createWorker: failingWorkerFactory("analysis blew up") });
    await follower.prepare({ audioUrl: "/audio", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    expect(follower.snapshot.state).toBe("failed");
    expect(follower.snapshot.error).toContain("analysis blew up");
    expect(follower.following).toBe(false);
  });

  it("reports a failed download the same way", async () => {
    const follower = session({
      decode: async () => {
        throw new Error("audio unavailable (404)");
      }
    });
    await follower.prepare({ audioUrl: "/gone", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    expect(follower.snapshot.state).toBe("failed");
    expect(follower.snapshot.error).toContain("404");
  });

  it("discards a stale prepare rather than overwriting a newer track", async () => {
    let releaseFirst = (): void => {};
    const slow = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const follower = session({
      decode: async () => {
        call += 1;
        if (call === 1) {
          await slow;
          return { samples: signal(25), sampleRate: SAMPLE_RATE };
        }
        return { samples: signal(25), sampleRate: SAMPLE_RATE };
      }
    });

    const first = follower.prepare({ audioUrl: "/one", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    const second = follower.prepare({ audioUrl: "/two", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    await second;
    expect(follower.snapshot.state).toBe("following");

    releaseFirst();
    await first;
    // The late first track must not have clobbered the second.
    expect(follower.snapshot.state).toBe("following");
  });

  it("stops cleanly and forgets the track", async () => {
    const follower = session();
    await follower.prepare({ audioUrl: "/audio", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    follower.stop();
    expect(follower.snapshot.state).toBe("idle");
    follower.push(signal(0.5));
    expect(follower.snapshot.state).toBe("idle");
  });

  it("ignores a nonsensical rate hint", async () => {
    const follower = session();
    await follower.prepare({ audioUrl: "/audio", tempo: TEMPO, micSampleRate: SAMPLE_RATE });
    expect(() => follower.setLiveBpm(0, TEMPO)).not.toThrow();
    expect(() => follower.setLiveBpm(Number.NaN, TEMPO)).not.toThrow();
    expect(() => follower.setLiveBpm(128, 0)).not.toThrow();
  });
});

describe("describeFollower", () => {
  it("says nothing when the follower is not in use", () => {
    expect(describeFollower({ state: "idle", follow: null, error: null })).toBeNull();
  });

  it("names the loop length while a deck is looping", () => {
    const text = describeFollower({
      state: "following",
      error: null,
      follow: {
        state: "tracking",
        positionSeconds: 42,
        confidence: 0.9,
        rate: 1,
        jump: null,
        loop: { beats: 4, startSeconds: 40, endSeconds: 41.9, repeats: 3 }
      }
    });
    expect(text).toBe("Following deck · 4-beat loop ×3");
  });

  it("explains a failure rather than silently falling back", () => {
    const text = describeFollower({ state: "failed", follow: null, error: "audio unavailable (404)" });
    expect(text).toContain("404");
  });
});
