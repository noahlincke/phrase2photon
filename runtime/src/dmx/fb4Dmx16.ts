import type { DmxLaserCue, LightingCue, Phrase, ShowPackage } from "../show/types.js";
import { describeFb4Cue, fb4CueCatalog } from "./fb4CueCatalog.js";

export interface Fb4Dmx16Input {
  show: ShowPackage;
  phrase: Phrase;
  lightingCue: LightingCue | null;
  laserCue?: DmxLaserCue | null;
  allowExperimental39Channel?: boolean;
  phraseProgress: number;
  cueSelection?: Fb4CueSelection;
  /** Operator-curated pools; when a pool has enough reachable favourites the selector picks only from it. */
  favouriteCues?: Fb4CueFavouritePools;
  paletteOverride?: string;
  /** Current tempo on the show's grid; defaults to the show's headline tempo. */
  bpm?: number;
}

export interface Fb4Dmx16Frame {
  profile: "pangolin-fb4-dmx16" | "pangolin-fb4-dmx39";
  palette: string;
  colorMode: "original" | "color-scroll" | "white";
  colorLabel: string;
  colorValue: number;
  graphicsColor: string;
  label: string;
  page: number;
  cue: number;
  cueShape: string | null;
  channels: number[];
  labels: string[];
}

export type Fb4CueControlKind = "blackout" | "cue-1";
export type Fb4ColorMode = "original" | "white";
export type Fb4CueSelectionMode = "deterministic" | "variety";

export interface Fb4CueSelection {
  mode: Fb4CueSelectionMode;
  rotationOrdinal?: number;
}

export type Fb4CuePoolId = "open" | "balanced" | "driving" | "impact";

/** Operator-favourited cue keys ("page:cue") per selection pool. */
export type Fb4CueFavouritePools = Partial<Record<Fb4CuePoolId, string[]>>;

/** A pool needs at least this many reachable favourites before it replaces the default pool. */
export const FB4_FAVOURITE_POOL_MINIMUM = 4;

export interface Fb4CueTarget {
  page: number;
  cue: number;
}

export interface Fb4PaletteVarietyInput {
  eventKey: string;
  currentPalette: string | null;
  paletteIds: string[];
}

export function buildFb4Dmx16Frame(input: Fb4Dmx16Input): Fb4Dmx16Frame {
  const bpm = input.bpm ?? input.show.song.tempo;
  const palette = input.paletteOverride ?? input.phrase.visual_look.palette;
  const laserCue = input.laserCue ?? findPhraseLaserCue(input.show, input.phrase.phrase_id);
  const explicitTarget = input.allowExperimental39Channel === false ? null : resolveFb4LaserCueTarget(laserCue);
  const fallbackTarget = resolveFb4LegacyCueTarget(input);
  const pageNumber = explicitTarget?.page ?? fallbackTarget.page;
  const cueNumber = explicitTarget?.cue ?? fallbackTarget.cue;
  const intensity = input.lightingCue?.look.intensity ?? input.phrase.energy.dynamics;
  // Energy used to dim; now it sizes: low energy stays small, peak fills out.
  const size = Math.round(150 + Math.max(0, Math.min(1, intensity)) * 105);
  const angle = Math.round(input.phraseProgress * 255);
  const color = fb4ColorForPalette(palette);
  const cueDescription = describeFb4Cue(pageNumber, cueNumber);

  if (explicitTarget) {
    return withFrameMeta({
      profile: "pangolin-fb4-dmx39",
      palette,
      colorMode: color.mode,
      label: cueDescription ? `${input.phrase.name} / ${cueDescription.name}` : input.phrase.name,
      channels: baseCueChannels39({
        bpm,
        pageNumber,
        cueNumber,
        dimmer: intensityToDimmer(intensity),
        zoom: 128,
        sizeX: size,
        sizeY: size,
        angle,
        positionX: 128,
        positionY: 128,
        scan: clampByte(Math.round((0.45 + intensity * 0.55) * 255)),
        color
      })
    });
  }

  return {
    profile: "pangolin-fb4-dmx16",
    palette,
    colorMode: color.mode,
    colorLabel: color.label,
    colorValue: color.value,
    graphicsColor: color.graphicsColor,
    label: cueDescription ? `${input.phrase.name} / ${cueDescription.name}` : input.phrase.name,
    page: pageNumber,
    cue: cueNumber,
    cueShape: cueDescription?.observedShape ?? null,
    channels: [
      240,
      pageIndexValue(pageNumber),
      cueIndexValue(cueNumber),
      clampByte(Math.round(bpm)),
      intensityToDimmer(intensity),
      128,
      size,
      size,
      angle,
      128,
      128,
      255,
      240,
      128,
      color.value,
      0
    ],
    labels: channelLabels("pangolin-fb4-dmx16")
  };
}

