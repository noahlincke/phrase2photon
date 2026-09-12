import "./styles.css";

import { AudioAnalyser } from "./audioAnalyser.js";
import { AudioTimeline, loadWaveformPeaks, type TimelinePhrase } from "./audioTimeline.js";
import { buildFallbackPreviewState } from "./fallbackPreview.js";
import { escapeHtml, formatTime } from "./html.js";
import { LaserConsole } from "./laserConsole.js";
import { buildLiveShow, livePhraseFor } from "./liveShow.js";
import { MicCapture } from "./micCapture.js";
import {
  describeAudioInputDevice,
  isAudioInputDevice,
  resolvePreferredAudioInput,
  type AudioInputDeviceLike
} from "./micInputDevices.js";
import { SHELL_TEMPLATE } from "./shell.js";
import type { LoadedTrack, RuntimeInputMode } from "./types.js";
import { buildNowPlayingMetaRows } from "./viewState.js";
import { LiveAnalyzer, type LiveMusicalState } from "../audio/liveAnalysis.js";
import { paletteById, palettes } from "../graphics/palette.js";
import { VisualSystem, type MusicalFrame } from "../graphics/visualSystem.js";
import {
  energyValueForPhrase,
  roleForPhrase,
  sceneIdForPresetId
} from "../graphics/visualPresets.js";
import { roleForPhraseKind, selectScene, visualScenes } from "../graphics/visualScenes.js";
import {
  buildFb4Dmx16Frame,
  resolveFb4LaserCueTarget,
  selectVariedFb4Palette,
  type Fb4Dmx16Frame
} from "../dmx/fb4Dmx16.js";
import type { PublicLibraryTrack } from "../library/types.js";
import { fetchNowPlayingStatus } from "../nowPlaying/client.js";
import {
  applyNowPlayingStatus,
  createNowPlayingSession,
  type NowPlayingPlayback
} from "../nowPlaying/handoff.js";
import {
  isBrowserAudioTransportSource,
  resolveNowPlayingPlaybackDurationSeconds,
  resolveNowPlayingPlaybackSeconds
} from "../nowPlaying/transportClock.js";
import type { NowPlayingStatus } from "../nowPlaying/types.js";
import { buildPhraseSchedule, playbackStateAt, type ScheduledPhrase } from "../runtime/schedule.js";
import { coerceShowPackage } from "../show/hydrate.js";
import type { DmxLaserCue, Phrase, ShowPackage } from "../show/types.js";

/**
 * Application orchestration.
 *
 * Owns the render loop and the three audio sources, and delegates everything
 * else: `VisualSystem` renders, `LaserConsole` drives the output lane,
 * `LiveAnalyzer` handles microphone input. Its job is to decide what is
 * musically true right now and hand that to the parts that draw and emit.
 */

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

const exportMode = new URLSearchParams(window.location.search).get("export") === "1";
document.body.classList.toggle("export-mode", exportMode);
app.innerHTML = SHELL_TEMPLATE;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

const ui = {
  viewer: required<HTMLElement>("viewer"),
  canvas: required<HTMLCanvasElement>("visualizer"),
  audio: required<HTMLAudioElement>("audio"),
  audioTimeline: required<HTMLCanvasElement>("audioTimeline"),
  transport: required<HTMLDivElement>("transport"),
  playButton: required<HTMLButtonElement>("playButton"),
  scrub: required<HTMLInputElement>("scrub"),
  nowLabel: required<HTMLElement>("nowLabel"),
  nowTime: required<HTMLElement>("nowTime"),
  fullscreenButton: required<HTMLButtonElement>("fullscreenButton"),

  hud: required<HTMLDivElement>("hud"),
  hudBpm: required<HTMLElement>("hudBpm"),
  hudLock: required<HTMLElement>("hudLock"),
  hudPosition: required<HTMLElement>("hudPosition"),
  hudPhrase: required<HTMLElement>("hudPhrase"),
  hudStatus: required<HTMLElement>("hudStatus"),

  dock: required<HTMLElement>("dock"),
  dockTitle: required<HTMLElement>("dockTitle"),
  dockClose: required<HTMLButtonElement>("dockClose"),

  micMode: required<HTMLButtonElement>("micMode"),
  libraryMode: required<HTMLButtonElement>("libraryMode"),
  nowPlayingMode: required<HTMLButtonElement>("nowPlayingMode"),
  micPanel: required<HTMLDivElement>("micPanel"),
  libraryPanel: required<HTMLDivElement>("libraryPanel"),
  nowPlayingPanel: required<HTMLDivElement>("nowPlayingPanel"),

  micStart: required<HTMLButtonElement>("micStart"),
  micDeviceSelect: required<HTMLSelectElement>("micDeviceSelect"),
  micTapDownbeat: required<HTMLButtonElement>("micTapDownbeat"),
  micStatus: required<HTMLDivElement>("micStatus"),
  micFixedBpmEnabled: required<HTMLInputElement>("micFixedBpmEnabled"),
  micFixedBpmValue: required<HTMLInputElement>("micFixedBpmValue"),

  trackList: required<HTMLDivElement>("trackList"),
  showCachedNowPlayingTracks: required<HTMLInputElement>("showCachedNowPlayingTracks"),

  nowPlayingModeState: required<HTMLElement>("nowPlayingModeState"),
  nowPlayingStatus: required<HTMLDivElement>("nowPlayingStatus"),
  nowPlayingProgress: required<HTMLDivElement>("nowPlayingProgress"),
  nowPlayingProgressFill: required<HTMLDivElement>("nowPlayingProgressFill"),
  nowPlayingMeta: required<HTMLDivElement>("nowPlayingMeta"),

  sceneAuto: required<HTMLInputElement>("sceneAuto"),
  scenePicker: required<HTMLDivElement>("scenePicker"),
  palettePicker: required<HTMLDivElement>("palettePicker"),
  renderScale: required<HTMLInputElement>("renderScale"),
  renderScaleValue: required<HTMLElement>("renderScaleValue"),

  laserRoot: required<HTMLDivElement>("laserRoot")
};

const visuals = new VisualSystem(ui.canvas);
const timeline = new AudioTimeline(ui.audioTimeline);
const fileAnalyser = new AudioAnalyser();
const micCapture = new MicCapture();

const MIC_DEVICE_KEY = "p2p.mic.deviceId";
const PALETTE_KEY = "p2p.look.palette";
const SCENE_KEY = "p2p.look.scene";

type LoadedSourceKind = "library" | "now-playing";

interface PreparedTrackSource {
  track: PublicLibraryTrack;
  show: ShowPackage;
  waveformPeaks: number[] | null;
}

interface LibraryStateSnapshot {
  preparedTrack: PreparedTrackSource;
  currentTimeSeconds: number;
  shouldResumePlayback: boolean;
}

let inputMode: RuntimeInputMode = "mic";
let loaded: LoadedTrack | null = null;
let loadedSourceKind: LoadedSourceKind | null = null;
let schedule: ScheduledPhrase[] = [];
let libraryStateSnapshot: LibraryStateSnapshot | null = null;
let primaryLibraryTracks: PublicLibraryTrack[] = [];
let cachedNowPlayingTracks: PublicLibraryTrack[] = [];
let libraryTracks: PublicLibraryTrack[] = [];
let selectedTrackId: string | null = null;
let libraryWaveformPeaks: number[] = [];
let loadedWaveformToken: string | null = null;
let loadRequestId = 0;

