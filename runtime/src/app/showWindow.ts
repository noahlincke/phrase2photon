import { VisualSystem, type MusicalFrame } from "../graphics/visualSystem.js";
import { createShowChannel, type ShowMessage } from "./showLink.js";

/**
 * The pop-out show output window.
 *
 * Deliberately contains nothing but the render: no readout, no transport, no
 * panel. It exists to be dragged onto a projector and made fullscreen, and
 * anything drawn over it would end up on the wall.
 *
 * It renders continuously from the last musical state the control window
 * broadcast, rather than drawing only when a message arrives. A dropped or
 * throttled message then costs a little timing accuracy instead of a frozen
 * frame on the wall.
 */

const canvas = document.querySelector<HTMLCanvasElement>("#output");
const hint = document.querySelector<HTMLDivElement>("#hint");
if (!canvas || !hint) {
  throw new Error("Missing show window elements.");
}

const visuals = new VisualSystem(canvas);
const channel = createShowChannel();

/** Idle state used until the control window sends its first frame. */
let latest: MusicalFrame = {
  beat: 0,
  beatPhase: 0,
  barPhase: 0,
  phrasePhase: 0,
  barInPhrase: 0,
  energy: 0.38,
  bands: { low: 0.18, mid: 0.2, high: 0.14 },
  paletteId: "smoke-cool"
};
let latestElapsed = 0;
let receivedFrame = false;

channel?.addEventListener("message", (event: MessageEvent<ShowMessage>) => {
  const message = event.data;
  if (message.type !== "frame") {
    return;
  }
  latest = message.frame;
  latestElapsed = message.elapsedSeconds;
  if (visuals.activeSceneId !== message.sceneId) {
    visuals.setScene(message.sceneId);
  }
  if (!receivedFrame) {
    receivedFrame = true;
    hint.classList.add("hidden");
    document.body.classList.add("playing");
    window.setTimeout(() => hint.remove(), 500);
  }
});

// Announce arrival so the control window can start broadcasting immediately
// rather than at its next scene change.
channel?.postMessage({ type: "hello" });
window.addEventListener("beforeunload", () => channel?.postMessage({ type: "closed" }));
window.addEventListener("resize", () => visuals.resize());

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Fullscreen can be refused; the window is still usable maximised.
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "f" || event.key === "F") {
    void toggleFullscreen();
  }
  if (event.key === "Escape" && document.fullscreenElement) {
    void document.exitFullscreen();
  }
});
document.addEventListener("dblclick", () => void toggleFullscreen());
document.addEventListener("fullscreenchange", () => visuals.resize());

let previous = performance.now();
function render(now: number): void {
  const delta = Math.min(0.1, (now - previous) / 1000);
  previous = now;
  // Advance the clock locally between messages so motion stays smooth even if
  // the control window's timers are being throttled in the background.
  latestElapsed += delta;
  visuals.render(latest, latestElapsed, delta);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
