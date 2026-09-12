export class AudioAnalyser {
  private context: AudioContext | null = null;
  private source: AudioNode | null = null;
  private mediaElementSource: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;

  connect(audio: HTMLAudioElement): void {
    this.ensureContext();
    if (!this.context || !this.analyser) {
      return;
    }

    this.mediaElementSource ??= this.context.createMediaElementSource(audio);
    this.replaceSource(this.mediaElementSource, true);
  }

  connectStream(stream: MediaStream): void {
    this.ensureContext();
    if (!this.context || !this.analyser) {
      return;
    }

    this.replaceSource(this.context.createMediaStreamSource(stream), false);
  }

  disconnect(): void {
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
  }

  private ensureContext(): void {
    if (this.context) {
      return;
    }
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
  }

  private replaceSource(source: AudioNode, audible: boolean): void {
    if (!this.analyser || !this.context) {
      return;
    }
    this.disconnect();
    this.source = source;
    this.source.connect(this.analyser);
    if (audible) {
      this.analyser.connect(this.context.destination);
    } else {
      this.analyser.disconnect();
    }
  }

  async resume(): Promise<void> {
    if (this.context?.state === "suspended") {
      await this.context.resume();
    }
  }

  snapshot(): { low: number; mid: number; high: number } {
    if (!this.analyser || !this.data) {
      return { low: 0, mid: 0, high: 0 };
    }

    this.analyser.getByteFrequencyData(this.data);
    return {
      low: average(this.data, 2, 18),
      mid: average(this.data, 18, 96),
      high: average(this.data, 96, 220)
    };
  }
}

function average(data: ArrayLike<number>, start: number, end: number): number {
  const boundedEnd = Math.min(end, data.length);
  let total = 0;
  let count = 0;
  for (let index = start; index < boundedEnd; index += 1) {
    total += data[index];
    count += 1;
  }
  return count ? total / count / 255 : 0;
}