export function buildFb4CueControlFrame(kind: Fb4CueControlKind, bpm = 122): Fb4Dmx16Frame {
  if (kind === "blackout") {
    return withFrameMeta({
      profile: "pangolin-fb4-dmx16",
      palette: "blackout",
      colorMode: "original",
      label: "Blackout",
      channels: new Array<number>(16).fill(0)
    });
  }

  return withFrameMeta({
    profile: "pangolin-fb4-dmx16",
    palette: "cue-1",
    colorMode: "original",
    label: "Cue 1",
    channels: baseCueChannels({ bpm, pageNumber: 1, cueNumber: 1, dimmer: 255, color: 0 })
  });
}

export function buildFb4ColorModeFrame(baseFrame: Fb4Dmx16Frame, mode: Fb4ColorMode): Fb4Dmx16Frame {
  const channels = [...baseFrame.channels];
  if (baseFrame.profile === "pangolin-fb4-dmx39") {
    if (mode === "white") {
      channels[32] = 255;
      channels[33] = 255;
      channels[34] = 255;
      channels[35] = 255;
    } else {
      channels[35] = 0;
    }
  } else {
    channels[14] = mode === "white" ? 240 : 0;
  }
  const baseLabel = stripColorOverlayLabel(baseFrame.label);
  const colorLabel = mode === "white" ? "White" : "Original color";
  return {
    ...baseFrame,
    palette: mode === "white" ? "white" : "original-cue-color",
    colorMode: mode,
    colorLabel,
    colorValue: baseFrame.profile === "pangolin-fb4-dmx39" ? channels[35] ?? 0 : channels[14] ?? 0,
    graphicsColor: mode === "white" ? "#f8fafc" : baseFrame.graphicsColor,
    label: `${baseLabel} / ${colorLabel}`,
    channels
  };
}

export function buildFb4ColorScrollFrame(baseFrame: Fb4Dmx16Frame, value: number, label: string): Fb4Dmx16Frame {
  const channels = [...baseFrame.channels];
  const colorValue = clampByte(value);
  let graphicsColor = baseFrame.graphicsColor;
  if (baseFrame.profile === "pangolin-fb4-dmx39") {
    const rgb = rgbForColorValue(colorValue);
    channels[32] = rgb.r;
    channels[33] = rgb.g;
    channels[34] = rgb.b;
    channels[35] = 255;
    graphicsColor = rgbHex(rgb);
  } else {
    channels[14] = colorValue;
  }
  const baseLabel = stripColorOverlayLabel(baseFrame.label);
  return {
    ...baseFrame,
    palette: `laser-${slugify(label)}`,
    colorMode: "color-scroll",
    colorLabel: label,
    colorValue,
    graphicsColor,
    label: `${baseLabel} / ${label}`,
    channels
  };
}

export function buildFb4CueFrame(cueNumber: number, bpm = 122, pageNumber = 1): Fb4Dmx16Frame {
  return withFrameMeta({
    profile: "pangolin-fb4-dmx39",
    palette: `cue-${pageNumber}-${cueNumber}`,
    colorMode: "original",
    label: `P${pageNumber} C${cueNumber}`,
    channels: baseCueChannels39({
      bpm,
      pageNumber,
      cueNumber,
      dimmer: 255,
      zoom: 128,
      sizeX: 160,
      sizeY: 160,
      angle: 128,
      positionX: 128,
      positionY: 128,
      scan: 240,
      color: { mode: "original", label: "Original color", value: 0, graphicsColor: "#f8fafc" }
    })
  });
}

