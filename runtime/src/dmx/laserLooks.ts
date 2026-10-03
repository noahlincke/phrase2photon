import { buildFb4ColorModeFrame, type Fb4Dmx16Frame } from "./fb4Dmx16.js";
import type { PhraseKind } from "../audio/structure.js";
import type { Phrase } from "../show/types.js";

/**
 * Beat-timed laser looks layered over the phrase frames.
 *
 * The phrase frame builder picks cue, colour and base dimmer once per phrase;
 * these looks add the per-beat behaviour on top - drop hits and strobe bursts,
 * build ramps, downbeat accents - so the laser answers the beat grid instead of
 * only the phrase boundaries. Pure: frame in, frame out, no clock reading.
 */

export interface LaserLookContext {
  phraseKind: PhraseKind;
  /** Kind of the phrase that follows, or null when unknown (live input). */
  nextPhraseKind: PhraseKind | null;
  /** Musical beats elapsed inside the current phrase, from its first downbeat. */
  beatsIntoPhrase: number;
  /** Length of the current phrase in beats. */
  beatsInPhrase: number;
  /** 0-1 through the current beat. */
  beatPhase: number;
  /** 1-based beat index inside the current bar. */
  beatInBar: number;
  beatsPerBar: number;
  /** Beats since the live analyzer called a drop, or null outside live input. */
  dropHitBeats: number | null;
}

/**
 * The phrase kind for the look, read from the phrase name the same way the
 * scene roles are: compiled shows carry names from the Ableton arrangement.
 */
export function phraseKindFor(phrase: Phrase): PhraseKind {
  const name = phrase.name.toLowerCase();
  if (name.includes("intro")) {
    return "intro";
  }
  if (name.includes("outro")) {
    return "outro";
  }
  if (name.includes("break") || name.includes("strip")) {
    return "breakdown";
  }
  if (name.includes("build") || name.includes("lift") || name.includes("riser")) {
    return "build";
  }
  if (name.includes("drop")) {
    return "drop";
  }
  return phrase.energy.level === "low" ? "breakdown" : "groove";
}

export function applyLaserLook(frame: Fb4Dmx16Frame, ctx: LaserLookContext): Fb4Dmx16Frame {
  let next = frame;
  const hit = dropHitBeats(ctx);
  if (hit !== null) {
    next = applyDropHit(next, hit);
  } else if (preDropDip(ctx)) {
    next = withDimmer(next, 0);
  } else {
    const ramp = rampWindow(ctx);
    if (ramp) {
      next = applyBuildRamp(next, ctx, ramp);
    }
    if (ctx.phraseKind === "groove" || ctx.phraseKind === "drop") {
      next = applyDownbeatAccent(next, ctx);
    }
  }
  if (ctx.phraseKind === "breakdown") {
    next = applyBreakdownDrift(next, ctx);
  }
  return next;
}

/**
 * Shifts a beat position forward by the output latency, so beat-timed events
 * are evaluated - and therefore sent - that much before the beat they land on.
 */
export function latencyShiftedBeats(beatFloat: number, latencyMs: number, bpm: number): number {
  return beatFloat + (latencyMs / 1000) * (bpm / 60);
}

/** One sixteenth note, the chop rate of the drop strobe burst. */
const SIXTEENTH_BEATS = 0.25;

/** Beats of impact before the burst starts chopping. */
const HIT_SOLID_BEATS = 1;

/**
 * The drop hit: beats since the drop downbeat while inside the hit bar.
 *
 * Live input reports the trigger through `dropHitBeats`; premade shows know the
 * drop is the current phrase's first bar.
 */
function dropHitBeats(ctx: LaserLookContext): number | null {
  const raw =
    ctx.dropHitBeats ??
    (ctx.phraseKind === "drop" && ctx.beatsIntoPhrase < ctx.beatsPerBar ? ctx.beatsIntoPhrase : null);
  return raw !== null && raw < ctx.beatsPerBar ? raw : null;
}

function applyDropHit(frame: Fb4Dmx16Frame, hitBeats: number): Fb4Dmx16Frame {
  // Full and solid on the downbeat, then the one-bar strobe burst chops the
  // dimmer on and off on sixteenth notes. Full size carries the whole bar.
  const dimmer =
    hitBeats < HIT_SOLID_BEATS ? 255 : Math.floor(hitBeats / SIXTEENTH_BEATS) % 2 === 0 ? 255 : 0;
  return withDimmer(withSize(frame, 255), dimmer);
}

/** The last beat before a drop goes dark, so the downbeat lands from black. */
function preDropDip(ctx: LaserLookContext): boolean {
  return ctx.nextPhraseKind === "drop" && ctx.beatsInPhrase - ctx.beatsIntoPhrase <= 1;
}

function dimmerOf(frame: Fb4Dmx16Frame): number {
  return frame.channels[frame.profile === "pangolin-fb4-dmx39" ? 16 : 4] ?? 0;
}

function withDimmer(frame: Fb4Dmx16Frame, dimmer: number): Fb4Dmx16Frame {
  const channels = [...frame.channels];
  channels[frame.profile === "pangolin-fb4-dmx39" ? 16 : 4] = clampByte(dimmer);
  return { ...frame, channels };
}

