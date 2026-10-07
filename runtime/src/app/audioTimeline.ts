import type { EnergyLevel } from "../show/types.js";

export type PhraseKind = "intro" | "build" | "drop" | "breakdown" | "groove" | "outro";

export interface TimelinePhrase {
  phraseId: string;
  name: string;
  kind: PhraseKind;
  startSeconds: number;
  endSeconds: number;
}

export interface AudioTimelineInput {
  peaks: number[];
  durationSeconds: number;
  currentSeconds: number;
  phrases: TimelinePhrase[];
  activePhraseId: string | null;
}

export const DEFAULT_TIMELINE_EMPTY_MESSAGE = "Waiting for audio";

/**
 * One colour per musical phrase kind, keyed off the accent palette: drops get
 * the app accent, quiet sections get cool colours, transitions get warm ones.
 */
const PHRASE_COLORS: Record<PhraseKind, string> = {
  intro: "125, 211, 252",
  build: "251, 191, 36",
  drop: "217, 255, 0",
  breakdown: "167, 139, 250",
  groove: "52, 211, 153",
  outro: "148, 163, 184"
};

const KIND_LABELS: Record<PhraseKind, string> = {
  intro: "Intro",
  build: "Build",
  drop: "Drop",
  breakdown: "Breakdown",
  groove: "Groove",
  outro: "Outro"
};

/**
 * Infers the musical kind of a phrase from its arrangement name, falling back
 * to energy. Mirrors roleForPhrase in visualPresets.ts but keeps the full
 * six-kind vocabulary the timeline colours need.
 */
export function inferPhraseKind(name: string, energyLevel: EnergyLevel): PhraseKind {
  const lowered = name.toLowerCase();
  if (lowered.includes("intro")) {
    return "intro";
  }
  if (lowered.includes("outro")) {
    return "outro";
  }
  if (lowered.includes("break") || lowered.includes("strip")) {
    return "breakdown";
  }
  if (lowered.includes("build") || lowered.includes("lift") || lowered.includes("riser")) {
    return "build";
  }
  if (lowered.includes("drop")) {
    return "drop";
  }
  return energyLevel === "peak" ? "drop" : energyLevel === "low" ? "breakdown" : "groove";
}

/**
 * The label shown on a phrase band. Compiled shows carry arrangement names
 * like "Bass In" but also bare bar numbers like "24", which say nothing; a
 * numbered or blank phrase gets its kind name instead.
 */
export function timelineLabelText(phrase: Pick<TimelinePhrase, "name" | "kind">): string {
  const name = phrase.name.trim();
  return /\p{L}/u.test(name) ? name : KIND_LABELS[phrase.kind];
}

/**
 * Shortens a label to fit a band without ever stretching or squeezing text.
 * Returns null when even one character does not fit.
 */
export function fitTimelineLabel(
  text: string,
  maxWidth: number,
  measure: (text: string) => number
): string | null {
  if (measure(text) <= maxWidth) {
    return text;
  }
  let candidate = text;
  while (candidate.length > 1) {
    candidate = candidate.slice(0, -1);
    if (measure(candidate) <= maxWidth) {
      return candidate;
    }
  }
  return null;
}

interface TimelineBand {
  phrase: TimelinePhrase;
  left: number;
  width: number;
  active: boolean;
}

/**
 * The transport timeline strip.
 *
 * A single DPR-aware canvas: phrase bands with small labels, a slim mirrored
 * waveform envelope, and a thin playhead. The empty state is a plain DOM line
 * over the strip, so no text is ever painted stretched across the canvas.
 */