let liveAnalyzer: LiveAnalyzer | null = null;
let micDevices: AudioInputDeviceLike[] = [];
let savedMicDeviceId = localStorage.getItem(MIC_DEVICE_KEY) || null;

let activeSceneId = localStorage.getItem(SCENE_KEY) || visualScenes[0].id;
let pinnedSceneId: string | null = null;
let paletteOverrideId: string | null = localStorage.getItem(PALETTE_KEY);
let lastPhraseId: string | null = null;
let lastMicPhraseKey: string | null = null;
let lastMicPaletteId: string | null = null;

let nowPlayingStatus: NowPlayingStatus | null = null;
let nowPlayingSession = createNowPlayingSession();
let nowPlayingFetchError: string | null = null;
let nowPlayingRuntimeNote: string | null = null;
let nowPlayingLoadingShowId: string | null = null;
let nowPlayingLoadingFreshnessKey: string | null = null;
let nowPlayingPreparingShowId: string | null = null;
let nowPlayingPreparingFreshnessKey: string | null = null;
let nowPlayingPreparedTrack: PreparedTrackSource | null = null;
let nowPlayingPreparedFreshnessKey: string | null = null;
let nowPlayingLoadedFreshnessKey: string | null = null;
let nowPlayingPollingStarted = false;
let nowPlayingPrepareRequestId = 0;
let nowPlayingLastCueStartMs: number | null = null;
let nowPlayingCueBoundaryReached = false;
let nowPlayingFallbackStartedAtMs = performance.now();
let nowPlayingFallbackPhraseId: string | null = null;
let cachedTrackRefreshKey: string | null = null;
const nowPlayingPreloadAudio = new Audio();
nowPlayingPreloadAudio.preload = "metadata";

/**
 * Standing show for the microphone path.
 *
 * The output lanes are written against a `ShowPackage`, so live input gets one
 * too rather than a parallel code path.
 */
const liveShow = buildLiveShow();

const laser = new LaserConsole(ui.laserRoot, {
  currentBpm,
  currentShowFrame,
  activeAdvancingPhraseId
});

// ---------------------------------------------------------------- dock

type DockId = "source" | "look" | "output";
let openDock: DockId | null = null;

function setDock(dock: DockId | null): void {
  openDock = openDock === dock ? null : dock;
  ui.dock.hidden = openDock === null;
  document.body.classList.toggle("dock-open", openDock !== null);
  ui.dockTitle.textContent =
    openDock === "source" ? "Source" : openDock === "look" ? "Look" : openDock === "output" ? "Output" : "";
  ui.dock.querySelectorAll<HTMLElement>("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== openDock;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-dock]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.dock === openDock);
  });
  visuals.resize();
  timeline.resize();
}

document.querySelectorAll<HTMLButtonElement>("[data-dock]").forEach((button) => {
  button.addEventListener("click", () => setDock(button.dataset.dock as DockId));
});
ui.dockClose.addEventListener("click", () => setDock(null));

// --------------------------------------------------------------- sources

function isMicMode(): boolean {
  return inputMode === "mic";
}

function setInputMode(mode: RuntimeInputMode): void {
  if (inputMode === "library" && mode !== "library") {
    captureLibraryState();
  }
  if (mode === "now-playing") {
    nowPlayingFallbackStartedAtMs = performance.now();
    nowPlayingFallbackPhraseId = lastPhraseId ?? schedule[0]?.phrase.phrase_id ?? null;
  }
  inputMode = mode;
  ui.micMode.classList.toggle("selected", mode === "mic");
  ui.libraryMode.classList.toggle("selected", mode === "library");
  ui.nowPlayingMode.classList.toggle("selected", mode === "now-playing");
  ui.micPanel.hidden = mode !== "mic";
  ui.libraryPanel.hidden = mode !== "library";
  ui.nowPlayingPanel.hidden = mode !== "now-playing";
  ui.transport.classList.toggle("live", mode === "mic");
  if (mode !== "mic") {
    ui.audio.pause();
  }
  if (mode !== "now-playing") {
    nowPlayingLoadingShowId = null;
    nowPlayingLoadingFreshnessKey = null;
  } else {
    void syncNowPlayingRuntime();
  }
  updateTransportChrome();
}

ui.micMode.addEventListener("click", () => setInputMode("mic"));
ui.libraryMode.addEventListener("click", () => {
  if (inputMode !== "library" && libraryStateSnapshot) {
    void restoreLibraryState();
    return;
  }
  setInputMode("library");
});
ui.nowPlayingMode.addEventListener("click", () => setInputMode("now-playing"));

// ------------------------------------------------------------------- mic

async function startMic(): Promise<void> {
  try {
    await micCapture.start(savedMicDeviceId);
    const analyzer = new LiveAnalyzer(micCapture.sampleRate);
    if (ui.micFixedBpmEnabled.checked) {
      analyzer.setFixedBpm(Number(ui.micFixedBpmValue.value) || 126);
    }
    micCapture.onBlock = (block) => analyzer.push(block.samples, block.time);
    liveAnalyzer = analyzer;
    await refreshMicDevices();
    setInputMode("mic");
  } catch (error) {
    ui.micStatus.textContent = `Mic unavailable: ${
      error instanceof Error ? error.message : "permission denied"
    }`;
  }
  updateTransportChrome();
}

function stopMic(): void {
  micCapture.onBlock = null;
  micCapture.stop();
  liveAnalyzer = null;
  ui.micStatus.textContent = "Mic is idle.";
  updateTransportChrome();
}

async function toggleMic(): Promise<void> {
  if (micCapture.running) {
    stopMic();
    return;
  }
  await startMic();
}

ui.micStart.addEventListener("click", () => void toggleMic());
ui.micTapDownbeat.addEventListener("click", () => {
  liveAnalyzer?.tapDownbeat(micCapture.now());
});
ui.micFixedBpmEnabled.addEventListener("change", () => {
  ui.micFixedBpmValue.disabled = !ui.micFixedBpmEnabled.checked;
  if (ui.micFixedBpmEnabled.checked) {
    liveAnalyzer?.setFixedBpm(Number(ui.micFixedBpmValue.value) || 126);
  } else {
    liveAnalyzer?.clearFixedBpm();
  }
});
ui.micFixedBpmValue.addEventListener("change", () => {
  if (ui.micFixedBpmEnabled.checked) {
    liveAnalyzer?.setFixedBpm(Number(ui.micFixedBpmValue.value) || 126);
  }
});
ui.micDeviceSelect.addEventListener("change", () => {
  savedMicDeviceId = ui.micDeviceSelect.value || null;
  if (savedMicDeviceId) {
    localStorage.setItem(MIC_DEVICE_KEY, savedMicDeviceId);
  } else {
    localStorage.removeItem(MIC_DEVICE_KEY);
  }
  if (micCapture.running) {
    stopMic();
    void startMic();
  }
});

