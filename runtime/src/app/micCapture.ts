import { buildMicAudioConstraints } from "./micInputDevices.js";

/**
 * Microphone capture.
 *
 * The worklet only forwards samples; the STFT runs on the main thread using
 * the same `SpectralAnalyzer` the offline analyser uses. Duplicating the front
 * end into the worklet would have meant two implementations to keep in step,
 * for a saving of well under a millisecond per second of audio.
 *
 * An AudioWorklet is used rather than polling an AnalyserNode because polling
 * on requestAnimationFrame drops samples between frames and jitters with the
 * display, neither of which a beat tracker can tolerate.
 */

const PROCESSOR_NAME = "phrase2photon-capture";

/**
 * Worklet source, loaded from a blob URL.
 *
 * Inlining it avoids a bundler-specific asset pipeline for what is fifteen
 * lines of code, and keeps dev and production behaviour identical.
 */
const PROCESSOR_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) {
      return true;
    }
    const channels = input.length;
    const frames = input[0].length;
    const mono = new Float32Array(frames);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = input[channel];
      for (let frame = 0; frame < frames; frame += 1) {
        mono[frame] += data[frame];
      }
    }
    if (channels > 1) {
      for (let frame = 0; frame < frames; frame += 1) {
        mono[frame] /= channels;
      }
    }
    // currentTime is the audio-clock time of the start of this quantum.
    this.port.postMessage({ samples: mono, time: currentTime }, [mono.buffer]);
    return true;
  }
}
registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, CaptureProcessor);
`;

export interface MicCaptureBlock {
  samples: Float32Array;
  /** Audio-clock time of the first sample. */
  time: number;
}

export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private moduleUrl: string | null = null;
  private activeDeviceId: string | null = null;

  onBlock: ((block: MicCaptureBlock) => void) | null = null;

  get running(): boolean {
    return this.node !== null;
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get selectedDeviceId(): string | null {
    return this.activeDeviceId;
  }

  /** Current audio-clock time, the clock every musical position is stated in. */
  now(): number {
    return this.context?.currentTime ?? 0;
  }

  async start(deviceId: string | null): Promise<void> {
    if (this.node) {
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: buildMicAudioConstraints(deviceId)
    });
    this.activeDeviceId = deviceId?.trim() || null;

    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    if (context.state === "suspended") {
      await context.resume();
    }

    this.moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }));
    await context.audioWorklet.addModule(this.moduleUrl);

    this.source = context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0
    });
    this.node.port.onmessage = (event: MessageEvent<MicCaptureBlock>) => {
      this.onBlock?.(event.data);
    };
    this.source.connect(this.node);
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.moduleUrl) {
      URL.revokeObjectURL(this.moduleUrl);
      this.moduleUrl = null;
    }
    void this.context?.close();
    this.context = null;
    this.activeDeviceId = null;
  }
}