export class AudioTimeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly emptyLine: HTMLElement;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 0;
  private envelope: { peaks: number[]; width: number; height: number; path: Path2D } | null = null;

  constructor(canvas: HTMLCanvasElement, emptyLine: HTMLElement) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Audio timeline canvas is unavailable.");
    }
    this.canvas = canvas;
    this.context = context;
    this.emptyLine = emptyLine;
    this.clear();
  }

  /**
   * Re-measures on every render: the strip starts life hidden behind the mic
   * mode and mode switches never fire a resize event, so the backing store
   * has to follow the laid-out box instead of trusting stale sizes.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.cssWidth && height === this.cssHeight && dpr === this.dpr) {
      return;
    }
    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.envelope = null;
  }

  clear(message: string = DEFAULT_TIMELINE_EMPTY_MESSAGE): void {
    this.resize();
    this.context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.envelope = null;
    this.emptyLine.textContent = message;
    this.emptyLine.hidden = false;
  }

  render(input: AudioTimelineInput): void {
    this.resize();
    this.emptyLine.hidden = true;
    this.context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const bands = this.layoutBands(input);
    this.drawPhraseBands(bands);
    this.drawWaveform(input);
    this.drawPhraseLabels(bands);
    this.drawPlayhead(input);
  }

  private layoutBands(input: AudioTimelineInput): TimelineBand[] {
    const duration = Math.max(0.001, input.durationSeconds);
    const bands: TimelineBand[] = [];
    for (const phrase of input.phrases) {
      const left = clamp(phrase.startSeconds / duration, 0, 1) * this.cssWidth;
      const right = clamp(phrase.endSeconds / duration, 0, 1) * this.cssWidth;
      if (right - left < 0.5) {
        continue;
      }
      bands.push({
        phrase,
        left,
        width: right - left,
        active: phrase.phraseId === input.activePhraseId
      });
    }
    return bands;
  }

  private drawPhraseBands(bands: TimelineBand[]): void {
    const height = this.cssHeight;
    for (const band of bands) {
      const rgb = PHRASE_COLORS[band.phrase.kind];
      this.context.fillStyle = `rgba(${rgb}, ${band.active ? 0.2 : 0.09})`;
      this.context.fillRect(band.left, 0, band.width, height);
    }
    // Quiet seams so adjacent phrases read as separate spans.
    this.context.fillStyle = "rgba(5, 8, 12, 0.6)";
    for (let index = 1; index < bands.length; index += 1) {
      this.context.fillRect(Math.round(bands[index].left) - 0.5, 0, 1, height);
    }
  }

  private envelopePath(input: AudioTimelineInput): Path2D {
    const cached = this.envelope;
    if (cached && cached.peaks === input.peaks && cached.width === this.cssWidth && cached.height === this.cssHeight) {
      return cached.path;
    }
    const width = this.cssWidth;
    const centerY = this.cssHeight * 0.62;
    const maxAmplitude = this.cssHeight * 0.3;
    const count = input.peaks.length;
    const path = new Path2D();
    for (let index = 0; index < count; index += 1) {
      const x = (index / Math.max(1, count - 1)) * width;
      const y = centerY - clamp(input.peaks[index], 0, 1) * maxAmplitude;
      if (index === 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    for (let index = count - 1; index >= 0; index -= 1) {
      const x = (index / Math.max(1, count - 1)) * width;
      path.lineTo(x, centerY + clamp(input.peaks[index], 0, 1) * maxAmplitude);
    }
    path.closePath();
    this.envelope = { peaks: input.peaks, width, height: this.cssHeight, path };
    return path;
  }

  private drawWaveform(input: AudioTimelineInput): void {
    if (!input.peaks.length) {
      return;
    }
    const path = this.envelopePath(input);
    const playheadX = clamp(input.currentSeconds / Math.max(0.001, input.durationSeconds), 0, 1) * this.cssWidth;
    // What has played dims back; what is coming stays bright.
    this.context.fillStyle = "rgba(226, 232, 240, 0.26)";
    this.context.save();
    this.context.beginPath();
    this.context.rect(0, 0, playheadX, this.cssHeight);
    this.context.clip();
    this.context.fill(path);
    this.context.restore();
    this.context.fillStyle = "rgba(226, 232, 240, 0.52)";
    this.context.save();
    this.context.beginPath();
    this.context.rect(playheadX, 0, this.cssWidth - playheadX, this.cssHeight);
    this.context.clip();
    this.context.fill(path);
    this.context.restore();
  }

  private drawPhraseLabels(bands: TimelineBand[]): void {
    const context = this.context;
    context.font = "600 10px Inter, ui-sans-serif, system-ui, sans-serif";
    context.textBaseline = "middle";
    const chipHeight = 15;
    const chipTop = 5;
    const margin = 5;
    for (const band of bands) {
      const available = band.width - margin * 2;
      if (available <= 0) {
        continue;
      }
      const text = timelineLabelText(band.phrase).toUpperCase();
      const label = fitTimelineLabel(text, available, (candidate) => context.measureText(candidate).width);
      if (!label) {
        continue;
      }
      const chipWidth = Math.min(available, context.measureText(label).width + 10);
      const rgb = PHRASE_COLORS[band.phrase.kind];
      context.fillStyle = `rgba(${rgb}, ${band.active ? 0.32 : 0.16})`;
      context.beginPath();
      context.roundRect(band.left + margin, chipTop, chipWidth, chipHeight, 4);
      context.fill();
      context.fillStyle = `rgba(${rgb}, ${band.active ? 0.95 : 0.72})`;
      context.fillText(label, band.left + margin + 5, chipTop + chipHeight / 2 + 0.5);
    }
  }

  private drawPlayhead(input: AudioTimelineInput): void {
    const x = Math.round(clamp(input.currentSeconds / Math.max(0.001, input.durationSeconds), 0, 1) * this.cssWidth);
    this.context.fillStyle = "rgba(248, 250, 252, 0.9)";
    this.context.fillRect(x - 0.5, 0, 1, this.cssHeight);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
