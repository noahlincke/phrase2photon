import { buildFollowPrint, type FollowPrint } from "../audio/follower.js";
import { analyzeBuffer } from "../audio/spectral.js";

/**
 * Builds a follow print off the main thread.
 *
 * Analysing a six-minute track takes long enough to drop frames if it happens
 * on the render thread, and it happens exactly when a new track has just been
 * armed - the worst possible moment to stutter.
 */

export interface BuildPrintRequest {
  samples: Float32Array;
  sampleRate: number;
  tempo: number;
  firstDownbeatSeconds: number;
}

export type BuildPrintResponse = { ok: true; print: FollowPrint } | { ok: false; error: string };

/**
 * The DOM lib types `self` as a Window, whose `postMessage` takes an origin
 * rather than a transfer list. In a module worker it is really the worker
 * scope, so narrow it to just the part used here: pulling in the WebWorker lib
 * instead would conflict with the DOM lib the rest of the app needs.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BuildPrintRequest>) => void) | null;
  postMessage: (message: BuildPrintResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<BuildPrintRequest>) => {
  const { samples, sampleRate, tempo, firstDownbeatSeconds } = event.data;
  try {
    const print = buildFollowPrint(analyzeBuffer(samples, sampleRate), {
      tempo,
      firstDownbeatSeconds
    });
    const response: BuildPrintResponse = { ok: true, print };
    // Hand the buffers over rather than copying them; a print for a long track
    // is several megabytes.
    scope.postMessage(response, [print.fine.buffer, print.coarse.buffer, print.selfSimilarity.buffer]);
  } catch (error) {
    const response: BuildPrintResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    scope.postMessage(response);
  }
};
