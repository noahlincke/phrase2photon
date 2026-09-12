export interface RekordboxSliderSample {
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RekordboxMixerSnapshot {
  lineFaders: number[];
  highestLineFader: number | null;
  observedAt: string | null;
}

const MIN_VERTICAL_SLIDER_HEIGHT = 60;
const MIN_VERTICAL_ASPECT_RATIO = 2;
const ZERO_EPSILON = 0.001;

export function summarizeRekordboxMixer(
  sliders: RekordboxSliderSample[],
  observedAt: string | null
): RekordboxMixerSnapshot {
  const lineFaders = sliders
    .filter(isLikelyLineFader)
    .sort((left, right) => left.x - right.x)
    .map((slider) => sanitizeSliderValue(slider.value));

  return {
    lineFaders,
    highestLineFader: lineFaders.length ? Math.max(...lineFaders) : null,
    observedAt
  };
}

function isLikelyLineFader(slider: RekordboxSliderSample): boolean {
  return slider.height >= MIN_VERTICAL_SLIDER_HEIGHT
    && slider.height >= slider.width * MIN_VERTICAL_ASPECT_RATIO;
}

function sanitizeSliderValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.abs(value) <= ZERO_EPSILON ? 0 : value;
}