/** The span a build ramp measures over. */
interface RampWindow {
  beatsIntoRamp: number;
  beatsInRamp: number;
}

/** Eight bars of ramp leading into a drop for phrases that are not builds. */
const PRE_DROP_RAMP_BARS = 8;

/**
 * A build phrase ramps across its whole length; any other phrase ramps only
 * across its final eight bars when the next phrase is a drop.
 */
function rampWindow(ctx: LaserLookContext): RampWindow | null {
  if (ctx.phraseKind === "build") {
    return { beatsIntoRamp: ctx.beatsIntoPhrase, beatsInRamp: ctx.beatsInPhrase };
  }
  if (ctx.nextPhraseKind === "drop") {
    const beatsInRamp = Math.min(PRE_DROP_RAMP_BARS * ctx.beatsPerBar, ctx.beatsInPhrase);
    const beatsIntoRamp = ctx.beatsIntoPhrase - (ctx.beatsInPhrase - beatsInRamp);
    if (beatsIntoRamp >= 0) {
      return { beatsIntoRamp, beatsInRamp };
    }
  }
  return null;
}

/** The build ramp: size grows across the ramp window while the dimmer pulses faster. */
function applyBuildRamp(frame: Fb4Dmx16Frame, ctx: LaserLookContext, ramp: RampWindow): Fb4Dmx16Frame {
  const progress = clamp01(ramp.beatsIntoRamp / Math.max(ramp.beatsInRamp, 1));
  const sized = withSize(frame, Math.round(BUILD_SIZE_FLOOR + (255 - BUILD_SIZE_FLOOR) * progress));
  const intervalBeats = buildPulseIntervalBeats(ctx, ramp);
  const peak = dimmerOf(sized);
  const base = Math.round(peak * BUILD_PULSE_FLOOR);
  const pulsePhase = (ramp.beatsIntoRamp % intervalBeats) / intervalBeats;
  const pulsed = withDimmer(sized, Math.round(base + (peak - base) * (1 - pulsePhase)));
  return finalBuildBars(ctx, ramp) ? whiteColour(pulsed) : pulsed;
}

/** First half pulses on quarters, then eighths, and sixteenths for the last two bars. */
function buildPulseIntervalBeats(ctx: LaserLookContext, ramp: RampWindow): number {
  if (finalBuildBars(ctx, ramp)) {
    return SIXTEENTH_BEATS;
  }
  return ramp.beatsIntoRamp >= ramp.beatsInRamp / 2 ? 0.5 : 1;
}

function finalBuildBars(ctx: LaserLookContext, ramp: RampWindow): boolean {
  return ramp.beatsInRamp - ramp.beatsIntoRamp <= ctx.beatsPerBar * 2;
}

/** Sixty percent of full size at the start of the build, full size by the drop. */
const BUILD_SIZE_FLOOR = Math.round(0.6 * 255);

/** Where the build pulse decays to between hits, as a share of the phrase dimmer. */
const BUILD_PULSE_FLOOR = 0.4;

/** Forces the colour channels to white, the way the operator's White button does. */
function whiteColour(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
  return buildFb4ColorModeFrame(frame, "white");
}

/** Downbeat accents: instant to the phrase peak, decaying to base over one beat. */
function applyDownbeatAccent(frame: Fb4Dmx16Frame, ctx: LaserLookContext): Fb4Dmx16Frame {
  // Drop phrases accent every beat; groove phrases only on the bar downbeat.
  if (ctx.phraseKind !== "drop" && ctx.beatInBar !== 1) {
    return frame;
  }
  const peak = dimmerOf(frame);
  const base = Math.round(peak * ACCENT_FLOOR);
  return withDimmer(frame, Math.round(base + (peak - base) * (1 - ctx.beatPhase)));
}

/** Where an accent decays to between hits, as a share of the phrase dimmer. */
const ACCENT_FLOOR = 0.5;

/** Breakdowns keep the phrase's soft pool and dimmer but rotate at half speed. */
function applyBreakdownDrift(frame: Fb4Dmx16Frame, ctx: LaserLookContext): Fb4Dmx16Frame {
  const progress = clamp01(ctx.beatsIntoPhrase / Math.max(ctx.beatsInPhrase, 1));
  const angle = Math.round(progress * 0.5 * 255);
  const channels = [...frame.channels];
  if (frame.profile === "pangolin-fb4-dmx39") {
    writeByte16(channels, 23, angle);
  } else {
    channels[8] = angle;
  }
  return { ...frame, channels };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function withSize(frame: Fb4Dmx16Frame, size: number): Fb4Dmx16Frame {
  const channels = [...frame.channels];
  if (frame.profile === "pangolin-fb4-dmx39") {
    writeByte16(channels, 19, size);
    writeByte16(channels, 21, size);
  } else {
    channels[6] = clampByte(size);
    channels[7] = clampByte(size);
  }
  return { ...frame, channels };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function writeByte16(channels: number[], startIndex: number, byteValue: number): void {
  const coarse = clampByte(byteValue);
  channels[startIndex] = coarse;
  channels[startIndex + 1] = coarse;
}