export function buildFb4LegacyCueFrame(cueNumber: number, bpm = 122, pageNumber = 1): Fb4Dmx16Frame {
  return withFrameMeta({
    profile: "pangolin-fb4-dmx16",
    palette: `cue-${pageNumber}-${cueNumber}`,
    colorMode: "original",
    label: `P${pageNumber} C${cueNumber}`,
    channels: baseCueChannels({ bpm, pageNumber, cueNumber, dimmer: 255, color: 0 })
  });
}

export function buildFb4ZoneFrame(bpm = 122): Fb4Dmx16Frame {
  const channels = baseCueChannels({ bpm, pageNumber: 1, cueNumber: 4, dimmer: 255, color: 240 });
  channels[5] = 128;
  channels[6] = 255;
  channels[7] = 255;
  channels[8] = 128;
  channels[9] = 128;
  channels[10] = 128;
  channels[11] = 255;
  channels[12] = 240;
  return withFrameMeta({
    profile: "pangolin-fb4-dmx16",
    palette: "zone-frame",
    colorMode: "white",
    label: "Square",
    channels
  });
}

/**
 * A fixed-dimmer overlay for the console's Fade test sweep: at the venue the
 * operator runs it to see how fades read at the FB4 brightness they set.
 */
export function buildFb4FadeOverlayFrame(dimmer: number, bpm = 122): Fb4Dmx16Frame {
  return withFrameMeta({
    profile: "pangolin-fb4-dmx39",
    palette: `fade-${dimmer}`,
    colorMode: "original",
    label: `Fade ${dimmer}`,
    channels: baseCueChannels39({
      bpm,
      pageNumber: 1,
      cueNumber: 1,
      dimmer,
      zoom: 128,
      sizeX: 160,
      sizeY: 160,
      angle: 128,
      positionX: 128,
      positionY: 128,
      scan: 240,
      color: { mode: "original", label: "Original color", value: 0, graphicsColor: "#f8fafc" }
    })
  });
}

export function cueIndexValue(cueNumber: number): number {
  if (cueNumber <= 0) {
    return 0;
  }
  return clampByte(34 + (Math.min(cueNumber, 48) - 1) * 4);
}

export function pageIndexValue(pageNumber: number): number {
  if (pageNumber <= 1) {
    return 0;
  }
  if (pageNumber >= 9) {
    return 129;
  }
  return 1 + (pageNumber - 1) * 16;
}

export function fb4CueRequires39Channel(pageNumber: number, cueNumber: number): boolean {
  return pageNumber < 1 || pageNumber > 9 || cueNumber < 1 || cueNumber > 48;
}

export function resolveFb4LegacyCueTarget(input: Fb4Dmx16Input): Fb4CueTarget {
  const poolId = legacyCueProfileForPhrase(input.phrase);
  const favourites = favouriteCuePoolForProfile(poolId, input.favouriteCues);
  const pool = favourites.length >= FB4_FAVOURITE_POOL_MINIMUM
    ? favourites
    : legacyCuePoolForProfile(poolId);
  const selection = input.cueSelection ?? { mode: "deterministic" as const };
  if (selection.mode === "variety") {
    const groups = groupLegacyCuePoolByPage(pool);
    const pages = [...groups.keys()].sort((left, right) => left - right);
    const rotation = Math.max(0, Math.trunc(selection.rotationOrdinal ?? 0));
    const basePageIndex = positiveModulo(stableHash(`${legacyCueSelectionKey(input.show, input.phrase)}|page`), pages.length);
    const page = pages[(basePageIndex + rotation) % pages.length] ?? pages[0] ?? 1;
    const pageEntries = groups.get(page) ?? pool;
    const cueRotation = Math.floor(rotation / Math.max(1, pages.length));
    const baseCueIndex = positiveModulo(stableHash(`${legacyCueSelectionKey(input.show, input.phrase)}|cue`), pageEntries.length);
    const entry = pageEntries[(baseCueIndex + cueRotation) % pageEntries.length] ?? pageEntries[0] ?? pool[0];
    return {
      page: entry.page,
      cue: entry.cue
    };
  }

  const baseIndex = positiveModulo(stableHash(legacyCueSelectionKey(input.show, input.phrase)), pool.length);
  const entry = pool[baseIndex] ?? pool[0];

  return {
    page: entry.page,
    cue: entry.cue
  };
}