async function refreshMicDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDevices = devices.filter(isAudioInputDevice);
  } catch {
    micDevices = [];
  }
  const resolved = resolvePreferredAudioInput({
    devices: micDevices,
    savedDeviceId: savedMicDeviceId,
    userSelected: savedMicDeviceId !== null
  });
  savedMicDeviceId = resolved;
  ui.micDeviceSelect.replaceChildren(
    ...micDevices.map((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = describeAudioInputDevice(device, index);
      return option;
    })
  );
  if (resolved) {
    ui.micDeviceSelect.value = resolved;
  }
}

// ------------------------------------------------------------------ look

function applySceneSelection(): void {
  ui.scenePicker.querySelectorAll<HTMLButtonElement>("[data-scene]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scene === activeSceneId);
    button.classList.toggle("pinned", button.dataset.scene === pinnedSceneId);
  });
  ui.palettePicker.querySelectorAll<HTMLButtonElement>("[data-palette]").forEach((button) => {
    button.classList.toggle("active", button.dataset.palette === paletteOverrideId);
  });
}

ui.scenePicker.querySelectorAll<HTMLButtonElement>("[data-scene]").forEach((button) => {
  button.addEventListener("click", () => {
    pinnedSceneId = button.dataset.scene ?? null;
    ui.sceneAuto.checked = false;
    if (pinnedSceneId) {
      activeSceneId = pinnedSceneId;
      localStorage.setItem(SCENE_KEY, pinnedSceneId);
      visuals.setScene(pinnedSceneId);
    }
    applySceneSelection();
  });
});
ui.sceneAuto.addEventListener("change", () => {
  if (ui.sceneAuto.checked) {
    pinnedSceneId = null;
  }
  applySceneSelection();
});
ui.palettePicker.querySelectorAll<HTMLButtonElement>("[data-palette]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.dataset.palette ?? null;
    paletteOverrideId = paletteOverrideId === id ? null : id;
    if (paletteOverrideId) {
      localStorage.setItem(PALETTE_KEY, paletteOverrideId);
    } else {
      localStorage.removeItem(PALETTE_KEY);
    }
    applySceneSelection();
  });
});
ui.renderScale.addEventListener("input", () => {
  const scale = Number(ui.renderScale.value) / 100;
  ui.renderScaleValue.textContent = `${ui.renderScale.value}%`;
  visuals.setRenderScale(scale);
});

// ------------------------------------------------------------- transport

ui.playButton.addEventListener("click", async () => {
  if (isMicMode()) {
    await toggleMic();
    return;
  }
  if (!loaded || !loadedSourceKind || !isBrowserAudioTransportSource(loadedSourceKind)) {
    return;
  }
  fileAnalyser.connect(ui.audio);
  await fileAnalyser.resume();
  if (ui.audio.paused) {
    await ui.audio.play();
  } else {
    ui.audio.pause();
  }
  updateTransportChrome();
});

ui.scrub.addEventListener("input", () => {
  if (!loadedSourceKind || !isBrowserAudioTransportSource(loadedSourceKind)) {
    return;
  }
  if (Number.isFinite(ui.audio.duration)) {
    ui.audio.currentTime = Number(ui.scrub.value) * ui.audio.duration;
  }
});

ui.audio.addEventListener("play", updateTransportChrome);
ui.audio.addEventListener("pause", updateTransportChrome);
ui.audio.addEventListener("loadedmetadata", () => {
  if (loaded && loadedSourceKind === "library") {
    schedule = buildPhraseSchedule(loaded.show, ui.audio.duration);
  }
});

ui.fullscreenButton.addEventListener("click", () => void toggleFullscreen());
document.addEventListener("fullscreenchange", () => {
  updateFullscreenButton();
  visuals.resize();
  timeline.resize();
});
window.addEventListener("resize", () => {
  visuals.resize();
  timeline.resize();
});

async function toggleFullscreen(): Promise<void> {
  if (!document.fullscreenEnabled) {
    ui.fullscreenButton.textContent = "n/a";
    return;
  }
  try {
    if (document.fullscreenElement === ui.viewer) {
      await document.exitFullscreen();
    } else {
      await ui.viewer.requestFullscreen();
    }
  } finally {
    updateFullscreenButton();
    visuals.resize();
  }
}

function updateFullscreenButton(): void {
  const active = document.fullscreenElement === ui.viewer;
  ui.fullscreenButton.textContent = active ? "Exit" : "Full";
  ui.fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
  ui.fullscreenButton.setAttribute("aria-pressed", String(active));
}

function updateTransportChrome(): void {
  if (isMicMode()) {
    ui.playButton.textContent = micCapture.running ? "Stop" : "Listen";
    ui.playButton.disabled = false;
    ui.scrub.disabled = true;
    ui.micStart.textContent = micCapture.running ? "Stop listening" : "Start listening";
    ui.nowLabel.textContent = micCapture.running ? "Listening" : "Mic idle";
    ui.nowTime.textContent = "live";
    return;
  }
  if (inputMode === "now-playing" && !isBrowserAudioTransportSource(loadedSourceKind ?? "library")) {
    ui.playButton.textContent = "Synced";
    ui.playButton.disabled = true;
    ui.scrub.disabled = true;
    return;
  }
  ui.playButton.textContent = ui.audio.paused ? "Play" : "Pause";
  ui.playButton.disabled = false;
  ui.scrub.disabled = false;
  ui.nowLabel.textContent = loaded?.libraryTrack.title ?? "No source";
}

// ------------------------------------------------------------ render loop

let lastFrameMs = performance.now();

function renderLoop(nowMs: number): void {
  const delta = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;

  const frame = currentMusicalFrame(nowMs);
  if (frame) {
    visuals.render(frame.musical, nowMs / 1000, delta);
    updateHud(frame);
  }
  requestAnimationFrame(renderLoop);
}

interface MusicalContext {
  musical: MusicalFrame;
  bpm: number;
  bar: number;
  beatInBar: number;
  phraseLabel: string;
  phraseId: string | null;
  energy: number;
  status: string;
  lockLabel: string;
}

function currentMusicalFrame(nowMs: number): MusicalContext | null {
  if (isMicMode()) {
    return micMusicalFrame();
  }
  if (inputMode === "now-playing" && shouldRenderFallbackPreview()) {
    return fallbackMusicalFrame(nowMs);
  }
  return showMusicalFrame();
}

function micMusicalFrame(): MusicalContext | null {
  const analyzer = liveAnalyzer;
  if (!analyzer) {
    return idleFrame("Press Listen to start the microphone.");
  }
  const state = analyzer.snapshot(micCapture.now());
  const energy = (state.energy - 1) / 9;
  const role = roleForPhraseKind(state.phrase.kind);

  const phraseKey = `${state.phrase.kind}:${state.phrase.startBar}`;
  if (phraseKey !== lastMicPhraseKey) {
    lastMicPhraseKey = phraseKey;
    if (ui.sceneAuto.checked) {
      const scene = selectScene(role, energy, activeSceneId);
      activeSceneId = scene.id;
      visuals.setScene(scene.id);
      applySceneSelection();
    }
    lastMicPaletteId = selectVariedFb4Palette({
      eventKey: phraseKey,
      currentPalette: lastMicPaletteId,
      paletteIds: palettes.map((palette) => palette.id)
    });
    laser.notePhraseChange(phraseKey);
  }

  publishLiveLaserFrame(state, phraseKey);

  return {
    musical: {
      beat: state.beatPosition,
      beatPhase: state.beatPhase,
      barPhase: state.barPhase,
      phrasePhase: state.phrasePhase,
      barInPhrase: state.phraseBar,
      energy,
      bands: state.bands,
      paletteId: paletteOverrideId ?? lastMicPaletteId ?? palettes[0].id
    },
    bpm: state.bpm,
    bar: state.bar,
    beatInBar: state.beatInBar,
    phraseLabel: `${capitalize(state.phrase.kind)} · bar ${state.phraseBar + 1}/8`,
    phraseId: phraseKey,
    energy,
    status: state.status,
    lockLabel:
      state.tempoState === "locked"
        ? `lock ${Math.round(state.tempoConfidence * 100)}%`
        : state.tempoState === "listening"
          ? "listening"
          : ""
  };
}

