export interface TimelinePhrase {
  phraseId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
}

export interface TimelineSample {
  seconds: number;
  level: number;
}

export type AudioTimelineInput =
  | {
      mode: "known";
      peaks: number[];
      durationSeconds: number;
      currentSeconds: number;
      bpm: number;
      phrases: TimelinePhrase[];
      activePhraseId: string | null;
    }
  | {
      mode: "live";
      samples: TimelineSample[];
      currentSeconds: number;
      windowSeconds: number;
      bpm: number;
      phrases: TimelinePhrase[];
      activePhraseId: string | null;
    };

export class AudioTimeline {
  private readonly context: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Audio timeline canvas is unavailable.");
    }
    this.context = context;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(message = "Audio timeline waiting for input."): void {
    this.drawBackground();
    this.context.fillStyle = "rgba(203, 213, 225, 0.82)";
    this.context.font = "12px Inter, sans-serif";
    this.context.fillText(message, 14, this.height / 2 + 4);
  }

  render(input: AudioTimelineInput): void {
    this.drawBackground();
    if (input.mode === "known") {
      this.renderKnown(input);
    } else {
      this.renderLive(input);
    }
  }

  private renderKnown(input: Extract<AudioTimelineInput, { mode: "known" }>): void {
    const duration = Math.max(0.001, input.durationSeconds);
    this.drawBeatGrid(0, this.width, 0, duration, input.bpm);
    this.drawPhraseSpans(input.phrases, input.activePhraseId, 0, this.width, 0, duration);
    this.drawPeaks(input.peaks, 0, this.width, "rgba(217, 255, 0, 0.72)");
    const markerX = clamp(input.currentSeconds / duration, 0, 1) * this.width;
    this.drawMarker(markerX, `${formatTime(input.currentSeconds)} / ${formatTime(duration)}`);
  }

  private renderLive(input: Extract<AudioTimelineInput, { mode: "live" }>): void {
    const markerX = this.width * 0.5;
    const windowSeconds = Math.max(1, input.windowSeconds);
    const startSeconds = Math.max(0, input.currentSeconds - windowSeconds);
    this.context.fillStyle = "rgba(15, 23, 42, 0.68)";
    this.context.fillRect(markerX, 0, this.width - markerX, this.height);
    this.drawBeatGrid(0, markerX, startSeconds, input.currentSeconds, input.bpm);
    this.drawPhraseSpans(input.phrases, input.activePhraseId, 0, markerX, startSeconds, input.currentSeconds);
    this.drawLiveSamples(input.samples, markerX, startSeconds, input.currentSeconds);
    this.drawMarker(markerX, `live ${formatTime(input.currentSeconds)}`);
  }

  private drawBackground(): void {
    this.context.clearRect(0, 0, this.width, this.height);
    this.context.fillStyle = "rgba(5, 7, 10, 0.88)";
    this.context.fillRect(0, 0, this.width, this.height);
    this.context.strokeStyle = "rgba(148, 163, 184, 0.2)";
    this.context.strokeRect(0.5, 0.5, this.width - 1, this.height - 1);
    this.context.strokeStyle = "rgba(148, 163, 184, 0.12)";
    this.context.beginPath();
    this.context.moveTo(0, this.height / 2);
    this.context.lineTo(this.width, this.height / 2);
    this.context.stroke();
  }

  private drawPhraseSpans(
    phrases: TimelinePhrase[],
    activePhraseId: string | null,
    xStart: number,
    xEnd: number,
    startSeconds: number,
    endSeconds: number
  ): void {
    const duration = Math.max(0.001, endSeconds - startSeconds);
    phrases.forEach((phrase, index) => {
      const left = xStart + clamp((phrase.startSeconds - startSeconds) / duration, 0, 1) * (xEnd - xStart);
      const right = xStart + clamp((phrase.endSeconds - startSeconds) / duration, 0, 1) * (xEnd - xStart);
      const width = Math.max(0, right - left);
      if (width <= 0) {
        return;
      }
      const active = phrase.phraseId === activePhraseId;
      this.context.fillStyle = active ? "rgba(217, 255, 0, 0.24)" : phraseFill(index);
      this.context.fillRect(left, 0, width, this.height);
      if (active) {
        this.context.strokeStyle = "rgba(217, 255, 0, 0.85)";
        this.context.strokeRect(left + 0.5, 0.5, Math.max(1, width - 1), this.height - 1);
      }
      if (width > 56) {
        this.context.fillStyle = active ? "#f8fafc" : "rgba(226, 232, 240, 0.74)";
        this.context.font = "11px Inter, sans-serif";
        this.context.fillText(phrase.name, left + 6, 16, width - 10);
      }
    });
  }

  private drawBeatGrid(xStart: number, xEnd: number, startSeconds: number, endSeconds: number, bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) {
      return;
    }
    const secondsPerBeat = 60 / bpm;
    const duration = Math.max(0.001, endSeconds - startSeconds);
    const firstBeat = Math.ceil(startSeconds / secondsPerBeat);
    const lastBeat = Math.floor(endSeconds / secondsPerBeat);
    for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
      const seconds = beat * secondsPerBeat;
      const x = xStart + ((seconds - startSeconds) / duration) * (xEnd - xStart);
      const isBar = beat % 4 === 0;
      const isPhraseBeat = beat % 32 === 0;
      this.context.strokeStyle = isPhraseBeat
        ? "rgba(248, 250, 252, 0.34)"
        : isBar
          ? "rgba(148, 163, 184, 0.24)"
          : "rgba(148, 163, 184, 0.12)";
      this.context.lineWidth = isPhraseBeat ? 1.5 : 1;
      this.context.beginPath();
      this.context.moveTo(x, isPhraseBeat ? 0 : this.height * 0.18);
      this.context.lineTo(x, this.height);
      this.context.stroke();
    }
  }

  private drawPeaks(peaks: number[], xStart: number, xEnd: number, color: string): void {
    if (!peaks.length) {
      return;
    }
    const centerY = this.height * 0.56;
    const maxAmplitude = this.height * 0.34;
    const width = xEnd - xStart;
    this.context.strokeStyle = color;
    this.context.lineWidth = 1;
    this.context.beginPath();
    peaks.forEach((peak, index) => {
      const x = xStart + (index / Math.max(1, peaks.length - 1)) * width;
      const amplitude = clamp(peak, 0, 1) * maxAmplitude;
      this.context.moveTo(x, centerY - amplitude);
      this.context.lineTo(x, centerY + amplitude);
    });
    this.context.stroke();
  }

  private drawLiveSamples(samples: TimelineSample[], markerX: number, startSeconds: number, endSeconds: number): void {
    const visible = samples.filter((sample) => sample.seconds >= startSeconds && sample.seconds <= endSeconds);
    if (!visible.length) {
      return;
    }
    const duration = Math.max(0.001, endSeconds - startSeconds);
    const centerY = this.height * 0.56;
    const maxAmplitude = this.height * 0.34;
    this.context.strokeStyle = "rgba(125, 211, 252, 0.82)";
    this.context.lineWidth = 2;
    this.context.beginPath();
    visible.forEach((sample, index) => {
      const x = clamp((sample.seconds - startSeconds) / duration, 0, 1) * markerX;
      const y = centerY - clamp(sample.level, 0, 1) * maxAmplitude;
      if (index === 0) {
        this.context.moveTo(x, y);
      } else {
        this.context.lineTo(x, y);
      }
    });
    this.context.stroke();
  }

  private drawMarker(x: number, label: string): void {
    this.context.strokeStyle = "#f8fafc";
    this.context.lineWidth = 2;
    this.context.beginPath();
    this.context.moveTo(x, 0);
    this.context.lineTo(x, this.height);
    this.context.stroke();
    this.context.fillStyle = "#f8fafc";
    this.context.font = "11px Inter, sans-serif";
    this.context.fillText(label, Math.min(this.width - 96, x + 7), this.height - 9);
  }
}

export async function loadWaveformPeaks(url: string, bucketCount = 1400): Promise<number[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Audio waveform fetch failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  try {
    const audio = await context.decodeAudioData(buffer.slice(0));
    return buildPeaks(audio, bucketCount);
  } finally {
    await context.close();
  }
}

function buildPeaks(audio: AudioBuffer, bucketCount: number): number[] {
  const length = audio.length;
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  const bucketSize = Math.max(1, Math.floor(length / bucketCount));
  return Array.from({ length: bucketCount }, (_, bucket) => {
    const start = bucket * bucketSize;
    const end = Math.min(length, start + bucketSize);
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      let sample = 0;
      channels.forEach((channel) => {
        sample += Math.abs(channel[index] ?? 0);
      });
      peak = Math.max(peak, sample / Math.max(1, channels.length));
    }
    return peak;
  });
}

function phraseFill(index: number): string {
  const colors = [
    "rgba(14, 165, 233, 0.14)",
    "rgba(168, 85, 247, 0.14)",
    "rgba(245, 158, 11, 0.14)",
    "rgba(34, 197, 94, 0.14)"
  ];
  return colors[index % colors.length];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
