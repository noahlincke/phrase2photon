import {
  applyCatalogOverride,
  describeFb4Cue,
  fb4CueCatalog,
  type Fb4CueCatalogEntry,
  type Fb4CueCatalogOverride
} from "../dmx/fb4CueCatalog.js";
import { fb4ProjectorColorProfile, type Fb4LaserColorSlot } from "../dmx/fb4LaserColorProfile.js";
import {
  buildFb4ColorModeFrame,
  buildFb4ColorScrollFrame,
  buildFb4CueControlFrame,
  buildFb4CueFrame,
  buildFb4FadeOverlayFrame,
  buildFb4LegacyCueFrame,
  buildFb4ZoneFrame,
  fb4CueRequires39Channel,
  type Fb4CueFavouritePools,
  type Fb4CuePoolId,
  type Fb4Dmx16Frame
} from "../dmx/fb4Dmx16.js";
import { applyRekordboxLineFaderMute } from "../dmx/rekordboxGate.js";
import { escapeHtml } from "./html.js";

/**
 * The FB4 laser output console.
 *
 * Extracted from the app shell so the output lane is a component with a stated
 * interface rather than nine hundred lines threaded through the same module as
 * playback and rendering.
 *
 * The layout puts the controls an operator touches mid-set - enable, blackout,
 * dimmer on/off, colour - permanently in reach, and files calibration, the cue
 * catalogue and the debug sweeps behind disclosures. Those are setup tools; a
 * wall of sixty-eight cue buttons is not something anyone needs open while
 * playing.
 */

export interface LaserConsoleDeps {
  currentBpm(): number;
  /** The frame the running show would emit now, or null when stopped. */
  currentShowFrame(): Fb4Dmx16Frame | null;
  /** The phrase currently advancing, or null when the transport is stopped. */
  activeAdvancingPhraseId(): string | null;
  /** Replaces the favourite pools the automatic cue selector reads. */
  setFavouriteCues(favourites: Fb4CueFavouritePools): void;
}

const FAVOURITE_POOLS: { id: Fb4CuePoolId; label: string }[] = [
  { id: "open", label: "O" },
  { id: "driving", label: "D" },
  { id: "impact", label: "I" },
  { id: "balanced", label: "B" }
];

type LaserColorSlot = Fb4LaserColorSlot;
type FrameSource = "show" | "overlay";

interface PersistentCueOverride {
  phraseId: string;
  frame: Fb4Dmx16Frame;
}

const STORAGE = {
  enabled: "p2p.dmx.enabled",
  experimental39: "p2p.dmx.experimental39",
  host: "p2p.dmx.host",
  universe: "p2p.dmx.universe",
  brightnessOverride: "p2p.dmx.brightnessOverride",
  brightnessOn: "p2p.dmx.brightnessOn",
  beatLooks: "p2p.dmx.beatLooks",
  dimmerFades: "p2p.dmx.dimmerFades",
  latencyMs: "p2p.dmx.latencyMs",
  geometryOverride: "p2p.dmx.geometryOverride",
  rekordboxMute: "p2p.dmx.rekordboxLineFaderMute",
  holdForever: "p2p.dmx.debugHoldForever",
  catalogMode: "p2p.dmx.cueCatalogMode",
  hideUnreachable: "p2p.dmx.hideUnreachableCues",
  favouritesOnly: "p2p.dmx.favouritesOnly",
  catalogPage: "p2p.dmx.cueCatalogPage",
  catalogOverrides: "p2p.dmx.cueCatalog",
  calibration: "p2p.dmx.laserColorCalibration"
} as const;

const GEOMETRY_SLIDERS = [
  { key: "sizeX", label: "Size X", fallback: "192" },
  { key: "sizeY", label: "Size Y", fallback: "192" },
  { key: "positionX", label: "Pos X", fallback: "128" },
  { key: "positionY", label: "Pos Y", fallback: "128" },
  { key: "angle", label: "Angle", fallback: "128" },
  { key: "visible", label: "Visible", fallback: "255" },
  { key: "scan", label: "Scan", fallback: "240" }
] as const;

type GeometryKey = (typeof GEOMETRY_SLIDERS)[number]["key"];

export class LaserConsole {
  private readonly root: HTMLElement;
  private readonly deps: LaserConsoleDeps;

  private catalogOverrides: Record<string, Fb4CueCatalogOverride>;
  private favourites: Fb4CueFavouritePools = {};
  private calibration: LaserColorSlot[];
  private selectedPage: number;

  private lastBaseFrame: Fb4Dmx16Frame | null = null;
  private lastSource: FrameSource | null = null;
  private persistentOverride: PersistentCueOverride | null = null;
  private overlayHoldUntil = 0;
  private overlayHoldForever = false;
  private sequenceRunning = false;
  private statusNoticeUntil = 0;
  private lastCueRenderKey: string | null = null;
  private lastSentAt = 0;
  private mixerHighestFader: number | null = null;
  private mixerPollingStarted = false;

  private element!: Record<string, HTMLElement>;

  constructor(root: HTMLElement, deps: LaserConsoleDeps) {
    this.root = root;
    this.deps = deps;
    this.catalogOverrides = loadCatalogOverrides();
    this.calibration = loadCalibration();
    this.selectedPage = loadSelectedPage();
    this.mount();
  }

  // -------------------------------------------------------------- lifecycle

  private mount(): void {
    this.root.innerHTML = TEMPLATE;
    this.element = Object.fromEntries(
      [...this.root.querySelectorAll<HTMLElement>("[data-laser]")].map((node) => [
        node.dataset.laser as string,
        node
      ])
    );
    this.restoreSettings();
    this.bindEvents();
    this.renderReach();
    this.renderCalibration();
    this.renderCatalog();
    this.startMixerPolling();
    void this.loadFavourites();
  }

