/**
 * Scene fragment shaders.
 *
 * Six scenes spanning the energy range, all built from the same vocabulary:
 * thin bright lines on near-black, motion quantised to the beat, and symmetry
 * or perspective as the only structural devices. Nothing floats free of the
 * grid, which is what the previous renderer's stray background shapes did.
 */

export const HORIZON_GLSL = /* glsl */ `
/**
 * Receding ground plane.
 *
 * The lateral lines advance exactly one cell per beat, so the floor reads as
 * moving *with* the track rather than merely fast. Depth does the work that a
 * separate background layer used to do badly.
 */
void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  float horizon = 0.1;
  float below = horizon - p.y;

  if (below > 0.002) {
    // Perspective projection of a unit grid on the ground plane.
    float depth = 0.5 / below;
    float lateral = p.x * depth;

    // Depth fade, and a near fade so the bottom edge does not turn to mush.
    float fade = smoothstep(0.0, 0.12, below) * smoothstep(10.0, 1.0, depth);

    // Lateral lines, advancing one cell per beat.
    float rowMask = lineMask(gridDistance(depth - uBeat), 1.7);
    colour += uInk * rowMask * fade * (1.0 + uBands.x * 1.2);

    // Rails running to the vanishing point, spaced in world units.
    float columns = 3.0 + floor(uEnergy * 5.0);
    float railMask = lineMask(gridDistance(lateral * 0.5), 1.5);
    colour += uInk * railMask * fade * 0.7 * step(abs(lateral), columns);

    // Verticals rise from the floor on the downbeat, and only below the
    // horizon: light standing in the sky reads as a mistake.
    float barHit = hit(uBarPhase, 2.5) * uEnergy;
    float post = lineMask(gridDistance(lateral * 0.5 + 0.5), 2.4);
    colour += uAccent * post * fade * barHit * smoothstep(6.0, 1.5, depth) * 1.4;
  }

  // The horizon itself: one decisive line, brightened on the downbeat.
  colour += uAccent * lineMask(p.y - horizon, 2.0) * (0.9 + hit(uBarPhase, 6.0) * 1.6);
  // A shallow glow above it suggests atmosphere without adding geometry.
  colour += uAccent * lineGlow(p.y - horizon, 0.05) * 0.1 * (0.4 + uBands.z);

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;

export const RADIAL_GLSL = /* glsl */ `
/**
 * Radial bloom.
 *
 * Symmetry order steps with energy and only changes on a phrase boundary, so
 * the figure holds still long enough to be read. Rings are emitted one per
 * beat and expand outward, which gives the eye a metronome without a flash.
 */
void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  float radius = length(p);
  float angle = atan(p.y, p.x);

  // Quantised symmetry: 5 at rest up to 12 at peak.
  float folds = floor(5.0 + floor(uEnergy * 7.99));
  float folded = abs(mod(angle + PI / folds, TAU / folds) - PI / folds);

  // Spokes.
  float spoke = folded * radius;
  float spokeMask = lineMask(spoke, 1.6) * smoothstep(1.4, 0.08, radius);
  colour += uInk * spokeMask * (0.8 + uBands.y * 1.1);

  // Rings emitted on every beat, expanding and thinning as they go.
  for (int index = 0; index < 4; index++) {
    float age = uBeatPhase + float(index);
    float ringRadius = age * (0.22 + uEnergy * 0.1);
    float fade = exp(-age * 0.85);
    float ring = lineMask(radius - ringRadius, 1.5 + age * 0.6);
    colour += uInk * ring * fade * (1.0 + uBands.x * 1.3);
  }

  // A held inner figure so the centre is never empty.
  float core = lineMask(radius - (0.16 + 0.03 * swell(uBarPhase)), 1.8);
  colour += uAccent * core * (1.1 + hit(uBeatPhase, 5.0) * 1.2);

  // Fine radial ticks, driven by the high band.
  float ticks = lineMask(gridDistance(folded * folds / TAU * 32.0), 1.0);
  colour += uAccent * ticks * smoothstep(0.95, 0.25, radius) * uBands.z * 0.5;

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;

export const CONTOUR_GLSL = /* glsl */ `
/**
 * Iso-contours of a slowly warped field.
 *
 * Reads as topography rather than noise because only the level lines are
 * drawn, never the field itself. Intended for intros, breakdowns and anything
 * that should breathe instead of hit.
 */
void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  vec2 q = p * (1.05 + uEnergy * 0.5);
  q *= rot(uPhrasePhase * 0.6 + uSeed);

  // Domain warp: one fbm displaces the coordinates of another.
  float drift = uTime * 0.045;
  vec2 warp = vec2(fbm(q * 1.3 + drift), fbm(q * 1.3 - drift + 4.7));
  float field = fbm(q * 1.6 + (warp - 0.5) * (1.1 + uBands.y * 0.9));

  float levels = 5.0 + floor(uEnergy * 6.0);
  float scaled = field * levels + uBarPhase * 0.35;
  float contour = gridDistance(scaled) / levels;

  // Falloff toward the edges: without it the field tiles the frame evenly and
  // reads as wallpaper rather than as a composition with a subject.
  float focus = smoothstep(1.5, 0.15, length(p * vec2(0.8, 1.0)));

  float mask = lineMask(contour, 1.5);
  colour += uInk * mask * focus * (0.9 + uBands.y * 0.9);

  // Every fourth level is drawn heavier, the way a contour map marks index
  // lines; it gives the field a readable structure instead of uniform texture.
  float index = gridDistance(scaled / 4.0) / (levels / 4.0);
  colour += uAccent * lineMask(index, 2.6) * focus * (0.7 + hit(uBarPhase, 4.0) * 0.7);

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;

export const TUNNEL_GLSL = /* glsl */ `
/**
 * Polygonal tunnel.
 *
 * Travel is locked to the beat: exactly one ring passes the camera per beat,
 * so acceleration reads as the track getting faster rather than as an
 * arbitrary animation speed.
 */
