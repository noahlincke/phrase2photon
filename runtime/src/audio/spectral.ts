import { Fft, hannWindow } from "./fft.js";

/**
 * Streaming spectral front end shared by the live microphone path and the
 * offline Mixed In Key validation harness.
 *
 * Everything downstream (tempo, beats, structure) consumes the columnar
 * `SpectralFeatures` this produces, so the live and offline detectors are
 * literally the same algorithm over the same features.
 */

export const FRAME_SIZE = 2048;
export const HOP_SIZE = 512;
export const BAND_COUNT = 24;

const LOG_COMPRESSION_GAMMA = 1000;
const BAND_LOW_HZ = 30;
const BAND_HIGH_HZ = 16000;

/** Band index ranges used for the band-limited onset functions. */
export interface BandSplit {
  kickStart: number;
  kickEnd: number;
  lowEnd: number;
  midEnd: number;
  highEnd: number;
}

export interface SpectralFeatures {
  sampleRate: number;
  hopSize: number;
  frameRate: number;
  frameCount: number;
  /** Centre time of each frame, in seconds. */
  times: Float64Array;
  /** Broadband positive spectral flux (SuperFlux style). */
  flux: Float32Array;
  /** Kick-range flux, 30-140 Hz. */
  lowFlux: Float32Array;
  /**
   * Narrow kick-drum flux, 35-110 Hz.
   *
   * Deliberately excludes the bassline, which in house and garage often plays
   * offbeat and would otherwise argue for the wrong beat phase.
   */
  kickFlux: Float32Array;
  /** Body/mid flux, 140-2000 Hz. */
  midFlux: Float32Array;
  /** Air/percussion flux, 2000-11000 Hz. */
  highFlux: Float32Array;
  rms: Float32Array;
  /** `frameCount * BAND_COUNT` log-compressed band energies, row-major. */
  bands: Float32Array;
}

export function bandEdgeFrequencies(): Float32Array {
  const edges = new Float32Array(BAND_COUNT + 1);
  const logLow = Math.log(BAND_LOW_HZ);
  const logHigh = Math.log(BAND_HIGH_HZ);
  for (let index = 0; index <= BAND_COUNT; index += 1) {
    edges[index] = Math.exp(logLow + ((logHigh - logLow) * index) / BAND_COUNT);
  }
  return edges;
}

export class SpectralAnalyzer {
  readonly sampleRate: number;
  readonly frameRate: number;

  private readonly fft = new Fft(FRAME_SIZE);
  private readonly window = hannWindow(FRAME_SIZE);
  private readonly ring = new Float32Array(FRAME_SIZE);
  private readonly windowed = new Float32Array(FRAME_SIZE);
  private readonly real = new Float32Array(FRAME_SIZE);
  private readonly imag = new Float32Array(FRAME_SIZE);
  private readonly magnitude = new Float32Array(FRAME_SIZE / 2 + 1);
  private readonly logSpectrum = new Float32Array(FRAME_SIZE / 2 + 1);
  private readonly previousLogSpectrum = new Float32Array(FRAME_SIZE / 2 + 1);
  private readonly previousMaxFiltered = new Float32Array(FRAME_SIZE / 2 + 1);
  private readonly bandBinStart = new Int32Array(BAND_COUNT);
  private readonly bandBinEnd = new Int32Array(BAND_COUNT);
  private readonly bandScratch = new Float32Array(BAND_COUNT);
  private readonly split: BandSplit;
  private readonly magnitudeScale: number;

  private ringWrite = 0;
  private samplesUntilFrame = FRAME_SIZE;
  private samplesConsumed = 0;
  private hasPreviousFrame = false;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.frameRate = sampleRate / HOP_SIZE;
    this.magnitudeScale = 4 / FRAME_SIZE;