  private input(name: string): HTMLInputElement {
    return this.element[name] as HTMLInputElement;
  }

  private select(name: string): HTMLSelectElement {
    return this.element[name] as HTMLSelectElement;
  }

  private restoreSettings(): void {
    // Live output never restores as enabled: a page reload should not start
    // driving a laser without the operator saying so.
    this.input("enabled").checked = false;
    this.input("experimental39").checked = localStorage.getItem(STORAGE.experimental39) === "true";
    this.input("host").value = localStorage.getItem(STORAGE.host) || "127.0.0.1";
    this.input("universe").value = localStorage.getItem(STORAGE.universe) || "0";
    this.input("brightnessOverride").checked = localStorage.getItem(STORAGE.brightnessOverride) === "true";
    this.input("beatLooks").checked = localStorage.getItem(STORAGE.beatLooks) !== "false";
    this.input("dimmerFades").checked = localStorage.getItem(STORAGE.dimmerFades) !== "false";
    this.input("latencyMs").value = localStorage.getItem(STORAGE.latencyMs) || "0";
    this.element.latencyValue.textContent = this.input("latencyMs").value;
    this.input("rekordboxMute").checked = localStorage.getItem(STORAGE.rekordboxMute) === "true";
    this.input("brightnessOn").checked = localStorage.getItem(STORAGE.brightnessOn) !== "false";
    this.input("geometryOverride").checked = localStorage.getItem(STORAGE.geometryOverride) === "true";
    this.input("holdForever").checked = localStorage.getItem(STORAGE.holdForever) === "true";
    this.input("catalogMode").checked = localStorage.getItem(STORAGE.catalogMode) === "true";
    this.input("hideUnreachable").checked = localStorage.getItem(STORAGE.hideUnreachable) !== "false";
    this.input("favouritesOnly").checked = localStorage.getItem(STORAGE.favouritesOnly) === "true";
    for (const slider of GEOMETRY_SLIDERS) {
      const input = this.input(slider.key);
      input.value = localStorage.getItem(`p2p.dmx.${slider.key}`) || slider.fallback;
      this.element[`${slider.key}Value`].textContent = input.value;
    }
    this.setStatus(
      this.input("experimental39").checked
        ? "Preview only. Enable Art-Net to send."
        : "Preview only. 39-channel cue targeting is off."
    );
  }

