import { PositionFollower, type FollowPrint, type FollowStatus } from "../audio/follower.js";
import { SpectralAnalyzer } from "../audio/spectral.js";
import type { BuildPrintRequest, BuildPrintResponse } from "./followerWorker.js";

/**
 * Follows a known track through a DJ performance, using the microphone.
 *
 * Now Playing already knows what is playing and has analysed it. What it does
 * not know is where in the track the deck actually is: rekordbox reports a
 * position inferred from file read offsets, which is coarse and never moves
 * backwards, so a loop or a cue jump leaves the visuals running on a timeline
 * the DJ has already left.
 *
 * Pointing the microphone at the same audio closes that gap. The analysed
 * track becomes a reference and the live signal is matched against it, which
 * makes loops and cue jumps ordinary rather than special.
 */

export type TrackFollowerState = "idle" | "preparing" | "following" | "failed";

export interface TrackFollowerSnapshot {
  state: TrackFollowerState;
  /** Populated once a reference has been built and audio is arriving. */
  follow: FollowStatus | null;
  error: string | null;
}

const IDLE: TrackFollowerSnapshot = { state: "idle", follow: null, error: null };

export interface TrackFollowerOptions {
  /** Injected in tests; defaults to the bundled worker. */
  createWorker?: () => Worker;
  /** Injected in tests; defaults to fetch + WebAudio decoding. */
  decode?: (audioUrl: string) => Promise<{ samples: Float32Array; sampleRate: number }>;
}

async function decodeWithWebAudio(audioUrl: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`audio unavailable (${response.status})`);
  }
  const encoded = await response.arrayBuffer();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(encoded);
    const channels = buffer.numberOfChannels;
    const mixed = new Float32Array(buffer.length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < buffer.length; index += 1) {
        mixed[index] += data[index] / channels;
      }
    }
    return { samples: mixed, sampleRate: buffer.sampleRate };
  } finally {
    void context.close();
  }
}

export class TrackFollowerSession {
  private readonly createWorker: () => Worker;
  private readonly decode: (audioUrl: string) => Promise<{ samples: Float32Array; sampleRate: number }>;

  private follower: PositionFollower | null = null;
  private analyzer: SpectralAnalyzer | null = null;
  private worker: Worker | null = null;
  private snapshotState: TrackFollowerSnapshot = IDLE;
  /** Identifies which prepare call a late worker reply belongs to. */
  private generation = 0;

  constructor(options: TrackFollowerOptions = {}) {
    this.createWorker =
      options.createWorker ??
      (() => new Worker(new URL("./followerWorker.js", import.meta.url), { type: "module" }));
    this.decode = options.decode ?? decodeWithWebAudio;
  }

  get snapshot(): TrackFollowerSnapshot {
    return this.snapshotState;
  }

  get following(): boolean {
    return this.snapshotState.state === "following" && this.snapshotState.follow?.state === "tracking";
  }

  /**
   * Builds a reference for a track, replacing any previous one.
   *
   * Safe to call again before an earlier prepare has finished; the stale reply
   * is discarded rather than overwriting a newer reference.
   */
  async prepare(options: {
    audioUrl: string;
    tempo: number;
    micSampleRate: number;
    firstDownbeatSeconds?: number;
  }): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    this.follower = null;
    this.analyzer = null;
    this.snapshotState = { state: "preparing", follow: null, error: null };

    let decoded: { samples: Float32Array; sampleRate: number };
    try {
      decoded = await this.decode(options.audioUrl);
    } catch (error) {
      this.fail(generation, error);
      return;
    }
    if (generation !== this.generation) {
      return;
    }

    const print = await this.buildPrint(generation, {
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      tempo: options.tempo,
      firstDownbeatSeconds: options.firstDownbeatSeconds ?? 0
    });
    if (print === null || generation !== this.generation) {
      return;
    }

    this.follower = new PositionFollower(print);
    // The reference is analysed at the file's sample rate and the microphone
    // runs at the device's; each side times its own columns, so the two only
    // have to agree on the feature, not on the clock.
    this.analyzer = new SpectralAnalyzer(options.micSampleRate);
    this.snapshotState = { state: "following", follow: this.follower.status, error: null };
  }

  private buildPrint(generation: number, request: BuildPrintRequest): Promise<FollowPrint | null> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = this.createWorker();
      } catch (error) {
        this.fail(generation, error);
        resolve(null);
        return;
      }
      this.worker?.terminate();
      this.worker = worker;

      worker.onmessage = (event: MessageEvent<BuildPrintResponse>) => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = null;
        }
        if (!event.data.ok) {
          this.fail(generation, new Error(event.data.error));
          resolve(null);
          return;
        }
        resolve(event.data.print);
      };
      worker.onerror = (event) => {
        worker.terminate();
        this.fail(generation, new Error(event.message || "analysis worker failed"));
        resolve(null);
      };
      worker.postMessage(request, [request.samples.buffer]);
    });
  }

  private fail(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    this.snapshotState = {
      state: "failed",
      follow: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  /** Feeds one block of microphone samples. */
  push(samples: Float32Array): void {
    const follower = this.follower;
    const analyzer = this.analyzer;
    if (follower === null || analyzer === null) {
      return;
    }
    let latest = follower.status;
    analyzer.push(samples, (frame) => {
      const status = follower.pushFrame(frame.bands);
      // A jump is reported on exactly one frame, so it must not be dropped by
      // simply keeping the last status of the block.
      if (status.jump !== null || latest.jump === null) {
        latest = status;
      }
    });
    this.snapshotState = { state: "following", follow: latest, error: null };
  }

  /**
   * Tells the follower how fast the deck is running, from the live tempo.
   *
   * The pitch fader is the one thing the reference cannot know about, and the
   * live tempo estimate measures it directly.
   */
  setLiveBpm(bpm: number, referenceTempo: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(referenceTempo) || referenceTempo <= 0) {
      return;
    }
    this.follower?.setRateHint(bpm / referenceTempo);
  }

  stop(): void {
    this.generation += 1;
    this.worker?.terminate();
    this.worker = null;
    this.follower = null;
    this.analyzer = null;
    this.snapshotState = IDLE;
  }
}

/** One line describing what the follower is doing, for the status area. */
export function describeFollower(snapshot: TrackFollowerSnapshot): string | null {
  switch (snapshot.state) {
    case "idle":
      return null;
    case "preparing":
      return "Listening for the deck: analysing track…";
    case "failed":
      return `Deck following unavailable: ${snapshot.error ?? "unknown error"}`;
    case "following": {
      const follow = snapshot.follow;
      if (follow === null || follow.state !== "tracking") {
        return "Listening for the deck…";
      }
      if (follow.loop !== null) {
        return `Following deck · ${follow.loop.beats}-beat loop ×${follow.loop.repeats}`;
      }
      return "Following deck";
    }
  }
}