export function selectVariedFb4Palette(input: Fb4PaletteVarietyInput): string {
  const paletteIds = [...new Set(input.paletteIds.filter((paletteId) => paletteId.trim().length > 0))];
  if (paletteIds.length === 0) {
    return input.currentPalette ?? "desaturated_decay";
  }

  if (!input.currentPalette || !paletteIds.includes(input.currentPalette)) {
    return paletteIds[positiveModulo(stableHash(`${input.eventKey}|initial`), paletteIds.length)] ?? paletteIds[0];
  }

  if (paletteIds.length === 1) {
    return input.currentPalette;
  }

  const shouldHoldCurrentPalette = positiveModulo(stableHash(`${input.eventKey}|hold`), 4) === 0;
  if (shouldHoldCurrentPalette) {
    return input.currentPalette;
  }

  const alternatives = paletteIds.filter((paletteId) => paletteId !== input.currentPalette);
  return alternatives[positiveModulo(stableHash(`${input.eventKey}|switch`), alternatives.length)] ?? input.currentPalette;
}

function baseCueChannels(input: { bpm: number; pageNumber: number; cueNumber: number; dimmer: number; color: number }): number[] {
  return [
    240,
    pageIndexValue(input.pageNumber),
    cueIndexValue(input.cueNumber),
    clampByte(Math.round(input.bpm)),
    clampByte(input.dimmer),
    128,
    160,
    160,
    128,
    128,
    128,
    255,
    240,
    128,
    clampByte(input.color),
    0
  ];
}

function baseCueChannels39(input: {
  bpm: number;
  pageNumber: number;
  cueNumber: number;
  dimmer: number;
  zoom: number;
  sizeX: number;
  sizeY: number;
  angle: number;
  positionX: number;
  positionY: number;
  scan: number;
  color: Fb4ColorSelection;
}): number[] {
  const channels = new Array<number>(39).fill(0);
  channels[0] = 251;
  // Setup channels 2-13 latch only in FB4 setup mode, but 0 is not neutral on
  // them: the spec gives max intensity range 0-100 (0 = dark) and signed size /
  // position with 0 = the -100% extreme. Stream the uncapped full-area neutrals
  // so a setup-mode latch can never store a collapsed or dark show.
  // https://wiki.pangolin.com/doku.php?id=hardware:fb4:dmx39
  channels[1] = 255;
  write16Bit(channels, 3, 65535);
  write16Bit(channels, 5, 65535);
  write16Bit(channels, 7, 32768);
  write16Bit(channels, 9, 32768);
  channels[13] = clampByte(input.pageNumber);
  channels[14] = clampByte(input.cueNumber);
  channels[15] = clampByte(Math.round(input.bpm));
  channels[16] = clampByte(input.dimmer);
  write16Bit(channels, 17, scaleByteTo16(input.zoom));
  write16Bit(channels, 19, scaleByteTo16(input.sizeX));
  write16Bit(channels, 21, scaleByteTo16(input.sizeY));
  write16Bit(channels, 23, scaleByteTo16(input.angle));
  write16Bit(channels, 27, scaleByteTo16(input.positionX));
  write16Bit(channels, 29, scaleByteTo16(input.positionY));
  channels[31] = clampByte(input.scan);

  if (input.color.mode === "white") {
    channels[32] = 255;
    channels[33] = 255;
    channels[34] = 255;
    channels[35] = 255;
  } else if (input.color.mode === "color-scroll") {
    const rgb = rgbFromHex(input.color.graphicsColor);
    channels[32] = rgb.r;
    channels[33] = rgb.g;
    channels[34] = rgb.b;
    channels[35] = 255;
  }
  return channels;
}

function withFrameMeta(input: {
  profile: Fb4Dmx16Frame["profile"];
  palette: string;
  colorMode: Fb4Dmx16Frame["colorMode"];
  label: string;
  channels: number[];
}): Fb4Dmx16Frame {
  const page = pageFromChannels(input.profile, input.channels);
  const cue = cueFromChannels(input.profile, input.channels);
  return {
    profile: input.profile,
    palette: input.palette,
    colorMode: input.colorMode,
    colorLabel: colorLabelFromFrame(input.profile, input.colorMode, input.channels),
    colorValue: colorValueFromChannels(input.profile, input.channels),
    graphicsColor: graphicsColorFromFrame(input.profile, input.palette, input.channels),
    label: input.label,
    page,
    cue,
    cueShape: describeFb4Cue(page, cue)?.observedShape ?? null,
    channels: input.channels,
    labels: channelLabels(input.profile)
  };
}