    const edges = bandEdgeFrequencies();
    const binsPerHz = FRAME_SIZE / sampleRate;
    const maxBin = FRAME_SIZE / 2;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const start = Math.min(maxBin, Math.max(1, Math.floor(edges[band] * binsPerHz)));
      const end = Math.min(maxBin, Math.max(start + 1, Math.ceil(edges[band + 1] * binsPerHz)));
      this.bandBinStart[band] = start;
      this.bandBinEnd[band] = end;
    }
    this.split = {
      kickStart: this.binForFrequency(35),
      kickEnd: this.binForFrequency(110),
      lowEnd: this.binForFrequency(140),
      midEnd: this.binForFrequency(2000),
      highEnd: this.binForFrequency(11000)
    };
  }

  private binForFrequency(hz: number): number {
    return Math.min(FRAME_SIZE / 2, Math.max(1, Math.round((hz * FRAME_SIZE) / this.sampleRate)));
  }

  /**
   * Pushes mono samples and invokes `onFrame` once per completed hop.
   *
   * `bands` passed to the callback is reused between calls; copy it if you
   * need to retain it.
   */
  push(
    samples: Float32Array,
    onFrame: (frame: {
      timeSeconds: number;
      flux: number;
      lowFlux: number;
      kickFlux: number;
      midFlux: number;
      highFlux: number;
      rms: number;
      bands: Float32Array;
    }) => void
  ): void {
    for (let index = 0; index < samples.length; index += 1) {
      this.ring[this.ringWrite] = samples[index];
      this.ringWrite = (this.ringWrite + 1) % FRAME_SIZE;
      this.samplesConsumed += 1;
      this.samplesUntilFrame -= 1;
      if (this.samplesUntilFrame > 0) {
        continue;
      }
      this.samplesUntilFrame = HOP_SIZE;
      onFrame(this.computeFrame());
    }
  }

  private computeFrame(): {
    timeSeconds: number;
    flux: number;
    lowFlux: number;
    kickFlux: number;
    midFlux: number;
    highFlux: number;
    rms: number;
    bands: Float32Array;
  } {
    // Unwrap the ring buffer into frame order, oldest sample first.
    let sumSquares = 0;
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const sample = this.ring[(this.ringWrite + index) % FRAME_SIZE];
      sumSquares += sample * sample;
      this.windowed[index] = sample * this.window[index];
    }

    this.fft.magnitudes(this.windowed, this.real, this.imag, this.magnitude);

    const bins = FRAME_SIZE / 2;
    for (let bin = 0; bin <= bins; bin += 1) {
      this.logSpectrum[bin] = Math.log1p(LOG_COMPRESSION_GAMMA * this.magnitude[bin] * this.magnitudeScale);
    }

    let flux = 0;
    let lowFlux = 0;
    let kickFlux = 0;
    let midFlux = 0;
    let highFlux = 0;
    if (this.hasPreviousFrame) {
      for (let bin = 1; bin <= this.split.highEnd; bin += 1) {
        // SuperFlux: compare against a 3-bin maximum of the previous frame so
        // vibrato and pitch drift do not read as onsets.
        const reference = this.previousMaxFiltered[bin];
        const rise = this.logSpectrum[bin] - reference;
        if (rise <= 0) {
          continue;
        }
        flux += rise;
        if (bin >= this.split.kickStart && bin <= this.split.kickEnd) {
          kickFlux += rise;
        }
        if (bin <= this.split.lowEnd) {
          lowFlux += rise;
        } else if (bin <= this.split.midEnd) {
          midFlux += rise;
        } else {
          highFlux += rise;
        }
      }
    }

    for (let band = 0; band < BAND_COUNT; band += 1) {
      let total = 0;
      const end = this.bandBinEnd[band];
      for (let bin = this.bandBinStart[band]; bin < end; bin += 1) {
        total += this.magnitude[bin] * this.magnitudeScale;
      }
      this.bandScratch[band] = Math.log1p(LOG_COMPRESSION_GAMMA * total);
    }

    this.previousLogSpectrum.set(this.logSpectrum);
    for (let bin = 0; bin <= bins; bin += 1) {
      const lower = bin > 0 ? this.previousLogSpectrum[bin - 1] : this.previousLogSpectrum[bin];
      const upper = bin < bins ? this.previousLogSpectrum[bin + 1] : this.previousLogSpectrum[bin];
      this.previousMaxFiltered[bin] = Math.max(this.previousLogSpectrum[bin], lower, upper);
    }
    this.hasPreviousFrame = true;

    return {
      // The frame covers the last FRAME_SIZE samples; report its centre.
      timeSeconds: (this.samplesConsumed - FRAME_SIZE / 2) / this.sampleRate,
      flux,
      lowFlux,
      kickFlux,
      midFlux,
      highFlux,
      rms: Math.sqrt(sumSquares / FRAME_SIZE),
      bands: this.bandScratch
    };
  }
}

/** Runs the analyzer over a complete buffer and returns columnar features. */
export function analyzeBuffer(samples: Float32Array, sampleRate: number): SpectralFeatures {
  const analyzer = new SpectralAnalyzer(sampleRate);
  const estimatedFrames = Math.max(1, Math.ceil(samples.length / HOP_SIZE) + 1);
  const times = new Float64Array(estimatedFrames);
  const flux = new Float32Array(estimatedFrames);
  const lowFlux = new Float32Array(estimatedFrames);
  const kickFlux = new Float32Array(estimatedFrames);
  const midFlux = new Float32Array(estimatedFrames);
  const highFlux = new Float32Array(estimatedFrames);
  const rms = new Float32Array(estimatedFrames);
  const bands = new Float32Array(estimatedFrames * BAND_COUNT);

  let frameCount = 0;
  analyzer.push(samples, (frame) => {
    if (frameCount >= estimatedFrames) {
      return;
    }
    times[frameCount] = frame.timeSeconds;
    flux[frameCount] = frame.flux;
    lowFlux[frameCount] = frame.lowFlux;
    kickFlux[frameCount] = frame.kickFlux;
    midFlux[frameCount] = frame.midFlux;
    highFlux[frameCount] = frame.highFlux;
    rms[frameCount] = frame.rms;
    bands.set(frame.bands, frameCount * BAND_COUNT);
    frameCount += 1;
  });

  return {
    sampleRate,
    hopSize: HOP_SIZE,
    frameRate: analyzer.frameRate,
    frameCount,
    times: times.subarray(0, frameCount),
    flux: flux.subarray(0, frameCount),
    lowFlux: lowFlux.subarray(0, frameCount),
    kickFlux: kickFlux.subarray(0, frameCount),
    midFlux: midFlux.subarray(0, frameCount),
    highFlux: highFlux.subarray(0, frameCount),
    rms: rms.subarray(0, frameCount),
    bands: bands.subarray(0, frameCount * BAND_COUNT)
  };
}
