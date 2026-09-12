/**
 * Onset detection function conditioning.
 *
 * Raw spectral flux has a strong programme-level trend (a loud drop produces
 * bigger flux than a quiet intro), which biases every periodicity estimate
 * toward the loudest part of a track. Local normalisation removes that trend so
 * a steady intro contributes to the tempo estimate as much as the drop does.
 */

export interface OnsetEnvelope {
  frameRate: number;
  /**
   * Time of frame 0, in seconds.
   *
   * Analysis frames are centred, so frame 0 sits half a window into the
   * signal. Anything that converts a frame index back to a timestamp has to
   * add this, or every reported beat lands half a window early.
   */
  firstFrameSeconds: number;
  /** Locally normalised, half-wave rectified onset strength per frame. */
  values: Float32Array;
}

export function normalizeOnsetEnvelope(
  raw: Float32Array,
  frameRate: number,
  firstFrameSeconds: number,
  windowSeconds = 1.5
): OnsetEnvelope {
  const count = raw.length;
  const values = new Float32Array(count);
  if (!count) {
    return { frameRate, firstFrameSeconds, values };
  }

  const half = Math.max(1, Math.round((windowSeconds * frameRate) / 2));
  const prefix = new Float64Array(count + 1);
  const prefixSquares = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    prefix[index + 1] = prefix[index] + raw[index];
    prefixSquares[index + 1] = prefixSquares[index] + raw[index] * raw[index];
  }

  for (let index = 0; index < count; index += 1) {
    const start = Math.max(0, index - half);
    const end = Math.min(count, index + half + 1);
    const span = end - start;
    const mean = (prefix[end] - prefix[start]) / span;
    const meanSquares = (prefixSquares[end] - prefixSquares[start]) / span;
    const variance = Math.max(0, meanSquares - mean * mean);
    const deviation = Math.sqrt(variance);
    const centered = raw[index] - mean;
    values[index] = deviation > 1e-9 ? Math.max(0, centered / deviation) : 0;
  }

  return { frameRate, firstFrameSeconds, values };
}

/**
 * Weighted blend of broadband and kick-band onset strength.
 *
 * Four-to-the-floor kicks dominate the low band on every beat, which is the
 * single most reliable beat cue in house and techno; the broadband term keeps
 * the envelope usable on breakdowns where the kick drops out.
 */
export function blendOnsetEnvelopes(
  broadband: OnsetEnvelope,
  kick: OnsetEnvelope,
  kickWeight = 0.55
): OnsetEnvelope {
  const count = Math.min(broadband.values.length, kick.values.length);
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = broadband.values[index] * (1 - kickWeight) + kick.values[index] * kickWeight;
  }
  return {
    frameRate: broadband.frameRate,
    firstFrameSeconds: broadband.firstFrameSeconds,
    values
  };
}

/** Linear interpolation of an envelope at a fractional frame index. */
export function sampleAt(values: Float32Array, index: number): number {
  if (index <= 0) {
    return values[0] ?? 0;
  }
  const last = values.length - 1;
  if (index >= last) {
    return values[last] ?? 0;
  }
  const lower = Math.floor(index);
  const fraction = index - lower;
  return values[lower] * (1 - fraction) + values[lower + 1] * fraction;
}