function showMusicalFrame(): MusicalContext | null {
  if (!loaded || !schedule.length) {
    return idleFrame("Choose a track in the Source panel.");
  }
  const seconds = currentPlaybackSeconds();
  if (seconds === null) {
    return idleFrame("Waiting for playback.");
  }
  const bpm = loaded.show.song.tempo;
  const playback = playbackStateAt(schedule, seconds, bpm);
  const phrase = playback.active.phrase;
  const bands = fileAnalyser.snapshot();
  const beat = seconds / (60 / Math.max(bpm, 1));

  if (phrase.phrase_id !== lastPhraseId) {
    notePhraseChange(phrase.phrase_id, performance.now());
  }

  return {
    musical: {
      beat,
      beatPhase: beat - Math.floor(beat),
      barPhase: ((beat % 4) + 4) % 4 / 4,
      phrasePhase: playback.phraseProgress,
      barInPhrase: Math.floor(beat / 4) % 8,
      energy: energyValueForPhrase(phrase),
      bands,
      paletteId: paletteOverrideId ?? phrase.visual_look.palette
    },
    bpm,
    bar: playback.bar,
    // `playback.beat` counts beats from the start of the track; the HUD wants
    // the position inside the bar.
    beatInBar: (((playback.beat - 1) % 4) + 4) % 4 + 1,
    phraseLabel: phrase.name,
    phraseId: phrase.phrase_id,
    energy: energyValueForPhrase(phrase),
    status: "",
    lockLabel: "show"
  };
}

function fallbackMusicalFrame(nowMs: number): MusicalContext | null {
  if (!loaded || !schedule.length) {
    return idleFrame("Now Playing is running a reactive preview.");
  }
  const preview = buildFallbackPreviewState({
    schedule,
    bpm: loaded.show.song.tempo,
    anchorPhraseId: nowPlayingFallbackPhraseId ?? schedule[0]?.phrase.phrase_id ?? null,
    startedAtMs: nowPlayingFallbackStartedAtMs,
    nowMs
  });
  const phrase = preview.playback.active.phrase;
  nowPlayingFallbackPhraseId = phrase.phrase_id;
  if (phrase.phrase_id !== lastPhraseId) {
    notePhraseChange(phrase.phrase_id, nowMs);
  }
  const beat = preview.seconds / (60 / Math.max(loaded.show.song.tempo, 1));
  return {
    musical: {
      beat,
      beatPhase: beat - Math.floor(beat),
      barPhase: ((beat % 4) + 4) % 4 / 4,
      phrasePhase: preview.playback.phraseProgress,
      barInPhrase: Math.floor(beat / 4) % 8,
      energy: energyValueForPhrase(phrase),
      bands: preview.bands,
      paletteId: paletteOverrideId ?? phrase.visual_look.palette
    },
    bpm: loaded.show.song.tempo,
    bar: preview.playback.bar,
    beatInBar: (((preview.playback.beat - 1) % 4) + 4) % 4 + 1,
    phraseLabel: `${phrase.name} · preview`,
    phraseId: phrase.phrase_id,
    energy: energyValueForPhrase(phrase),
    status: "Reactive preview",
    lockLabel: "preview"
  };
}

function idleFrame(status: string): MusicalContext {
  // Keep the visuals breathing at a nominal tempo rather than freezing, so an
  // idle projector still looks intentional.
  const beat = (performance.now() / 1000) * (126 / 60);
  return {
    musical: {
      beat,
      beatPhase: beat - Math.floor(beat),
      barPhase: ((beat % 4) + 4) % 4 / 4,
      phrasePhase: (beat / 32) % 1,
      barInPhrase: Math.floor(beat / 4) % 8,
      energy: 0.38,
      bands: { low: 0.18, mid: 0.2, high: 0.14 },
      paletteId: paletteOverrideId ?? palettes[0].id
    },
    bpm: 0,
    bar: 0,
    beatInBar: 1,
    phraseLabel: "Idle",
    phraseId: null,
    energy: 0.25,
    status,
    lockLabel: ""
  };
}

function notePhraseChange(phraseId: string, nowMs: number): void {
  lastPhraseId = phraseId;
  nowPlayingLastCueStartMs = nowMs;
  nowPlayingCueBoundaryReached = true;
  laser.notePhraseChange(phraseId);
  if (!loaded) {
    return;
  }
  const phrase = loaded.show.phrases.find((entry) => entry.phrase_id === phraseId);
  if (!phrase) {
    return;
  }
  if (ui.sceneAuto.checked) {
    const assigned = loaded.show.phrase_visual_assignments.find(
      (entry) => entry.phrase_id === phraseId
    );
    const sceneId =
      sceneIdForPresetId(assigned?.preset_id) ??
      selectScene(roleForPhrase(phrase), energyValueForPhrase(phrase), activeSceneId).id;
    activeSceneId = sceneId;
    visuals.setScene(sceneId);
    applySceneSelection();
  }
  publishLaserForPhrase(phrase);
}

function updateHud(context: MusicalContext): void {
  ui.hudBpm.textContent = context.bpm > 0 ? context.bpm.toFixed(1) : "--";
  ui.hudLock.textContent = context.lockLabel;
  ui.hudPosition.textContent =
    context.bpm > 0 ? `bar ${context.bar + 1} · ${context.beatInBar}/4` : "--";
  ui.hudPhrase.textContent = context.phraseLabel;
  ui.hudStatus.textContent = context.status;
  if (isMicMode()) {
    ui.micStatus.textContent = context.status || "Listening.";
  }

  if (!isMicMode() && loaded) {
    const seconds = currentPlaybackSeconds() ?? 0;
    const duration = currentPlaybackDuration() ?? 0;
    ui.nowTime.textContent = `${formatTime(seconds)} / ${formatTime(duration)}`;
    ui.nowLabel.textContent = loaded.libraryTrack.title;
    if (duration > 0) {
      ui.scrub.value = String(seconds / duration);
    }
    renderTimeline(context.phraseId);
  }

  // The laser lane runs off the same musical truth as the visuals.
  if (loaded && context.phraseId) {
    const phrase = loaded.show.phrases.find((entry) => entry.phrase_id === context.phraseId);
    if (phrase) {
      laser.publishShowFrame(
        context.phraseId,
        buildShowLaserFrame(loaded.show, phrase, context.musical.phrasePhase),
        performance.now()
      );
    }
  }
}

