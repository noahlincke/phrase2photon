import { palettes } from "../graphics/palette.js";
import { VisualSystem, type MusicalFrame } from "../graphics/visualSystem.js";
import { visualScenes } from "../graphics/visualScenes.js";

/**
 * Standalone scene preview.
 *
 * Drives the visual system from a synthetic musical clock so scenes can be
 * judged and screenshotted without audio, a show package, or the rest of the
 * app. Query parameters:
 *
 *   ?scene=tunnel&energy=0.8&palette=acid-contrast&bpm=128&t=12
 *   ?grid=1&energy=0.6
 *
 * `t` freezes the clock, which is what makes screenshots comparable between
 * runs; `grid` shows every scene at once, because judging a set one image at a
 * time is how you end up with six things that do not belong together.
 */

const params = new URLSearchParams(window.location.search);
const energy = Number(params.get("energy") ?? 0.6);
const paletteId = params.get("palette") ?? palettes[0].id;
const bpm = Number(params.get("bpm") ?? 128);
const frozenTime = params.has("t") ? Number(params.get("t")) : null;

/** Synthetic musical clock: kick on the beat, hats on the offbeat. */
function musicalFrame(elapsed: number): MusicalFrame {
  const beat = (elapsed * bpm) / 60;
  const beatPhase = beat - Math.floor(beat);
  return {
    beat,
    beatPhase,
    barPhase: beat / 4 - Math.floor(beat / 4),
    phrasePhase: beat / 32 - Math.floor(beat / 32),
    barInPhrase: Math.floor(beat / 4) % 8,
    energy,
    bands: {
      low: Math.pow(1 - beatPhase, 3) * 0.9 + 0.05,
      mid: 0.35 + 0.25 * Math.sin(beat * 0.7),
      high: Math.pow(1 - Math.abs(beatPhase - 0.5) * 2, 4) * 0.7 + 0.1
    },
    paletteId
  };
}

function animate(step: (elapsed: number, delta: number) => void): void {
  const started = performance.now();
  let last = started;
  const tick = (now: number): void => {
    const elapsed = frozenTime ?? (now - started) / 1000;
    const delta = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(elapsed, delta);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderGrid(stage: HTMLDivElement): void {
  stage.innerHTML = "";
  stage.style.gridTemplateColumns = "repeat(3, 1fr)";
  stage.style.gridTemplateRows = "repeat(2, 1fr)";
  stage.style.gap = "2px";
  stage.style.background = "#1a1a1a";

  const systems = visualScenes.map((scene) => {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:relative;min-height:0;min-width:0;";
    const element = document.createElement("canvas");
    element.style.cssText = "width:100%;height:100%;display:block;";
    const label = document.createElement("div");
    label.textContent = `${scene.name}  ·  ${scene.note}`;
    label.style.cssText =
      "position:absolute;left:8px;bottom:6px;right:8px;font:10px ui-monospace,monospace;" +
      "color:#8b95a1;pointer-events:none;";
    wrapper.append(element, label);
    stage.append(wrapper);
    const system = new VisualSystem(element);
    system.setScene(scene.id, true);
    return system;
  });

  animate((elapsed, delta) => {
    const frame = musicalFrame(elapsed);
    for (const system of systems) {
      system.resize();
      system.render(frame, elapsed, delta);
    }
  });
}

function renderSingle(canvas: HTMLCanvasElement, hud: HTMLDivElement): void {
  const system = new VisualSystem(canvas);
  system.setScene(params.get("scene") ?? visualScenes[0].id, true);
  window.addEventListener("resize", () => system.resize());

  animate((elapsed, delta) => {
    const frame = musicalFrame(elapsed);
    system.render(frame, elapsed, delta);
    hud.textContent =
      `scene ${system.activeSceneId}   palette ${paletteId}   energy ${energy.toFixed(2)}\n` +
      `bpm ${bpm}   beat ${frame.beat.toFixed(2)}   bar ${frame.barInPhrase}`;
  });
}

const stage = document.querySelector<HTMLDivElement>("#stage");
const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
const hud = document.querySelector<HTMLDivElement>("#hud");
if (!stage || !canvas || !hud) {
  throw new Error("Missing preview elements.");
}

if (params.has("grid")) {
  hud.remove();
  renderGrid(stage);
} else {
  renderSingle(canvas, hud);
}
