/**
 * GLSL shared by every scene.
 *
 * Scenes differ in geometry only. Line rendering, colour grading, the beat
 * easing curves and the vignette all live here, which is what makes six
 * different scenes read as one system rather than six unrelated screensavers.
 */
export const COMMON_GLSL = /* glsl */ `
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
/** Continuous beat position; the fractional part is the position in the beat. */
uniform float uBeat;
uniform float uBeatPhase;
uniform float uBarPhase;
uniform float uPhrasePhase;
uniform float uBarInPhrase;
/** 0-1 musical energy, already smoothed. */
uniform float uEnergy;
/** Smoothed band levels: x low, y mid, z high. */
uniform vec3  uBands;
uniform vec3  uInk;
uniform vec3  uAccent;
uniform vec3  uBackground;
/** Master opacity, used for scene transitions. */
uniform float uIntensity;
/** Stable per-scene randomisation so repeats do not look identical. */
uniform float uSeed;

varying vec2 vUv;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float hash11(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    total += amplitude * valueNoise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return total;
}

/**
 * Anti-aliased line coverage from a signed distance.
 *
 * Width is in pixels and converted through the screen-space derivative, so
 * line weight stays constant whatever the resolution or projector scaling.
 */
float lineMask(float signedDistance, float widthPixels) {
  float aa = fwidth(signedDistance);
  float halfWidth = widthPixels * 0.5 * aa;
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(signedDistance));
}

/** Soft falloff around a line, used sparingly to suggest bloom. */
float lineGlow(float signedDistance, float radius) {
  return exp(-abs(signedDistance) / max(radius, 1e-4));
}

/** Distance to the nearest line of a unit-spaced grid, in grid units. */
float gridDistance(float coordinate) {
  return abs(fract(coordinate) - 0.5) - 0.5;
}

/** Percussive decay: 1 at the hit, falling to 0 across the interval. */
float hit(float phase, float sharpness) {
  return pow(clamp(1.0 - phase, 0.0, 1.0), sharpness);
}

/** Symmetric swell that peaks mid-interval. */
float swell(float phase) {
  return sin(clamp(phase, 0.0, 1.0) * PI);
}

/** Smooth 0-1 ramp with eased ends. */
float ease(float t) {
  t = clamp(t, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/**
 * Final grade shared by every scene: exposure, a gentle filmic roll-off,
 * vignette, and enough grain to stop large flat areas banding on a projector.
 */
vec3 grade(vec3 colour, vec2 uv) {
  float vignette = 1.0 - 0.55 * pow(length((uv - 0.5) * vec2(1.15, 1.0)), 2.4);
  colour *= max(vignette, 0.0);
  colour = colour / (1.0 + colour);
  colour = pow(colour, vec3(0.9));
  float grain = (hash21(uv * uResolution + fract(uTime) * 431.0) - 0.5) * 0.018;
  return max(colour + grain, 0.0);
}

/** Screen coordinates centred on 0 with a uniform vertical scale. */
vec2 centeredUv(vec2 uv) {
  vec2 p = uv - 0.5;
  p.x *= uResolution.x / uResolution.y;
  return p * 2.0;
}
`;

/** Vertex shader shared by every scene: a full-screen triangle pair. */
export const FULLSCREEN_VERTEX_GLSL = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