// --------------------------------------------------------------- timeline

function renderTimeline(activePhraseId: string | null): void {
  if (!loaded || !schedule.length) {
    return;
  }
  const duration = currentPlaybackDuration();
  if (!duration || !libraryWaveformPeaks.length) {
    return;
  }
  timeline.render({
    mode: "known",
    peaks: libraryWaveformPeaks,
    durationSeconds: duration,
    currentSeconds: currentPlaybackSeconds() ?? 0,
    bpm: loaded.show.song.tempo,
    phrases: schedule.map(timelinePhrase),
    activePhraseId
  });
}

function timelinePhrase(entry: ScheduledPhrase): TimelinePhrase {
  return {
    phraseId: entry.phrase.phrase_id,
    name: entry.phrase.name,
    startSeconds: entry.startSeconds,
    endSeconds: entry.endSeconds
  };
}

// ------------------------------------------------------------------ laser

function laserCueForPhrase(show: ShowPackage, phraseId: string): DmxLaserCue | null {
  return show.dmx_laser_cues.find((cue) => cue.phrase_id === phraseId && resolveFb4LaserCueTarget(cue)) ?? null;
}

function buildShowLaserFrame(show: ShowPackage, phrase: Phrase, phraseProgress: number): Fb4Dmx16Frame {
  return buildFb4Dmx16Frame({
    show,
    phrase,
    lightingCue: show.lighting_cues.find((cue) => cue.phrase_id === phrase.phrase_id) ?? null,
    laserCue: laserCueForPhrase(show, phrase.phrase_id),
    allowExperimental39Channel: laser.experimental39Enabled,
    phraseProgress
  });
}

/**
 * Drives the laser lane from live input.
 *
 * Cue variety is keyed on the phrase occurrence so repeated drops in a set do
 * not all fire the same cue, which is the difference between a show and a
 * screensaver.
 */
function publishLiveLaserFrame(state: LiveMusicalState, phraseKey: string): void {
  const phrase = livePhraseFor(liveShow, state.phrase.kind);
  liveShow.song.tempo = state.bpm;
  const frame = buildFb4Dmx16Frame({
    show: liveShow,
    phrase,
    lightingCue: liveShow.lighting_cues.find((cue) => cue.phrase_id === phrase.phrase_id) ?? null,
    laserCue: laserCueForPhrase(liveShow, phrase.phrase_id),
    allowExperimental39Channel: laser.experimental39Enabled,
    phraseProgress: state.phrasePhase,
    paletteOverride: lastMicPaletteId ?? undefined,
    cueSelection: { mode: "variety", rotationOrdinal: Math.max(0, state.phrase.startBar) }
  });
  laser.publishShowFrame(phraseKey, frame, performance.now());
}

function publishLaserForPhrase(phrase: Phrase): void {
  if (!loaded) {
    return;
  }
  laser.publishShowFrame(
    phrase.phrase_id,
    buildShowLaserFrame(loaded.show, phrase, 0),
    performance.now()
  );
}

function currentShowFrame(): Fb4Dmx16Frame | null {
  if (isMicMode() && liveAnalyzer) {
    const state = liveAnalyzer.snapshot(micCapture.now());
    const phrase = livePhraseFor(liveShow, state.phrase.kind);
    return buildFb4Dmx16Frame({
      show: liveShow,
      phrase,
      lightingCue: liveShow.lighting_cues.find((cue) => cue.phrase_id === phrase.phrase_id) ?? null,
      laserCue: laserCueForPhrase(liveShow, phrase.phrase_id),
      allowExperimental39Channel: laser.experimental39Enabled,
      phraseProgress: state.phrasePhase
    });
  }
  if (!loaded || !schedule.length) {
    return null;
  }
  const seconds = currentPlaybackSeconds();
  if (seconds === null) {
    return null;
  }
  const playback = playbackStateAt(schedule, seconds, loaded.show.song.tempo);
  return buildShowLaserFrame(loaded.show, playback.active.phrase, playback.phraseProgress);
}

function activeAdvancingPhraseId(): string | null {
  if (isMicMode()) {
    return micCapture.running ? lastMicPhraseKey : null;
  }
  if (!loaded || ui.audio.paused) {
    return null;
  }
  return lastPhraseId;
}

function currentBpm(): number {
  if (isMicMode() && liveAnalyzer) {
    return liveAnalyzer.currentBpm;
  }
  return loaded?.show.song.tempo ?? 126;
}

// --------------------------------------------------------------- playback

function currentPlaybackSeconds(): number | null {
  if (!loaded || !loadedSourceKind) {
    return null;
  }
  if (isBrowserAudioTransportSource(loadedSourceKind)) {
    return Number.isFinite(ui.audio.currentTime) ? ui.audio.currentTime : 0;
  }
  // A Now Playing deck has no local transport, so the position is projected
  // forward from the last observation the service reported.
  return resolveNowPlayingPlaybackSeconds(nowPlayingStatus, Date.now()) ?? 0;
}

function currentPlaybackDuration(): number | null {
  if (!loaded || !loadedSourceKind) {
    return null;
  }
  if (isBrowserAudioTransportSource(loadedSourceKind)) {
    return Number.isFinite(ui.audio.duration) ? ui.audio.duration : null;
  }
  return resolveNowPlayingPlaybackDurationSeconds(nowPlayingStatus);
}

function shouldRenderFallbackPreview(): boolean {
  return inputMode === "now-playing" && nowPlayingSession.outputMode === "reactive_fallback";
}

// ---------------------------------------------------------------- library

async function boot(): Promise<void> {
  applySceneSelection();
  visuals.setScene(activeSceneId, true);
  updateFullscreenButton();
  updateTransportChrome();
  setInputMode("mic");
  await refreshMicDevices();
  startNowPlayingPolling();

  try {
    const response = await fetch("/api/library");
    const library = (await response.json()) as { tracks: PublicLibraryTrack[] };
    primaryLibraryTracks = library.tracks;
  } catch {
    primaryLibraryTracks = [];
  }
  ui.showCachedNowPlayingTracks.checked =
    localStorage.getItem("p2p.library.showCachedNowPlayingTracks") === "true";
  await refreshCachedNowPlayingTracks();
  syncVisibleLibraryTracks();
}

ui.showCachedNowPlayingTracks.addEventListener("change", () => {
  localStorage.setItem(
    "p2p.library.showCachedNowPlayingTracks",
    String(ui.showCachedNowPlayingTracks.checked)
  );
  syncVisibleLibraryTracks();
});

function syncVisibleLibraryTracks(): void {
  if (!ui.showCachedNowPlayingTracks.checked) {
    libraryTracks = primaryLibraryTracks;
  } else {
    const seen = new Set<string>();
    libraryTracks = [...cachedNowPlayingTracks, ...primaryLibraryTracks].filter((track) => {
      if (seen.has(track.id)) {
        return false;
      }
      seen.add(track.id);
      return true;
    });
  }
  renderTrackList();
}

