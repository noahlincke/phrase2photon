import { palettes } from "../graphics/palette.js";
import { visualScenes } from "../graphics/visualScenes.js";
import { escapeHtml } from "./html.js";

/**
 * The application shell.
 *
 * The viewer is the application: it fills the window, and everything else is
 * either a thin transport bar along the bottom or a side dock the operator
 * opens deliberately. The previous shell put three permanent columns around
 * the visuals and left a preset list, a phrase table, a cue strip and the
 * entire laser console on screen at once.
 *
 * Only one dock is open at a time, and it docks rather than floats, so it can
 * stay open through a set without covering the output.
 */

export const SHELL_TEMPLATE = /* html */ `
  <main class="app">
    <section class="viewer" id="viewer">
      <canvas id="visualizer"></canvas>

      <div class="hud" id="hud">
        <div class="hud-tempo">
          <strong id="hudBpm">--</strong>
          <span>BPM</span>
          <em id="hudLock" class="hud-lock"></em>
        </div>
        <div class="hud-line">
          <span id="hudPosition">--</span>
          <span id="hudPhrase">--</span>
        </div>
        <div class="hud-note" id="hudStatus"></div>
      </div>

      <div class="transport" id="transport">
        <button id="playButton" class="primary-button" type="button">Play</button>
        <div class="transport-main">
          <canvas id="audioTimeline" class="audio-timeline" aria-label="Audio timeline"></canvas>
          <input id="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Seek" />
        </div>
        <div class="transport-meta">
          <strong id="nowLabel">No source</strong>
          <span id="nowTime">0:00 / 0:00</span>
        </div>
        <nav class="dock-tabs" aria-label="Panels">
          <button type="button" data-dock="source">Source</button>
          <button type="button" data-dock="look">Look</button>
          <button type="button" data-dock="output">Output</button>
          <button
            id="fullscreenButton"
            class="icon-button"
            type="button"
            aria-label="Open the show output window"
          >
            Show
          </button>
        </nav>
      </div>

      <audio id="audio" preload="metadata"></audio>
    </section>

    <aside class="dock" id="dock" hidden>
      <header class="dock-header">
        <h2 id="dockTitle">Source</h2>
        <button id="dockClose" class="icon-button" type="button" aria-label="Close panel">Close</button>
      </header>

      <div class="dock-body">
        <section data-panel="source" hidden>
          <div class="mode-switch" role="group" aria-label="Audio source">
            <button id="micMode" type="button">Mic</button>
            <button id="libraryMode" type="button">Library</button>
            <button id="nowPlayingMode" type="button">Now Playing</button>
          </div>

          <div id="micPanel" class="panel-group">
            <button id="micStart" class="primary-button wide" type="button">Start listening</button>
            <label class="field-row">
              <span>Input</span>
              <select id="micDeviceSelect" aria-label="Microphone input device"></select>
            </label>
            <button id="micTapDownbeat" class="wide" type="button">Tap downbeat</button>
            <div id="micStatus" class="hint">Mic is idle.</div>
            <details class="subpanel">
              <summary>Tempo override</summary>
              <label class="toggle-row">
                <input id="micFixedBpmEnabled" type="checkbox" />
                <span>Hold a fixed BPM</span>
              </label>
              <label class="field-row">
                <span>BPM</span>
                <input id="micFixedBpmValue" type="number" min="90" max="180" step="1" value="126" disabled />
              </label>
              <p class="hint">
                Use when the detector cannot settle, for example on a long ambient
                passage with no percussion.
              </p>
            </details>
          </div>

          <div id="libraryPanel" class="panel-group" hidden>
            <input
              id="librarySearch"
              class="search-input"
              type="search"
              placeholder="Search shows"
              aria-label="Search the show library"
              autocomplete="off"
            />
            <div id="libraryCount" class="hint"></div>
            <div id="trackList" class="track-list"></div>
            <label class="toggle-row">
              <input id="showCachedNowPlayingTracks" type="checkbox" />
              <span>Include Now Playing cache</span>
            </label>
          </div>

          <div id="nowPlayingPanel" class="panel-group" hidden>
            <div class="meter-row">
              <span>Deck</span>
              <strong id="nowPlayingModeState">offline</strong>
              <span id="nowPlayingPrepareState" class="hint prepare-state"></span>
            </div>
            <div id="nowPlayingStatus" class="hint">Waiting for the Now Playing service.</div>
            <div id="nowPlayingProgress" class="prepare-progress" hidden>
              <div id="nowPlayingProgressFill" class="prepare-progress-fill"></div>
            </div>
            <div id="nowPlayingMeta" class="output-list" hidden></div>
            <button id="nowPlayingRecover" class="wide" type="button">Recover</button>
            <p class="hint">
              Hand the room to the microphone and re-check the source app (shortcut: R).
            </p>
          </div>
        </section>

        <section data-panel="look" hidden>
          <label class="toggle-row accent">
            <input id="sceneAuto" type="checkbox" checked />
            <span>Follow the track</span>
          </label>
          <p class="hint">
            When following, the scene changes with each phrase. Pick one below to
            hold it.
          </p>
          <div id="scenePicker" class="scene-list">
            ${visualScenes
              .map(
                (scene) => `
              <button type="button" class="scene-row" data-scene="${escapeHtml(scene.id)}">
                <strong>${escapeHtml(scene.name)}</strong>
                <small>${escapeHtml(scene.note)}</small>
              </button>`
              )
              .join("")}
          </div>
          <h3>Palette</h3>
          <div id="palettePicker" class="chip-row">
            ${palettes
              .map(
                (palette) => `
              <button type="button" class="chip" data-palette="${escapeHtml(palette.id)}">
                ${escapeHtml(palette.name)}
              </button>`
              )
              .join("")}
          </div>
          <details class="subpanel">
            <summary>Render</summary>
            <label class="field-row">
              <span>Resolution <strong id="renderScaleValue">100%</strong></span>
              <input id="renderScale" type="range" min="35" max="100" step="5" value="100" />
            </label>
            <p class="hint">Lower this if the projector output drops frames.</p>
          </details>
        </section>

        <section data-panel="output" hidden>
          <div id="laserRoot"></div>
        </section>
      </div>
    </aside>
  </main>
`;
