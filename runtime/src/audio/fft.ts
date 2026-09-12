/**
 * Minimal in-place iterative radix-2 FFT.
 *
 * The analysis pipeline runs identically in the browser (AudioWorklet) and in
 * Node (offline validation against Mixed In Key), so this deliberately has no
 * platform dependencies.
 */

export class Fft {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, received ${size}.`);
    }
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let index = 0; index < size / 2; index += 1) {
      this.cos[index] = Math.cos((-2 * Math.PI * index) / size);
      this.sin[index] = Math.sin((-2 * Math.PI * index) / size);
    }

    const bits = Math.log2(size);
    this.reverse = new Uint32Array(size);
    for (let index = 0; index < size; index += 1) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed |= ((index >> bit) & 1) << (bits - 1 - bit);
      }
      this.reverse[index] = reversed;
    }
  }

  /** Transforms `real`/`imag` in place. */
  transform(real: Float32Array, imag: Float32Array): void {
    const size = this.size;
    for (let index = 0; index < size; index += 1) {
      const target = this.reverse[index];
      if (target > index) {
        let swap = real[index];
        real[index] = real[target];
        real[target] = swap;
        swap = imag[index];
        imag[index] = imag[target];
        imag[target] = swap;
      }
    }

    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * step;
          const cos = this.cos[twiddle];
          const sin = this.sin[twiddle];
          const lower = start + offset;
          const upper = lower + half;
          const realUpper = real[upper] * cos - imag[upper] * sin;
          const imagUpper = real[upper] * sin + imag[upper] * cos;
          real[upper] = real[lower] - realUpper;
          imag[upper] = imag[lower] - imagUpper;
          real[lower] += realUpper;
          imag[lower] += imagUpper;
        }
      }
    }
  }

  /**
   * Magnitude spectrum of a real signal.
   *
   * `input` must be `size` samples; `output` receives `size / 2 + 1` bins.
   */
  magnitudes(input: Float32Array, real: Float32Array, imag: Float32Array, output: Float32Array): void {
    real.set(input);
    imag.fill(0);
    this.transform(real, imag);
    const bins = this.size / 2;
    for (let bin = 0; bin <= bins; bin += 1) {
      output[bin] = Math.hypot(real[bin], imag[bin]);
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  }
  return window;
}