function renderTrackList(): void {
  if (!libraryTracks.length) {
    ui.trackList.innerHTML = `<div class="empty-state">No compiled shows found.</div>`;
    return;
  }
  ui.trackList.replaceChildren(
    ...libraryTracks.map((track) => {
      const item = document.createElement("div");
      item.className = track.id === selectedTrackId ? "track-card selected" : "track-card";
      item.innerHTML = `
        <button class="track-select" type="button">
          <strong>${escapeHtml(track.title)}</strong>
          <span>${escapeHtml(track.artist ?? track.notes ?? "")}</span>
        </button>
      `;
      item.querySelector<HTMLButtonElement>(".track-select")?.addEventListener("click", () => {
        void loadTrackFromSource(track, "library", "library");
      });
      return item;
    })
  );
}

async function fetchPreparedTrackSource(track: PublicLibraryTrack): Promise<PreparedTrackSource> {
  const response = await fetch(track.showUrl);
  return { track, show: coerceShowPackage(await response.json()), waveformPeaks: null };
}

function applyPreparedTrackSource(
  prepared: PreparedTrackSource,
  sourceKind: LoadedSourceKind,
  freshnessKey: string | null = null
): void {
  loaded = { libraryTrack: prepared.track, show: prepared.show };
  loadedSourceKind = sourceKind;
  schedule = buildPhraseSchedule(prepared.show);
  lastPhraseId = null;
  nowPlayingFallbackStartedAtMs = performance.now();
  nowPlayingFallbackPhraseId = schedule[0]?.phrase.phrase_id ?? null;
  loadedWaveformToken = sourceKind === "now-playing" ? freshnessKey ?? prepared.track.audioUrl : prepared.track.audioUrl;

  if (isBrowserAudioTransportSource(sourceKind)) {
    ui.audio.src = prepared.track.audioUrl;
  } else {
    ui.audio.pause();
    ui.audio.removeAttribute("src");
    ui.audio.load();
  }

  if (prepared.waveformPeaks?.length) {
    libraryWaveformPeaks = prepared.waveformPeaks;
  } else {
    libraryWaveformPeaks = [];
    timeline.clear("Loading waveform.");
    void loadWaveformForSource(prepared.track.audioUrl, loadedWaveformToken);
  }
  updateTransportChrome();
}

async function loadWaveformForSource(audioUrl: string, token: string | null): Promise<void> {
  try {
    const peaks = await loadWaveformPeaks(audioUrl);
    if (loadedWaveformToken === token) {
      libraryWaveformPeaks = peaks;
    }
  } catch {
    if (loadedWaveformToken === token) {
      timeline.clear("Waveform unavailable.");
    }
  }
}

async function activatePreparedTrackSource(
  prepared: PreparedTrackSource,
  sourceKind: LoadedSourceKind,
  mode: "library" | "now-playing",
  options: { autoplay?: boolean; freshnessKey?: string | null } = {}
): Promise<void> {
  setInputMode(mode);
  selectedTrackId = sourceKind === "library" ? prepared.track.id : null;
  renderTrackList();
  applyPreparedTrackSource(prepared, sourceKind, options.freshnessKey ?? null);
  nowPlayingLoadedFreshnessKey = sourceKind === "now-playing" ? options.freshnessKey ?? null : null;

  if (sourceKind === "library") {
    libraryStateSnapshot = {
      preparedTrack: clonePreparedTrackSource(prepared),
      currentTimeSeconds: 0,
      shouldResumePlayback: false
    };
  }
  if (options.autoplay && isBrowserAudioTransportSource(sourceKind)) {
    await tryStartLoadedAudio();
  } else {
    updateTransportChrome();
  }
}

async function loadTrackFromSource(
  track: PublicLibraryTrack,
  sourceKind: LoadedSourceKind,
  mode: "library" | "now-playing",
  options: { autoplay?: boolean; freshnessKey?: string | null; isStillValid?: () => boolean } = {}
): Promise<boolean> {
  const requestId = ++loadRequestId;
  const prepared = await fetchPreparedTrackSource(track);
  if (requestId !== loadRequestId || options.isStillValid?.() === false) {
    return false;
  }
  await activatePreparedTrackSource(prepared, sourceKind, mode, options);
  return true;
}

async function tryStartLoadedAudio(): Promise<void> {
  try {
    fileAnalyser.connect(ui.audio);
    await fileAnalyser.resume();
    await ui.audio.play();
  } catch {
    // Autoplay can be refused until the operator interacts; the transport
    // button remains available.
  }
  updateTransportChrome();
}

function clonePreparedTrackSource(prepared: PreparedTrackSource): PreparedTrackSource {
  return {
    track: { ...prepared.track },
    show: prepared.show,
    waveformPeaks: prepared.waveformPeaks ? [...prepared.waveformPeaks] : null
  };
}

function captureLibraryState(): void {
  if (loadedSourceKind !== "library" || !loaded) {
    return;
  }
  libraryStateSnapshot = {
    preparedTrack: clonePreparedTrackSource({
      track: loaded.libraryTrack,
      show: loaded.show,
      waveformPeaks: libraryWaveformPeaks.length ? [...libraryWaveformPeaks] : null
    }),
    currentTimeSeconds: ui.audio.currentTime,
    shouldResumePlayback: !ui.audio.paused
  };
}

async function restoreLibraryState(): Promise<void> {
  if (!libraryStateSnapshot) {
    setInputMode("library");
    return;
  }
  const snapshot = libraryStateSnapshot;
  await activatePreparedTrackSource(snapshot.preparedTrack, "library", "library");
  await restoreAudioTransport(snapshot.currentTimeSeconds, snapshot.shouldResumePlayback);
}

async function restoreAudioTransport(
  currentTimeSeconds: number,
  shouldResumePlayback: boolean
): Promise<void> {
  const apply = async (): Promise<void> => {
    if (Number.isFinite(currentTimeSeconds)) {
      ui.audio.currentTime = currentTimeSeconds;
    }
    if (shouldResumePlayback) {
      await tryStartLoadedAudio();
      return;
    }
    updateTransportChrome();
  };
  if (Number.isFinite(ui.audio.duration)) {
    await apply();
    return;
  }
  await new Promise<void>((resolve) => {
    ui.audio.addEventListener("loadedmetadata", () => void apply().finally(resolve), { once: true });
  });
}

// ------------------------------------------------------------ now playing

function startNowPlayingPolling(): void {
  if (nowPlayingPollingStarted) {
    return;
  }
  nowPlayingPollingStarted = true;
  void pollNowPlayingLoop();
}

async function pollNowPlayingLoop(): Promise<void> {
  try {
    const status = await fetchNowPlayingStatus();
    nowPlayingStatus = status;
    nowPlayingFetchError = null;
    void refreshCachedNowPlayingTracksIfNeeded(status);
    nowPlayingSession = applyNowPlayingStatus(nowPlayingSession, {
      nowMs: performance.now(),
      status,
      currentPlayback: currentNowPlayingPlayback(),
      lastCueStartMs: nowPlayingLastCueStartMs,
      cueBoundaryReached: nowPlayingCueBoundaryReached
    });
    nowPlayingCueBoundaryReached = false;
    await syncNowPlayingRuntime();
  } catch (error) {
    nowPlayingFetchError = error instanceof Error ? error.message : "Now Playing status failed.";
    renderNowPlayingSurface();
  } finally {
    window.setTimeout(() => void pollNowPlayingLoop(), 1200);
  }
}

