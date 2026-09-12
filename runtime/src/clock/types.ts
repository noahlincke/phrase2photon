export interface BeatClockState {
  bpm: number;
  beat: number;
  bar: number;
  phase: number;
  isPlaying: boolean;
  nowSeconds: number;
}

export interface BeatClock {
  current(): BeatClockState;
}

export class ManualBeatClock implements BeatClock {
  private state: BeatClockState;

  constructor(initial: BeatClockState) {
    this.state = initial;
  }

  current(): BeatClockState {
    return this.state;
  }

  setState(next: BeatClockState): void {
    this.state = next;
  }
}