function channelLabels(profile: Fb4Dmx16Frame["profile"]): string[] {
  if (profile === "pangolin-fb4-dmx39") {
    return [
      "Fixture mode",
      "Setup: max intensity",
      "Setup: test frames",
      "Setup: size X coarse",
      "Setup: size X fine",
      "Setup: size Y coarse",
      "Setup: size Y fine",
      "Setup: position X coarse",
      "Setup: position X fine",
      "Setup: position Y coarse",
      "Setup: position Y fine",
      "Setup: rotation coarse",
      "Setup: rotation fine",
      "Page index",
      "Cue index",
      "Cue speed / BPM",
      "Dimmer",
      "Zoom coarse",
      "Zoom fine",
      "Size X coarse",
      "Size X fine",
      "Size Y coarse",
      "Size Y fine",
      "Angle coarse",
      "Angle fine",
      "Rotation coarse",
      "Rotation fine",
      "Position X coarse",
      "Position X fine",
      "Position Y coarse",
      "Position Y fine",
      "Scan rate",
      "Red",
      "Green",
      "Blue",
      "Alpha",
      "Points start",
      "Points end",
      "Strobe"
    ];
  }
  return [
    "DMX mode: sixteen channel",
    "Page index",
    "Cue index",
    "Cue speed / BPM",
    "Dimmer",
    "Zoom",
    "Size X",
    "Size Y",
    "Angle Z",
    "Position X",
    "Position Y",
    "Visible points",
    "Scan rate",
    "Cue release: loop",
    "Color mode",
    "Reserved"
  ];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function legacyCueSelectionKey(show: ShowPackage, phrase: Phrase): string {
  return [
    show.song.song_id,
    show.song.title,
    phrase.phrase_id,
    phrase.name,
    phrase.range.start_bar_beat,
    phrase.range.end_bar_beat
  ].join("|");
}

function legacyCuePoolForProfile(poolId: Fb4CuePoolId) {
  const allowedPages = legacyCuePagesForProfile(poolId);
  const pool = fb4CueCatalog.filter((entry) =>
    entry.page >= 1
    && entry.page <= 9
    && entry.cue >= 1
    && entry.cue <= 48
    && allowedPages.has(entry.page)
  );

  return pool.length ? pool : fb4CueCatalog.filter((entry) => entry.page === 1 && entry.cue >= 1 && entry.cue <= 48);
}

/**
 * Resolves the operator's favourited cues for one pool, in file order, keeping
 * only entries the catalogue knows and the automatic selector can address.
 * The fallback lane always emits 16-channel frames, so reachability is the
 * 16-channel envelope regardless of the experimental 39-channel toggle.
 */
export function favouriteCuePoolForProfile(
  poolId: Fb4CuePoolId,
  favourites: Fb4CueFavouritePools | undefined
): typeof fb4CueCatalog {
  const entries: typeof fb4CueCatalog = [];
  for (const key of favourites?.[poolId] ?? []) {
    const match = /^(\d+):(\d+)$/.exec(key);
    const page = match ? Number(match[1]) : 0;
    const cue = match ? Number(match[2]) : 0;
    const entry = fb4CueCatalog.find((candidate) => candidate.page === page && candidate.cue === cue);
    if (!entry || fb4CueRequires39Channel(page, cue)) {
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function groupLegacyCuePoolByPage(pool: typeof fb4CueCatalog): Map<number, typeof fb4CueCatalog> {
  const grouped = new Map<number, typeof fb4CueCatalog>();
  for (const entry of pool) {
    const pageEntries = grouped.get(entry.page) ?? [];
    pageEntries.push(entry);
    grouped.set(entry.page, pageEntries);
  }
  return grouped;
}

function legacyCueProfileForPhrase(phrase: Phrase): Fb4CuePoolId {
  const composition = phrase.visual_look.composition.toLowerCase();
  const motion = phrase.visual_look.motion_style.toLowerCase();
  const name = phrase.name.toLowerCase();

  if (
    phrase.energy.level === "peak"
    || name.includes("drop")
    || motion.includes("cut")
    || motion.includes("strobe")
  ) {
    return "impact";
  }

  if (
    phrase.energy.level === "high"
    || composition.includes("dense")
    || composition.includes("full")
    || name.includes("lift")
    || name.includes("build")
    || motion.includes("ramp")
    || motion.includes("chase")
  ) {
    return "driving";
  }

  if (
    phrase.energy.level === "low"
    || composition.includes("sparse")
    || composition.includes("open")
    || name.includes("intro")
    || name.includes("strip")
    || motion.includes("drift")
  ) {
    return "open";
  }

  return "balanced";
}

function legacyCuePagesForProfile(profile: Fb4CuePoolId): Set<number> {
  if (profile === "open") {
    return new Set([1, 2, 6]);
  }
  if (profile === "driving") {
    return new Set([2, 3, 5, 6, 7, 8]);
  }
  if (profile === "impact") {
    return new Set([3, 4, 5, 7, 8, 9]);
  }
  return new Set([1, 2, 3, 5, 6]);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) {
    return 0;
  }
  return ((value % divisor) + divisor) % divisor;
}

/**
 * The FB4's own Master Brightness already sets overall brightness, and on this
 * laser a mid-range dimmer starves the RGB diodes (white collapses to red or
 * purple), so the DMX dimmer is a switch: the old near-black fade band stays
 * dark, everything else is full.
 */
export function intensityToDimmer(intensity: number): number {
  const normalized = Math.max(0, Math.min(1, intensity));
  return normalized <= 0.1 ? 0 : 255;
}

function cueFromChannels(profile: Fb4Dmx16Frame["profile"], channels: number[]): number {
  if (profile === "pangolin-fb4-dmx39") {
    return clampByte(channels[14] ?? 0);
  }
  const cueValue = channels[2] ?? 0;
  if (cueValue < 34) {
    return 0;
  }
  return Math.round((cueValue - 34) / 4) + 1;
}

function pageFromChannels(profile: Fb4Dmx16Frame["profile"], channels: number[]): number {
  if (profile === "pangolin-fb4-dmx39") {
    return clampByte(channels[13] ?? 1) || 1;
  }
  const pageValue = channels[1] ?? 0;
  if (pageValue <= 0) {
    return 1;
  }
  if (pageValue === 129) {
    return 9;
  }
  return Math.floor((pageValue - 1) / 16) + 2;
}

function stripColorOverlayLabel(label: string): string {
  return label.replace(/( \/ (White|Original color))+$/g, "");
}

interface Fb4ColorSelection {
  mode: Fb4Dmx16Frame["colorMode"];
  label: string;
  value: number;
  graphicsColor: string;
}

function fb4ColorForPalette(palette: string): Fb4ColorSelection {
  const graphicsColor = graphicsColorForPalette(palette);
  if (palette.includes("acid")) {
    return { mode: "color-scroll", label: "Yellow-Lime", value: 84, graphicsColor };
  }
  if (palette.includes("smoke") || palette.includes("cool")) {
    return { mode: "color-scroll", label: "Cyan", value: 118, graphicsColor };
  }
  if (palette.includes("nocturne")) {
    return { mode: "color-scroll", label: "Purple", value: 180, graphicsColor };
  }
  if (palette.includes("warm")) {
    return { mode: "color-scroll", label: "Orange", value: 54, graphicsColor };
  }
  if (palette.includes("desaturated") || palette.includes("white")) {
    return { mode: "white", label: "White", value: 240, graphicsColor };
  }
  return { mode: "white", label: "White", value: 240, graphicsColor };
}

function graphicsColorForPalette(palette: string): string {
  const colors: Record<string, string> = {
    "acid-contrast": "#d9ff00",
    "smoke-cool": "#7dd3fc",
    "nocturne-glow": "#c084fc",
    "warm-cinematic": "#f59e0b",
    desaturated_decay: "#d1d5db",
    blackout: "#000000",
    white: "#f8fafc"
  };
  return colors[palette] ?? "#f8fafc";
}

function colorLabelFromChannel(value: number): string {
  if (value <= 31) return "Original color";
  if (value >= 225) return "White";
  if (value < 44) return "Red";
  if (value < 65) return "Orange";
  if (value < 86) return "Yellow";
  if (value < 107) return "Lime";
  if (value < 128) return "Green";
  if (value < 149) return "Cyan";
  if (value < 170) return "Blue";
  if (value < 191) return "Purple";
  if (value < 212) return "Pink";
  return "Red";
}

function colorLabelFromFrame(
  profile: Fb4Dmx16Frame["profile"],
  colorMode: Fb4Dmx16Frame["colorMode"],
  channels: number[]
): string {
  if (profile === "pangolin-fb4-dmx39") {
    if (colorMode === "original" || (channels[35] ?? 0) === 0) {
      return "Original color";
    }
    if ((channels[32] ?? 0) === 255 && (channels[33] ?? 0) === 255 && (channels[34] ?? 0) === 255) {
      return "White";
    }
    return rgbLabel(channels[32] ?? 0, channels[33] ?? 0, channels[34] ?? 0);
  }
  return colorLabelFromChannel(channels[14] ?? 0);
}

function colorValueFromChannels(profile: Fb4Dmx16Frame["profile"], channels: number[]): number {
  if (profile === "pangolin-fb4-dmx39") {
    return clampByte(channels[35] ?? 0);
  }
  return clampByte(channels[14] ?? 0);
}

function graphicsColorFromFrame(profile: Fb4Dmx16Frame["profile"], palette: string, channels: number[]): string {
  if (profile === "pangolin-fb4-dmx39" && (channels[35] ?? 0) > 0) {
    return rgbHex({
      r: clampByte(channels[32] ?? 0),
      g: clampByte(channels[33] ?? 0),
      b: clampByte(channels[34] ?? 0)
    });
  }
  return graphicsColorForPalette(palette);
}

function rgbLabel(r: number, g: number, b: number): string {
  if (r === 255 && g === 255 && b === 255) return "White";
  if (r > 200 && g < 80 && b < 80) return "Red";
  if (r > 200 && g > 120 && b < 80) return "Orange";
  if (r > 200 && g > 180 && b < 100) return "Yellow";
  if (r > 120 && g > 200 && b < 100) return "Lime";
  if (g > 180 && b > 180) return "Cyan";
  if (b > 180 && r < 120) return "Blue";
  if (r > 160 && b > 160) return "Purple";
  return "Custom RGB";
}

function rgbForColorValue(value: number): { r: number; g: number; b: number } {
  if (value <= 31) return { r: 248, g: 250, b: 252 };
  if (value >= 225) return { r: 255, g: 255, b: 255 };
  if (value < 44) return { r: 255, g: 59, b: 48 };
  if (value < 65) return { r: 245, g: 158, b: 11 };
  if (value < 86) return { r: 250, g: 204, b: 21 };
  if (value < 107) return { r: 217, g: 255, b: 0 };
  if (value < 128) return { r: 74, g: 222, b: 128 };
  if (value < 149) return { r: 125, g: 211, b: 252 };
  if (value < 170) return { r: 59, g: 130, b: 246 };
  if (value < 191) return { r: 192, g: 132, b: 252 };
  if (value < 212) return { r: 244, g: 114, b: 182 };
  return { r: 255, g: 59, b: 48 };
}

function rgbFromHex(value: string): { r: number; g: number; b: number } {
  const normalized = value.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 248, g: 250, b: 252 };
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function rgbHex(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b].map((value) => clampByte(value).toString(16).padStart(2, "0")).join("")}`;
}

function scaleByteTo16(value: number): number {
  return clampByte(value) * 257;
}

function write16Bit(channels: number[], startIndex: number, value: number): void {
  const clamped = Math.max(0, Math.min(65535, Math.round(value)));
  channels[startIndex] = (clamped >> 8) & 0xff;
  channels[startIndex + 1] = clamped & 0xff;
}

function findPhraseLaserCue(show: ShowPackage, phraseId: string): DmxLaserCue | null {
  return show.dmx_laser_cues.find((cue) => cue.phrase_id === phraseId && resolveFb4LaserCueTarget(cue)) ?? null;
}

export function resolveFb4LaserCueTarget(laserCue: DmxLaserCue | null | undefined): { page: number; cue: number } | null {
  if (!laserCue) {
    return null;
  }
  const page = positiveIntFromOverride(laserCue.parameter_overrides.page);
  const cue = positiveIntFromOverride(laserCue.parameter_overrides.cue);
  if (!page || !cue) {
    return null;
  }
  return { page, cue };
}

function positiveIntFromOverride(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