function currentNowPlayingPlayback(): NowPlayingPlayback | null {
  if (
    inputMode !== "now-playing" ||
    loadedSourceKind !== "now-playing" ||
    !loaded ||
    !lastPhraseId ||
    nowPlayingSession.activeShowId !== loaded.libraryTrack.id
  ) {
    return null;
  }
  return { showId: loaded.libraryTrack.id, phraseId: lastPhraseId };
}

function readyNowPlayingFreshnessKey(status: NowPlayingStatus | null = nowPlayingStatus): string | null {
  if (!status?.armedShow?.id || !status.armedShow.showUrl || !status.preparedAudio?.audioUrl) {
    return null;
  }
  return JSON.stringify({
    armedShowId: status.armedShow.id,
    showUrl: status.armedShow.showUrl,
    audioPath: status.preparedAudio.path,
    audioUrl: status.preparedAudio.audioUrl,
    preparedDurationSeconds: status.preparedAudio.durationSeconds,
    preparedProvider: status.preparedAudio.provider
  });
}

function readyNowPlayingTrack(): PublicLibraryTrack | null {
  const showUrl = nowPlayingStatus?.armedShow?.showUrl ?? null;
  const audioUrl = nowPlayingStatus?.preparedAudio?.audioUrl ?? null;
  const id = nowPlayingStatus?.armedShow?.id ?? null;
  if (!id || !showUrl || !audioUrl) {
    return null;
  }
  return {
    id,
    title: nowPlayingStatus?.observation?.title ?? id,
    artist: nowPlayingStatus?.observation?.artist ?? null,
    abletonProjectPath: null,
    bpm: null,
    notes: `Prepared via ${nowPlayingStatus?.preparedAudio?.provider ?? "unknown provider"}`,
    audioUrl,
    showUrl,
    exportShowUrl: showUrl
  };
}

function invalidateNowPlayingPreparedTrack(): void {
  nowPlayingPrepareRequestId += 1;
  nowPlayingPreparingShowId = null;
  nowPlayingPreparingFreshnessKey = null;
  nowPlayingPreparedTrack = null;
  nowPlayingPreparedFreshnessKey = null;
  nowPlayingRuntimeNote = null;
  nowPlayingPreloadAudio.removeAttribute("src");
  nowPlayingPreloadAudio.load();
}

function activeLoadedNowPlayingShowId(): string | null {
  if (
    inputMode !== "now-playing" ||
    loadedSourceKind !== "now-playing" ||
    !loaded ||
    nowPlayingSession.outputMode !== "premade_active" ||
    nowPlayingSession.activeShowId !== loaded.libraryTrack.id
  ) {
    return null;
  }
  return loaded.libraryTrack.id;
}

async function syncNowPlayingRuntime(): Promise<void> {
  if (inputMode !== "now-playing") {
    return;
  }
  const readyTrack = readyNowPlayingTrack();
  const readyFreshnessKey = readyNowPlayingFreshnessKey();
  const activeLoadedShowId = activeLoadedNowPlayingShowId();
  const hasReusableActiveLoadedShow =
    !!activeLoadedShowId && (!readyFreshnessKey || nowPlayingLoadedFreshnessKey === readyFreshnessKey);

  if (nowPlayingSession.outputMode === "reactive_fallback") {
    invalidateNowPlayingPreparedTrack();
    nowPlayingLoadingShowId = null;
    nowPlayingLoadingFreshnessKey = null;
    if (loadedSourceKind === "now-playing") {
      ui.audio.pause();
    }
    renderNowPlayingSurface();
    return;
  }

  if (nowPlayingSession.outputMode === "premade_armed") {
    if (!readyTrack || !readyFreshnessKey) {
      invalidateNowPlayingPreparedTrack();
      nowPlayingLoadingShowId = null;
      nowPlayingLoadingFreshnessKey = null;
      renderNowPlayingSurface();
      return;
    }
    if (nowPlayingPreparedTrack && nowPlayingPreparedFreshnessKey !== readyFreshnessKey) {
      invalidateNowPlayingPreparedTrack();
    }
    if (
      nowPlayingPreparedFreshnessKey !== readyFreshnessKey &&
      nowPlayingPreparingFreshnessKey !== readyFreshnessKey
    ) {
      void prepareNowPlayingTrack(readyTrack, readyFreshnessKey);
    }
    renderNowPlayingSurface();
    return;
  }

  if (nowPlayingSession.outputMode !== "premade_active" || hasReusableActiveLoadedShow) {
    renderNowPlayingSurface();
    return;
  }

  const activeShowId = nowPlayingSession.activeShowId;
  if (
    activeShowId &&
    readyTrack &&
    readyFreshnessKey &&
    nowPlayingPreparedTrack &&
    nowPlayingPreparedFreshnessKey === readyFreshnessKey &&
    nowPlayingPreparedTrack.track.id === activeShowId
  ) {
    await activatePreparedTrackSource(nowPlayingPreparedTrack, "now-playing", "now-playing", {
      autoplay: true,
      freshnessKey: readyFreshnessKey
    });
    invalidateNowPlayingPreparedTrack();
    renderNowPlayingSurface();
    return;
  }

  if (!readyTrack || !readyFreshnessKey) {
    invalidateNowPlayingPreparedTrack();
    nowPlayingLoadingShowId = null;
    nowPlayingLoadingFreshnessKey = null;
    renderNowPlayingSurface();
    return;
  }

  if (nowPlayingLoadingShowId === readyTrack.id && nowPlayingLoadingFreshnessKey === readyFreshnessKey) {
    return;
  }

  nowPlayingLoadingShowId = readyTrack.id;
  nowPlayingLoadingFreshnessKey = readyFreshnessKey;
  nowPlayingRuntimeNote = null;
  renderNowPlayingSurface();
  const loadingKey = readyFreshnessKey;
  try {
    const applied = await loadTrackFromSource(readyTrack, "now-playing", "now-playing", {
      autoplay: true,
      freshnessKey: loadingKey,
      isStillValid: () =>
        inputMode === "now-playing" &&
        nowPlayingLoadingShowId === readyTrack.id &&
        nowPlayingLoadingFreshnessKey === loadingKey
    });
    if (nowPlayingLoadingFreshnessKey !== loadingKey || !applied) {
      return;
    }
    invalidateNowPlayingPreparedTrack();
  } catch (error) {
    if (nowPlayingLoadingFreshnessKey !== loadingKey) {
      return;
    }
    nowPlayingRuntimeNote = `Now Playing load failed: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
  } finally {
    if (nowPlayingLoadingShowId === readyTrack.id && nowPlayingLoadingFreshnessKey === loadingKey) {
      nowPlayingLoadingShowId = null;
      nowPlayingLoadingFreshnessKey = null;
    }
    renderNowPlayingSurface();
  }
}

async function prepareNowPlayingTrack(track: PublicLibraryTrack, freshnessKey: string): Promise<void> {
  const requestId = ++nowPlayingPrepareRequestId;
  const isStillValid = (): boolean =>
    requestId === nowPlayingPrepareRequestId && nowPlayingPreparingFreshnessKey === freshnessKey;
  nowPlayingPreparingShowId = track.id;
  nowPlayingPreparingFreshnessKey = freshnessKey;
  try {
    const prepared = await fetchPreparedTrackSource(track);
    if (!isStillValid()) {
      return;
    }
    nowPlayingPreparedTrack = prepared;
    nowPlayingPreparedFreshnessKey = freshnessKey;
    nowPlayingPreloadAudio.src = track.audioUrl;
    nowPlayingPreloadAudio.load();
    void preloadPreparedWaveform(freshnessKey, track.audioUrl);
    nowPlayingRuntimeNote = `Preloaded ${track.title}`;
  } catch (error) {
    if (!isStillValid()) {
      return;
    }
    nowPlayingRuntimeNote = `Preload failed: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    if (isStillValid()) {
      nowPlayingPreparingShowId = null;
      nowPlayingPreparingFreshnessKey = null;
    }
    renderNowPlayingSurface();
  }
}