  private bindEvents(): void {
    const persistToggle = (name: string, key: string): void => {
      this.input(name).addEventListener("change", () => {
        localStorage.setItem(key, String(this.input(name).checked));
      });
    };

    this.input("enabled").addEventListener("change", () => {
      if (!this.input("enabled").checked) {
        this.setStatus("Preview only.");
      }
      void this.republish();
    });
    this.input("experimental39").addEventListener("change", () => {
      localStorage.setItem(STORAGE.experimental39, String(this.input("experimental39").checked));
      this.renderReach();
      this.renderCatalog();
      void this.republish();
    });
    this.input("hideUnreachable").addEventListener("change", () => {
      localStorage.setItem(STORAGE.hideUnreachable, String(this.input("hideUnreachable").checked));
      this.renderCatalog();
    });
    this.input("favouritesOnly").addEventListener("change", () => {
      localStorage.setItem(STORAGE.favouritesOnly, String(this.input("favouritesOnly").checked));
      this.renderCatalog();
    });
    this.input("host").addEventListener("change", () => {
      localStorage.setItem(STORAGE.host, this.input("host").value);
      void this.republish();
    });
    this.input("universe").addEventListener("change", () => {
      localStorage.setItem(STORAGE.universe, this.input("universe").value);
      void this.republish();
    });
    persistToggle("brightnessOverride", STORAGE.brightnessOverride);
    persistToggle("brightnessOn", STORAGE.brightnessOn);
    persistToggle("beatLooks", STORAGE.beatLooks);
    persistToggle("dimmerFades", STORAGE.dimmerFades);
    persistToggle("geometryOverride", STORAGE.geometryOverride);
    persistToggle("rekordboxMute", STORAGE.rekordboxMute);
    persistToggle("holdForever", STORAGE.holdForever);

    this.input("latencyMs").addEventListener("change", () => {
      localStorage.setItem(STORAGE.latencyMs, this.input("latencyMs").value);
      this.element.latencyValue.textContent = this.input("latencyMs").value;
      void this.republish();
    });

    for (const slider of GEOMETRY_SLIDERS) {
      this.input(slider.key).addEventListener("input", () => {
        const value = this.input(slider.key).value;
        this.element[`${slider.key}Value`].textContent = value;
        localStorage.setItem(`p2p.dmx.${slider.key}`, value);
      });
    }

    this.element.blackout.addEventListener("click", () => {
      void this.publishOverlay(buildFb4CueControlFrame("blackout", this.deps.currentBpm()));
    });
    this.element.releaseHold.addEventListener("click", () => {
      void this.releaseHold();
    });
    this.element.cueOne.addEventListener("click", () => {
      void this.publishOverlay(this.named(buildFb4CueControlFrame("cue-1", this.deps.currentBpm())));
    });
    this.element.zoneFrame.addEventListener("click", () => {
      void this.publishOverlay(buildFb4ZoneFrame(this.deps.currentBpm()), 120_000);
    });
    this.element.cueSweep.addEventListener("click", () => {
      void this.runSequence(
        [1, 2, 3, 4, 5, 6, 7, 8].map((cue) => this.named(buildFb4CueFrame(cue, this.deps.currentBpm())))
      );
    });
    this.element.fadeTest.addEventListener("click", () => {
      void this.runSequence(
        [0, 64, 128, 192, 255, 128].map((dimmer) =>
          buildFb4FadeOverlayFrame(dimmer, this.deps.currentBpm())
        )
      );
    });
    this.element.colorOriginal.addEventListener("click", () => {
      void this.publishOverlay(buildFb4ColorModeFrame(this.colorBaseFrame(), "original"));
    });
    this.element.colorWhite.addEventListener("click", () => {
      void this.publishOverlay(buildFb4ColorModeFrame(this.colorBaseFrame(), "white"));
    });

    this.root.querySelectorAll<HTMLButtonElement>("[data-swatch]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = Number(button.dataset.swatch);
        void this.publishOverlay(
          buildFb4ColorScrollFrame(this.colorBaseFrame(), value, button.dataset.swatchName ?? "Colour")
        );
      });
    });

    this.select("colorSlot").addEventListener("change", () => {
      this.renderCalibration(this.select("colorSlot").value);
    });
    this.input("colorSlider").addEventListener("input", () => {
      this.element.colorValue.textContent = this.input("colorSlider").value;
    });
    this.element.saveColor.addEventListener("click", () => this.saveSelectedColor());
    this.element.holdColor.addEventListener("click", () => {
      const slot = this.selectedColorSlot();
      if (slot) {
        void this.publishOverlay(
          buildFb4ColorScrollFrame(this.colorBaseFrame(), slot.channel15, slot.observedName || slot.name),
          120_000
        );
      }
    });
    this.input("importColor").addEventListener("change", () => void this.importCalibration());

    this.input("catalogMode").addEventListener("change", () => {
      localStorage.setItem(STORAGE.catalogMode, String(this.input("catalogMode").checked));
      this.renderCatalog();
    });
    this.element.exportCatalog.addEventListener("click", () => void this.exportCatalog());
  }

  // ----------------------------------------------------------------- public

  /** Whether 39-channel cue addressing is enabled; frame building needs it. */
  get experimental39Enabled(): boolean {
    return this.input("experimental39").checked;
  }

  /** Whether beat-timed looks (drop hits, build ramps, accents) run on show frames. */
  get beatLooksEnabled(): boolean {
    return this.input("beatLooks").checked;
  }

  /** Whether looks may use dimmer fades as variety accents (strict 0/255 when off). */
  get dimmerFadesEnabled(): boolean {
    return this.input("dimmerFades").checked;
  }

  /** Output latency compensation in ms; beat-timed events fire this much early. */
  get latencyCompensationMs(): number {
    return Number.parseInt(this.input("latencyMs").value, 10) || 0;
  }

  /**
   * How much of the catalogue the current addressing mode can actually select.
   *
   * In 16-channel mode the FB4 takes one coarse page byte and one coarse cue
   * byte, which tops out at nine pages of 48 cues. The content pack is
   * organised by artwork family instead - four families of 240 - so most of it
   * simply has no 16-channel address. Saying so beats greying out a thousand
   * rows with no explanation.
   */
  private reachSummary(): { reachable: number; total: number } {
    const entries = this.catalogEntries();
    return {
      reachable: entries.filter((entry) => !fb4CueRequires39Channel(entry.page, entry.cue)).length,
      total: entries.length
    };
  }

  private renderReach(): void {
    const { reachable, total } = this.reachSummary();
    this.element.reach.textContent = this.experimental39Enabled
      ? `All ${total} cues addressable. The FB4 must be set to its 39-channel personality.`
      : `${reachable} of ${total} cues addressable in 16-channel mode. ` +
        `Switch the FB4 to its 39-channel personality and enable this to reach the rest.`;
  }

  /**
   * Publishes a show frame, respecting any cue the operator has pinned to the
   * current phrase and any debug hold in effect.
   */
  publishShowFrame(phraseId: string, frame: Fb4Dmx16Frame, nowMs: number): void {
    // 40 fps: beat looks chop the dimmer on sixteenth notes, which at show
    // tempos needs well under the old ~8 fps ceiling to stay on the beat.
    if (this.sequenceRunning || nowMs < this.overlayHoldUntil || nowMs - this.lastSentAt <= 25) {
      return;
    }
    this.lastSentAt = nowMs;
    const pinned =
      this.persistentOverride && this.persistentOverride.phraseId === phraseId
        ? this.persistentOverride.frame
        : frame;
    void this.publish(pinned, "show");
  }

  /** Clears a pinned cue when playback leaves the phrase it was pinned to. */
  notePhraseChange(phraseId: string | null): void {
    if (this.persistentOverride && this.persistentOverride.phraseId !== phraseId) {
      this.persistentOverride = null;
    }
  }

  // ------------------------------------------------------------- publishing

  private async publish(
    frame: Fb4Dmx16Frame,
    source: FrameSource,
    holdMs = 0,
    holdForever = false
  ): Promise<void> {
    if (frame.profile === "pangolin-fb4-dmx39" && !this.experimental39Enabled) {
      this.setStatus("39-channel cue targeting is disabled.");
      return;
    }
    this.lastBaseFrame = frame;
    this.lastSource = source;

    const output = applyRekordboxLineFaderMute(
      this.applyGeometry(this.applyBrightness(this.applyCalibration(frame))),
      this.input("rekordboxMute").checked,
      this.mixerHighestFader
    );
    this.renderChannels(output);
    this.renderCurrentCue(output, source);

    const enabled = this.input("enabled").checked;
    const host = this.input("host").value.trim() || "127.0.0.1";
    const universe = Number.parseInt(this.input("universe").value, 10) || 0;

    let result: { ok: boolean; lastFrame?: { sent: boolean; error: string | null } };
    try {
      const response = await fetch("/api/dmx/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          host,
          universe,
          channels: output.channels,
          profile: output.profile,
          palette: output.palette,
          source,
          holdMs,
          holdForever
        })
      });
      result = (await response.json()) as typeof result;
    } catch {
      this.setStatus("Preview active; output service reconnecting.", 0);
      return;
    }
    if (!result.ok || result.lastFrame?.error) {
      this.setStatus(`Error: ${result.lastFrame?.error ?? "unknown"}`, 0);
      return;
    }
    if (performance.now() < this.statusNoticeUntil) {
      return;
    }
    const prefix = source === "overlay" ? "Overlay" : "Show";
    this.setStatus(
      enabled
        ? `${prefix} sent to ${host} universe ${universe}`
        : `${prefix} preview: ${output.palette}, ${output.colorMode}`,
      0
    );
  }

  private async publishOverlay(frame: Fb4Dmx16Frame, holdMs = 1600): Promise<void> {
    this.persistentOverride = null;
    this.overlayHoldForever = this.input("holdForever").checked;
    this.overlayHoldUntil = this.overlayHoldForever
      ? Number.POSITIVE_INFINITY
      : performance.now() + holdMs;
    await this.publish(frame, "overlay", holdMs, this.overlayHoldForever);
  }

  private async republish(): Promise<void> {
    if (!this.lastBaseFrame || !this.lastSource) {
      return;
    }
    if (this.lastSource === "overlay") {
      const remaining = this.overlayHoldForever
        ? 0
        : Math.max(0, Math.ceil(this.overlayHoldUntil - performance.now()));
      await this.publish(this.lastBaseFrame, "overlay", remaining, this.overlayHoldForever);
      return;
    }
    await this.publish(this.lastBaseFrame, "show");
  }

  private async releaseHold(): Promise<void> {
    this.persistentOverride = null;
    this.overlayHoldForever = false;
    this.overlayHoldUntil = 0;
    try {
      await fetch("/api/dmx/hold/release", { method: "POST" });
      this.setStatus("Hold released.");
    } catch {
      this.setStatus("Hold release pending; output service reconnecting.");
    }
  }

  private async runSequence(frames: Fb4Dmx16Frame[]): Promise<void> {
    if (this.sequenceRunning) {
      return;
    }
    this.sequenceRunning = true;
    this.overlayHoldForever = false;
    this.setSequenceButtonsDisabled(true);
    try {
      for (const frame of frames) {
        this.overlayHoldUntil = performance.now() + 1600;
        await this.publish(frame, "overlay", 1600);
        await delay(350);
      }
    } finally {
      this.sequenceRunning = false;
      this.setSequenceButtonsDisabled(false);
      this.overlayHoldUntil = performance.now() + 1200;
    }
  }

  private setSequenceButtonsDisabled(disabled: boolean): void {
    for (const name of ["blackout", "cueOne", "zoneFrame", "cueSweep", "fadeTest", "colorOriginal", "colorWhite"]) {
      (this.element[name] as HTMLButtonElement).disabled = disabled;
    }
  }

  private colorBaseFrame(): Fb4Dmx16Frame {
    if (this.lastBaseFrame && this.lastBaseFrame.channels.some((value) => value > 0)) {
      return this.lastBaseFrame;
    }
    return this.deps.currentShowFrame() ?? buildFb4CueControlFrame("cue-1", this.deps.currentBpm());
  }

  // ----------------------------------------------------------- frame tweaks

  /** Full-or-off dimmer override: the FB4 owns brightness, we only switch. */
  private applyBrightness(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
    if (!this.input("brightnessOverride").checked) {
      return frame;
    }
    const channels = [...frame.channels];
    channels[frame.profile === "pangolin-fb4-dmx39" ? 16 : 4] = this.input("brightnessOn").checked ? 255 : 0;
    return { ...frame, channels };
  }

  private applyGeometry(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
    if (!this.input("geometryOverride").checked) {
      return frame;
    }
    const channels = [...frame.channels];
    const byte = (key: GeometryKey): number =>
      Math.max(0, Math.min(255, Number.parseInt(this.input(key).value, 10) || 0));
    if (frame.profile === "pangolin-fb4-dmx39") {
      write16Bit(channels, 19, byte("sizeX"));
      write16Bit(channels, 21, byte("sizeY"));
      write16Bit(channels, 23, byte("angle"));
      write16Bit(channels, 27, byte("positionX"));
      write16Bit(channels, 29, byte("positionY"));
      const visible = 255 - byte("visible");
      channels[36] = visible;
      channels[37] = visible;
      channels[31] = byte("scan");
    } else {
      channels[6] = byte("sizeX");
      channels[7] = byte("sizeY");
      channels[8] = byte("angle");
      channels[9] = byte("positionX");
      channels[10] = byte("positionY");
      channels[11] = byte("visible");
      channels[12] = byte("scan");
    }
    return { ...frame, channels };
  }

  private applyCalibration(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
    const slot = this.calibration.find((entry) => entry.id === frame.palette);
    if (!slot) {
      return frame;
    }
    const colorLabel = slot.observedName.trim() || slot.name;
    if (frame.profile === "pangolin-fb4-dmx39") {
      const calibrated = buildFb4ColorScrollFrame(frame, slot.channel15, colorLabel);
      return { ...calibrated, label: frame.label, colorLabel };
    }
    const channels = [...frame.channels];
    channels[14] = clampByte(slot.channel15);
    return {
      ...frame,
      colorMode: channels[14] >= 225 ? "white" : "color-scroll",
      colorLabel,
      colorValue: channels[14],
      channels
    };
  }

  // -------------------------------------------------------------- rendering

  private setStatus(message: string, holdMs = 2400): void {
    if (holdMs > 0) {
      this.statusNoticeUntil = performance.now() + holdMs;
    }
    this.element.status.textContent = message;
  }

  private renderChannels(frame: Fb4Dmx16Frame): void {
    this.element.channels.replaceChildren(
      ...frame.channels.map((value, index) => {
        const cell = document.createElement("div");
        cell.className = "dmx-channel";
        cell.innerHTML = `<span>${index + 1}</span><strong>${value}</strong>`;
        cell.title = frame.labels[index] ?? `Channel ${index + 1}`;
        return cell;
      })
    );
  }

  private renderCurrentCue(frame: Fb4Dmx16Frame, source: FrameSource): void {
    const entry = this.catalogEntryFor(frame.page, frame.cue);
    const cueName = entry?.name ?? frame.cueShape ?? (frame.cue > 0 ? `cue ${frame.cue}` : "blackout");
    const eyebrow = this.overlayHoldForever ? "Held" : source === "show" ? "Show" : "Overlay";
    const key = `${eyebrow}|${frame.page}|${frame.cue}|${cueName}|${entry?.thumbnailPath ?? ""}`;
    if (key !== this.lastCueRenderKey) {
      this.lastCueRenderKey = key;
      const label = document.createElement("span");
      label.textContent = eyebrow;
      const title = document.createElement("strong");
      title.textContent = `P${frame.page} C${frame.cue} · ${cueName}`;
      const body = document.createElement("div");
      body.className = "current-cue-body";
      if (entry?.thumbnailPath) {
        body.append(thumbnail(entry, "current-cue-thumbnail"));
      }
      body.append(title);
      this.element.currentCue.replaceChildren(label, body);
    }
  }

  private renderCalibration(selectedId = this.select("colorSlot").value || this.calibration[0]?.id): void {
    this.select("colorSlot").replaceChildren(
      ...this.calibration.map((slot) => {
        const option = document.createElement("option");
        option.value = slot.id;
        option.textContent = slot.name;
        return option;
      })
    );
    const selected = this.calibration.find((slot) => slot.id === selectedId) ?? this.calibration[0];
    if (selected) {
      this.select("colorSlot").value = selected.id;
      this.input("colorLabel").value = selected.observedName;
      this.input("colorSlider").value = String(selected.channel15);
      this.element.colorValue.textContent = String(selected.channel15);
    }
    this.element.colorProfile.textContent = fb4ProjectorColorProfile.profileName;
    this.updateExportHref();
  }

  private selectedColorSlot(): LaserColorSlot | null {
    const selected = this.calibration.find((slot) => slot.id === this.select("colorSlot").value);
    if (!selected) {
      return null;
    }
    return {
      ...selected,
      observedName: this.input("colorLabel").value.trim() || selected.name,
      channel15: clampByte(Number.parseInt(this.input("colorSlider").value, 10) || 0)
    };
  }

  private saveSelectedColor(): void {
    const selected = this.selectedColorSlot();
    if (!selected) {
      return;
    }
    this.calibration = this.calibration.map((slot) => (slot.id === selected.id ? selected : slot));
    localStorage.setItem(STORAGE.calibration, JSON.stringify({ version: 1, slots: this.calibration }));
    this.renderCalibration(selected.id);
    this.setStatus(`Saved ${selected.name} at ${selected.channel15}`);
  }

  private updateExportHref(): void {
    const payload = {
      version: 1,
      fixture: "pangolin-fb4-dmx16",
      profileId: fb4ProjectorColorProfile.profileId,
      profileName: fb4ProjectorColorProfile.profileName,
      exportedAt: new Date().toISOString(),
      channel: 15,
      slots: this.calibration
    };
    (this.element.exportColor as HTMLAnchorElement).href =
      `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(payload, null, 2)}\n`)}`;
  }

  private async importCalibration(): Promise<void> {
    const file = this.input("importColor").files?.[0];
    if (!file) {
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as { slots?: unknown };
      const imported = normalizeCalibration(parsed.slots);
      if (!imported.length) {
        throw new Error("no valid slots");
      }
      this.calibration = mergeCalibration(imported);
      localStorage.setItem(STORAGE.calibration, JSON.stringify({ version: 1, slots: this.calibration }));
      this.renderCalibration(imported[0]?.id);
      this.setStatus(`Imported ${imported.length} slots`);
    } catch (error) {
      this.setStatus(`Import failed: ${error instanceof Error ? error.message : "invalid JSON"}`);
    } finally {
      this.input("importColor").value = "";
    }
  }

  // ---------------------------------------------------------- cue catalogue

  private catalogEntries(): Fb4CueCatalogEntry[] {
    return fb4CueCatalog.map((entry) => this.catalogEntryFor(entry.page, entry.cue) ?? entry);
  }

  private catalogEntryFor(page: number, cue: number): Fb4CueCatalogEntry | null {
    const entry = describeFb4Cue(page, cue);
    if (!entry) {
      return null;
    }
    const override = this.catalogOverrides[`${page}-${cue}`];
    return override ? applyCatalogOverride(entry, override) : entry;
  }

  private named(frame: Fb4Dmx16Frame): Fb4Dmx16Frame {
    const name = this.catalogEntryFor(frame.page, frame.cue)?.name;
    if (!name || frame.cue <= 0) {
      return frame;
    }
    return { ...frame, label: `Cue ${frame.cue} / ${name}`, cueShape: name.toLowerCase() };
  }

  private unavailableReason(entry: Fb4CueCatalogEntry): string | null {
    if (this.experimental39Enabled || !fb4CueRequires39Channel(entry.page, entry.cue)) {
      return null;
    }
    return "No 16-channel address; needs 39-channel addressing.";
  }

  private async audition(entry: Fb4CueCatalogEntry): Promise<void> {
    const bpm = this.deps.currentBpm();
    const frame = this.named(
      this.experimental39Enabled
        ? buildFb4CueFrame(entry.cue, bpm, entry.page)
        : buildFb4LegacyCueFrame(entry.cue, bpm, entry.page)
    );
    const phraseId = this.deps.activeAdvancingPhraseId();
    if (phraseId) {
      // Pin the cue to the running phrase so it survives until the phrase
      // changes; auditioning mid-set should not be a one-shot flash.
      this.persistentOverride = { phraseId, frame };
      await this.publish(frame, "show");
      return;
    }
    await this.publishOverlay(frame);
  }

  private renderCatalog(): void {
    const pages = [...new Set(this.catalogEntries().map((entry) => entry.page))].sort((a, b) => a - b);
    if (!pages.includes(this.selectedPage)) {
      this.selectedPage = pages[0] ?? 1;
    }
    this.element.catalogPages.replaceChildren(
      ...pages.map((page) => {
        const sample = fb4CueCatalog.find((entry) => entry.page === page);
        const button = document.createElement("button");
        button.type = "button";
        button.className = page === this.selectedPage ? "chip active" : "chip";
        button.textContent = sample ? `P${page} ${sample.category}` : `P${page}`;
        button.addEventListener("click", () => {
          this.selectedPage = page;
          localStorage.setItem(STORAGE.catalogPage, String(page));
          this.renderCatalog();
        });
        return button;
      })
    );

    const onPage = this.catalogEntries().filter((entry) => entry.page === this.selectedPage);
    const reachable = onPage.filter((entry) => this.unavailableReason(entry) === null);
    const hiding = this.input("hideUnreachable").checked && reachable.length < onPage.length;
    let entries = hiding ? reachable : onPage;
    const favouritesOnly = this.input("favouritesOnly").checked;
    if (favouritesOnly) {
      entries = entries.filter((entry) => this.isFavourite(entry));
    }

    this.element.catalogCount.textContent = favouritesOnly
      ? `${entries.length} favourites on this page.`
      : hiding
        ? `Showing ${reachable.length} of ${onPage.length} on this page; ${onPage.length - reachable.length} need 39-channel addressing.`
        : `${onPage.length} cues on this page.`;

    const editing = this.input("catalogMode").checked;
    this.element.catalog.replaceChildren(
      ...entries.map((entry) => (editing ? this.catalogEditRow(entry) : this.catalogRow(entry)))
    );
  }

  private catalogRow(entry: Fb4CueCatalogEntry): HTMLElement {
    // A div row wrapping the audition button: the favourite chips need to be
    // buttons too, and buttons cannot nest.
    const row = document.createElement("div");
    row.className = "cue-catalog-row";
    const reason = this.unavailableReason(entry);
    const audition = document.createElement("button");
    audition.type = "button";
    audition.className = "cue-catalog-row-main";
    if (reason) {
      row.classList.add("disabled");
      audition.disabled = true;
    } else {
      audition.addEventListener("click", () => void this.audition(entry));
    }
    const detail = reason || entry.description || entry.notes;
    const text = document.createElement("div");
    text.className = "cue-catalog-row-text";
    text.innerHTML =
      `<span>P${entry.page} C${entry.cue}</span>` +
      `<strong>${escapeHtml(entry.name)}</strong>` +
      `<small>${escapeHtml(detail)}</small>`;
    audition.append(...(entry.thumbnailPath ? [thumbnail(entry)] : []), text);
    audition.title = detail || "Local catalog entry.";
    row.append(audition, this.favouriteChips(entry));
    return row;
  }

  private catalogEditRow(entry: Fb4CueCatalogEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "cue-catalog-edit-row";
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = `P${entry.page} C${entry.cue}`;
    const reason = this.unavailableReason(entry);
    play.disabled = reason !== null;
    play.title = reason ?? `Audition P${entry.page} C${entry.cue}`;
    if (!reason) {
      play.addEventListener("click", () => void this.audition(entry));
    }

    const note = document.createElement("input");
    note.type = "text";
    note.value = this.catalogOverrides[`${entry.page}-${entry.cue}`]?.description ?? "";
    note.placeholder = "Note what this cue looks like";
    note.addEventListener("input", () => {
      const key = `${entry.page}-${entry.cue}`;
      const description = note.value.trim();
      if (description) {
        this.catalogOverrides[key] = { description };
      } else {
        delete this.catalogOverrides[key];
      }
      localStorage.setItem(STORAGE.catalogOverrides, JSON.stringify(this.catalogOverrides));
    });

    const label = document.createElement("div");
    label.className = "cue-catalog-edit-label";
    label.innerHTML = `<strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(reason || entry.category)}</small>`;
    if (reason) {
      row.classList.add("disabled");
    }
    row.append(play, ...(entry.thumbnailPath ? [thumbnail(entry)] : []), label, note, this.favouriteChips(entry));
    return row;
  }

  private favouriteChips(entry: Fb4CueCatalogEntry): HTMLElement {
    const chips = document.createElement("div");
    chips.className = "favourite-chips";
    const key = `${entry.page}:${entry.cue}`;
    for (const pool of FAVOURITE_POOLS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = this.favourites[pool.id]?.includes(key) ? "chip active" : "chip";
      chip.textContent = pool.label;
      chip.title = `${pool.id} favourites`;
      chip.addEventListener("click", () => this.toggleFavourite(pool.id, key));
      chips.append(chip);
    }
    return chips;
  }

  private isFavourite(entry: Fb4CueCatalogEntry): boolean {
    const key = `${entry.page}:${entry.cue}`;
    return FAVOURITE_POOLS.some((pool) => this.favourites[pool.id]?.includes(key));
  }

  private toggleFavourite(poolId: Fb4CuePoolId, key: string): void {
    const keys = this.favourites[poolId] ?? [];
    const next = keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
    this.favourites = { ...this.favourites, [poolId]: next };
    this.deps.setFavouriteCues(this.favourites);
    this.renderCatalog();
    void this.saveFavourites();
  }

  private async loadFavourites(): Promise<void> {
    try {
      const response = await fetch("/api/dmx/laser-favourites");
      const payload = await response.json() as { pools?: Fb4CueFavouritePools };
      this.favourites = payload.pools ?? {};
      this.deps.setFavouriteCues(this.favourites);
      this.renderCatalog();
    } catch {
      this.setStatus("Favourites unavailable.");
    }
  }

  private async saveFavourites(): Promise<void> {
    const body = JSON.stringify({ version: 1, pools: this.favourites });
    try {
      const response = await fetch("/api/dmx/laser-favourites", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body
      });
      const result = (await response.json()) as { ok: boolean; error?: string };
      if (!result.ok) {
        this.setStatus(`Favourite save failed: ${result.error ?? "unknown"}`);
      }
    } catch {
      this.setStatus("Favourite save failed: output service reconnecting.");
    }
  }

  private async exportCatalog(): Promise<void> {
    const payload = {
      version: 2,
      fixture: "pangolin-fb4-dmx16",
      exportedAt: new Date().toISOString(),
      entries: this.catalogEntries()
    };
    try {
      const response = await fetch("/api/dmx/cue-catalog/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = (await response.json()) as { ok: boolean; path?: string; error?: string };
      this.setStatus(
        result.ok && result.path ? `Exported to ${result.path}` : `Export failed: ${result.error ?? "unknown"}`
      );
    } catch {
      this.setStatus("Export failed: output service reconnecting.");
    }
  }

  // ---------------------------------------------------------- mixer polling

  /**
   * Polls the Rekordbox mixer so the laser can be muted when every line fader
   * is down - the one case where a bright beam is unambiguously wrong.
   */
  private startMixerPolling(): void {
    if (this.mixerPollingStarted) {
      return;
    }
    this.mixerPollingStarted = true;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch("/api/rekordbox/mixer");
        if (response.ok) {
          const next = (await response.json()) as { highestLineFader: number | null };
          const previous = this.mixerHighestFader;
          this.mixerHighestFader = next.highestLineFader;
          if (this.input("rekordboxMute").checked && previous !== next.highestLineFader) {
            await this.republish();
          }
        }
      } catch {
        this.mixerHighestFader = null;
      } finally {
        window.setTimeout(() => void poll(), 500);
      }
    };
    void poll();
  }
}

// ------------------------------------------------------------------ helpers

function write16Bit(channels: number[], startIndex: number, byteValue: number): void {
  const coarse = clampByte(byteValue);
  channels[startIndex] = coarse;
  channels[startIndex + 1] = coarse;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function thumbnail(entry: Fb4CueCatalogEntry, className = "cue-thumbnail"): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.src = entry.thumbnailPath ?? "";
  image.alt = `P${entry.page} C${entry.cue} ${entry.name}`;
  image.loading = "lazy";
  // Thumbnails come from Pangolin's content pack and are not redistributed, so
  // a fresh checkout has none. Drop the element rather than leave a broken
  // image icon in every catalogue row.
  image.addEventListener("error", () => image.remove(), { once: true });
  return image;
}

function loadCatalogOverrides(): Record<string, Fb4CueCatalogOverride> {
  const raw = localStorage.getItem(STORAGE.catalogOverrides);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => {
          if (typeof value === "string") {
            const trimmed = value.trim();
            return [key, trimmed ? { description: trimmed } : {}] as const;
          }
          if (!value || typeof value !== "object") {
            return [key, {}] as const;
          }
          const record = value as Record<string, unknown>;
          const description =
            (typeof record.description === "string" ? record.description.trim() : "") ||
            (typeof record.name === "string" ? record.name.trim() : "");
          return [key, description ? { description } : {}] as const;
        })
        .filter(([, value]) => Object.keys(value).length > 0)
    );
  } catch {
    return {};
  }
}

function loadSelectedPage(): number {
  const parsed = Number.parseInt(localStorage.getItem(STORAGE.catalogPage) ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function defaultCalibration(): LaserColorSlot[] {
  return fb4ProjectorColorProfile.slots.map((slot) => ({ ...slot }));
}

function loadCalibration(): LaserColorSlot[] {
  const raw = localStorage.getItem(STORAGE.calibration);
  if (!raw) {
    return defaultCalibration();
  }
  try {
    const parsed = JSON.parse(raw) as { slots?: unknown };
    return mergeCalibration(normalizeCalibration(parsed.slots));
  } catch {
    return defaultCalibration();
  }
}

function normalizeCalibration(raw: unknown): LaserColorSlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((slot) => {
    if (!slot || typeof slot !== "object") {
      return [];
    }
    const input = slot as Record<string, unknown>;
    if (typeof input.id !== "string" || typeof input.name !== "string") {
      return [];
    }
    const observedName =
      (typeof input.observedName === "string" && input.observedName.trim()) ||
      (typeof input.label === "string" && input.label.trim()) ||
      input.name;
    const text = (key: string, fallback: string): string =>
      typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : fallback;
    return [
      {
        id: input.id,
        name: input.name,
        observedName,
        channel15: clampByte(
          typeof input.channel15 === "number" ? input.channel15 : Number(input.value)
        ),
        nominalBand: text("nominalBand", "uncataloged"),
        role: text("role", "show palette color"),
        graphicsColor: text("graphicsColor", "#f8fafc")
      }
    ];
  });
}

function mergeCalibration(overrides: LaserColorSlot[]): LaserColorSlot[] {
  const merged = new Map(defaultCalibration().map((slot) => [slot.id, slot]));
  overrides.forEach((slot) => merged.set(slot.id, slot));
  return [...merged.values()];
}

const SWATCHES = [
  { value: 118, name: "Cyan" },
  { value: 84, name: "Lime" },
  { value: 72, name: "Yellow" },
  { value: 150, name: "Blue" }
];

const TEMPLATE = /* html */ `
  <div class="laser-primary">
    <label class="toggle-row accent">
      <input data-laser="enabled" type="checkbox" />
      <span>Send live Art-Net</span>
    </label>
    <div data-laser="currentCue" class="current-cue"></div>
    <div class="button-row">
      <button data-laser="blackout" type="button" class="danger">Blackout</button>
      <label class="toggle-row compact">
        <input data-laser="holdForever" type="checkbox" />
        <span>Hold</span>
      </label>
      <button data-laser="releaseHold" type="button">Release</button>
    </div>
    <label class="toggle-row">
      <input data-laser="brightnessOverride" type="checkbox" />
      <span>Override dimmer</span>
    </label>
    <label class="toggle-row">
      <input data-laser="brightnessOn" type="checkbox" />
      <span>Dimmer on (unchecked = blackout)</span>
    </label>
    <div class="swatch-row">
      ${SWATCHES.map(
        (swatch) =>
          `<button type="button" class="chip" data-swatch="${swatch.value}" data-swatch-name="${swatch.name}">${swatch.name}</button>`
      ).join("")}
    </div>
    <div data-laser="status" class="hint"></div>
  </div>

  <div class="addressing">
    <label class="toggle-row">
      <input data-laser="experimental39" type="checkbox" />
      <span>39-channel cue addressing</span>
    </label>
    <div data-laser="reach" class="hint"></div>
  </div>

  <details class="subpanel">
    <summary>Connection</summary>
    <label class="field-row">
      <span>Host</span>
      <input data-laser="host" type="text" value="127.0.0.1" />
    </label>
    <label class="field-row">
      <span>Universe</span>
      <input data-laser="universe" type="number" min="0" max="32767" value="0" />
    </label>
    <label class="toggle-row">
      <input data-laser="rekordboxMute" type="checkbox" />
      <span>Mute when all Rekordbox faders are down</span>
    </label>
    <label class="toggle-row">
      <input data-laser="beatLooks" type="checkbox" checked />
      <span>Beat looks</span>
    </label>
    <label class="toggle-row">
      <input data-laser="dimmerFades" type="checkbox" checked />
      <span>Dimmer fades</span>
    </label>
    <div class="hint">Fades may turn red or drop out if FB4 brightness is low.</div>
    <label class="field-row">
      <span>Output latency <strong data-laser="latencyValue">0</strong> ms</span>
      <input data-laser="latencyMs" type="number" min="0" max="500" step="5" value="0" />
    </label>
    <div data-laser="channels" class="dmx-channels"></div>
  </details>

  <details class="subpanel">
    <summary>Cue catalogue</summary>
    <div data-laser="catalogPages" class="chip-row"></div>
    <div class="button-row">
      <label class="toggle-row compact">
        <input data-laser="hideUnreachable" type="checkbox" checked />
        <span>Only reachable</span>
      </label>
      <label class="toggle-row compact">
        <input data-laser="favouritesOnly" type="checkbox" />
        <span>Favourites only</span>
      </label>
      <label class="toggle-row compact">
        <input data-laser="catalogMode" type="checkbox" />
        <span>Annotate</span>
      </label>
      <button data-laser="exportCatalog" type="button">Export</button>
    </div>
    <div data-laser="catalogCount" class="hint"></div>
    <div data-laser="catalog" class="cue-catalog"></div>
  </details>

  <details class="subpanel">
    <summary>Colour calibration</summary>
    <div data-laser="colorProfile" class="hint"></div>
    <label class="field-row">
      <span>Slot</span>
      <select data-laser="colorSlot"></select>
    </label>
    <label class="field-row">
      <span>Observed name</span>
      <input data-laser="colorLabel" type="text" />
    </label>
    <label class="field-row">
      <span>Channel 15 <strong data-laser="colorValue">118</strong></span>
      <input data-laser="colorSlider" type="range" min="33" max="255" step="1" value="118" />
    </label>
    <div class="button-row">
      <button data-laser="holdColor" type="button">Hold</button>
      <button data-laser="saveColor" type="button">Save</button>
      <a data-laser="exportColor" href="#" download="fb4-laser-colour.json">Export</a>
      <label class="file-input">
        <span>Import</span>
        <input data-laser="importColor" type="file" accept="application/json" />
      </label>
    </div>
  </details>

  <details class="subpanel">
    <summary>Geometry and test patterns</summary>
    <label class="toggle-row">
      <input data-laser="geometryOverride" type="checkbox" />
      <span>Override geometry</span>
    </label>
    <div class="geometry-grid">
      ${GEOMETRY_SLIDERS.map(
        (slider) => `
        <label>
          <span>${slider.label} <strong data-laser="${slider.key}Value">${slider.fallback}</strong></span>
          <input data-laser="${slider.key}" type="range" min="0" max="255" step="1" value="${slider.fallback}" />
        </label>`
      ).join("")}
    </div>
    <div class="button-row wrap">
      <button data-laser="zoneFrame" type="button">Square</button>
      <button data-laser="cueOne" type="button">Circle</button>
      <button data-laser="cueSweep" type="button">Cue sweep</button>
      <button data-laser="fadeTest" type="button">Fade test</button>
      <button data-laser="colorOriginal" type="button">Original colour</button>
      <button data-laser="colorWhite" type="button">White</button>
    </div>
  </details>
`;