float polygonRadius(vec2 p, float sides) {
  float angle = atan(p.y, p.x);
  float segment = TAU / sides;
  return cos(floor(0.5 + angle / segment) * segment - angle) * length(p);
}

void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  float sides = 4.0 + floor(uEnergy * 4.99);
  vec2 twisted = p * rot(uPhrasePhase * 0.9 + uSeed * TAU);
  float radius = max(polygonRadius(twisted, sides), 1e-4);

  // Depth along the tunnel; rings sit at unit intervals in depth.
  float depth = 1.0 / radius;
  float travel = uBeat;
  float ring = gridDistance(depth * 0.9 - travel);

  float fade = smoothstep(7.0, 0.6, depth);
  colour += uInk * lineMask(ring, 1.7) * fade * (0.9 + uBands.x * 1.2);

  // Longitudinal edges of the tunnel, which give it its shape.
  float angle = atan(twisted.y, twisted.x);
  float edge = gridDistance(angle / TAU * sides + 0.5);
  colour += uInk * lineMask(edge, 1.3) * fade * 0.8;

  // Vanishing point: a small bright core that pulses with the kick. Kept
  // tight, because a wide glow here reads as a lens flare rather than depth.
  float core = exp(-radius * 70.0);
  colour += uAccent * core * (0.7 + hit(uBeatPhase, 4.0) * 2.0);

  // A brighter ring on every downbeat, travelling out from the centre.
  float barRing = lineMask(depth * 0.9 - travel - 0.5, 3.0);
  colour += uAccent * barRing * fade * hit(uBarPhase, 2.0) * 1.3;

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;

export const INTERFERENCE_GLSL = /* glsl */ `
/**
 * Overlaid line families.
 *
 * Three sets of parallel lines at slowly diverging angles; where they cross,
 * moiré appears on its own. Rewards a build, because the pattern visibly
 * tightens as the angles converge.
 */
void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  // Wide angular separation and low density: the point is three legible line
  // families crossing, not a fine mesh. Dense settings collapse into fabric.
  float spread = 0.5 + uEnergy * 0.45;
  float density = 3.0 + uEnergy * 5.0;

  for (int index = 0; index < 3; index++) {
    float slot = float(index);
    float angle = uSeed * PI + (slot - 1.0) * spread + uPhrasePhase * 0.3;
    vec2 rotated = p * rot(angle);
    float offset = uBarPhase * (slot - 1.0) * 0.5;
    float mask = lineMask(gridDistance(rotated.y * density + offset), 1.6 + slot * 0.5);
    vec3 tint = slot == 1.0 ? uAccent : uInk;
    float band = slot < 0.5 ? uBands.x : (slot < 1.5 ? uBands.y : uBands.z);
    colour += tint * mask * (0.55 + band * 0.9);
  }

  // A sweep crossing the frame marks the bar without adding permanent clutter.
  float sweep = 1.0 - smoothstep(0.0, 0.04, abs(p.y - (uBarPhase * 2.6 - 1.3)));
  colour += uAccent * sweep * 0.8 * uEnergy;

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;

export const STROBE_GLSL = /* glsl */ `
/**
 * Nested frames that snap outward, one per beat.
 *
 * Deliberately the most austere scene in the set. Reserved for drops, where
 * anything softer reads as hesitation. Hard edges, no glow, no drift.
 */
float frameDistance(vec2 p, float size) {
  vec2 d = abs(p) - vec2(size * 1.35, size);
  return max(d.x, d.y);
}

void main() {
  vec2 p = centeredUv(vUv);
  vec3 colour = uBackground;

  // Quantise to the beat so the figure holds, then jumps.
  float beatIndex = floor(uBeat);
  float held = hash11(beatIndex * 0.731 + uSeed);
  vec2 q = p * rot((held - 0.5) * 0.28 * uEnergy);

  for (int index = 0; index < 5; index++) {
    float age = uBeatPhase + float(index);
    float size = 0.08 + age * (0.2 + uEnergy * 0.14);
    float fade = exp(-age * 0.55);
    float mask = lineMask(frameDistance(q, size), 3.4);
    vec3 tint = mod(float(index) + beatIndex, 2.0) < 1.0 ? uInk : uAccent;
    colour += tint * mask * fade * (2.2 + uBands.x * 1.8);
  }

  // A full-field flash on the downbeat, brief enough to read as punctuation.
  colour += uInk * hit(uBarPhase, 18.0) * 0.3 * uEnergy;

  gl_FragColor = vec4(grade(colour, vUv) * uIntensity, 1.0);
}
`;