async function preloadPreparedWaveform(freshnessKey: string, audioUrl: string): Promise<void> {
  try {
    const peaks = await loadWaveformPeaks(audioUrl);
    if (nowPlayingPreparedTrack && nowPlayingPreparedFreshnessKey === freshnessKey) {
      nowPlayingPreparedTrack = { ...nowPlayingPreparedTrack, waveformPeaks: peaks };
    }
  } catch {
    // A missing waveform only costs the timeline drawing, not playback.
  }
}

async function refreshCachedNowPlayingTracks(): Promise<void> {
  try {
    const response = await fetch("/api/now-playing/library");
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { tracks: PublicLibraryTrack[] };
    cachedNowPlayingTracks = payload.tracks;
    syncVisibleLibraryTracks();
  } catch {
    // Keep the current library on transient failures.
  }
}

async function refreshCachedNowPlayingTracksIfNeeded(status: NowPlayingStatus | null): Promise<void> {
  const key = JSON.stringify({
    activeShowId: status?.activeShowId ?? null,
    preparingShowId: status?.preparing?.showId ?? null
  });
  if (key === cachedTrackRefreshKey) {
    return;
  }
  cachedTrackRefreshKey = key;
  await refreshCachedNowPlayingTracks();
}

function renderNowPlayingSurface(): void {
  const stage = nowPlayingStatus?.preparing?.stage ?? null;
  const progress = preparationProgressValue(stage);
  ui.nowPlayingProgress.hidden = progress === null;
  ui.nowPlayingProgressFill.style.width = progress === null ? "0%" : `${Math.round(progress * 100)}%`;
  ui.nowPlayingModeState.textContent = nowPlayingSurfaceLabel();

  if (nowPlayingFetchError) {
    ui.nowPlayingStatus.textContent = `Service offline: ${nowPlayingFetchError}`;
  } else if (nowPlayingStatus?.observation) {
    const artist = nowPlayingStatus.observation.artist ? ` - ${nowPlayingStatus.observation.artist}` : "";
    ui.nowPlayingStatus.textContent = `${nowPlayingStatus.observation.title}${artist}`;
  } else if (nowPlayingStatus?.preparing) {
    ui.nowPlayingStatus.textContent = "Preparing a show for the current track.";
  } else if (nowPlayingRuntimeNote) {
    ui.nowPlayingStatus.textContent = nowPlayingRuntimeNote;
  } else {
    ui.nowPlayingStatus.textContent = "No source app is reporting a ready track.";
  }

  const rows = buildNowPlayingMetaRows({
    status: nowPlayingStatus,
    outputMode: nowPlayingSession.outputMode,
    pendingShowId: nowPlayingSession.pendingShowId,
    preparedTrackId: nowPlayingPreparedTrack?.track.id ?? null,
    runtimeNote: nowPlayingRuntimeNote,
    loadingShowId: nowPlayingLoadingShowId,
    preparingShowId: nowPlayingPreparingShowId
  });
  ui.nowPlayingMeta.hidden = rows.length === 0;
  ui.nowPlayingMeta.replaceChildren(
    ...rows.map((text) => {
      const row = document.createElement("div");
      row.className = "output-row";
      row.textContent = text;
      return row;
    })
  );
}

function nowPlayingSurfaceLabel(): string {
  if (nowPlayingFetchError) {
    return "offline";
  }
  if (nowPlayingSession.outputMode === "premade_active") {
    return "locked show";
  }
  if (
    nowPlayingSession.outputMode === "premade_armed" ||
    nowPlayingLoadingShowId ||
    nowPlayingPreparingShowId ||
    nowPlayingStatus?.preparedAudio
  ) {
    return "preparing";
  }
  return nowPlayingStatus?.observation ? "listening" : "idle";
}

function preparationProgressValue(stage: string | null): number | null {
  switch (stage) {
    case "resolving_audio":
      return 0.2;
    case "caching_audio":
      return 0.45;
    case "analyzing_audio":
      return 0.7;
    case "compiling_show":
      return 0.9;
    default:
      return null;
  }
}

// ----------------------------------------------------------------- debug

/**
 * Automation surface.
 *
 * Used by the end-to-end tests and by `scripts/renderPresetDemo.mjs`, which
 * drives a headless browser to capture scene footage. Kept deliberately small:
 * enough to load a track, hold a scene and move the transport.
 */
declare global {
  interface Window {
    __PHRASE2PHOTON_DEBUG__?: {
      listScenes(): { id: string; name: string; note: string }[];
      setScene(id: string): boolean;
      followTrack(follow: boolean): void;
      loadTrackById(trackId: string): Promise<boolean>;
      seekToSeconds(seconds: number): void;
      play(): Promise<void>;
      pause(): void;
      setRenderScale(scale: number): number;
      state(): {
        inputMode: RuntimeInputMode;
        loadedTrackId: string | null;
        sceneId: string;
        bpm: number;
        phraseId: string | null;
      };
    };
  }
}

window.__PHRASE2PHOTON_DEBUG__ = {
  listScenes: () => visualScenes.map((scene) => ({ id: scene.id, name: scene.name, note: scene.note })),
  setScene(id) {
    if (!visualScenes.some((scene) => scene.id === id)) {
      return false;
    }
    pinnedSceneId = id;
    ui.sceneAuto.checked = false;
    activeSceneId = id;
    visuals.setScene(id, true);
    applySceneSelection();
    return true;
  },
  followTrack(follow) {
    ui.sceneAuto.checked = follow;
    if (follow) {
      pinnedSceneId = null;
    }
    applySceneSelection();
  },
  async loadTrackById(trackId) {
    const track = libraryTracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      return false;
    }
    return loadTrackFromSource(track, "library", "library");
  },
  seekToSeconds(seconds) {
    ui.audio.currentTime = Math.max(0, seconds);
  },
  async play() {
    await tryStartLoadedAudio();
  },
  pause() {
    ui.audio.pause();
  },
  setRenderScale: (scale) => visuals.setRenderScale(scale),
  state: () => ({
    inputMode,
    loadedTrackId: loaded?.libraryTrack.id ?? null,
    sceneId: activeSceneId,
    bpm: currentBpm(),
    phraseId: lastPhraseId
  })
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

void boot();
requestAnimationFrame(renderLoop);
