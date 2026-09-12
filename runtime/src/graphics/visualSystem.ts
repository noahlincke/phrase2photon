import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  LinearFilter,
  NoToneMapping
} from "three";

import { COMMON_GLSL, FULLSCREEN_VERTEX_GLSL } from "./glsl/common.js";
import { paletteById, type Palette } from "./palette.js";
import { sceneById, visualScenes, type VisualScene } from "./visualScenes.js";

/**
 * The graphics runtime.
 *
 * Scenes are fragment shaders over a full-screen quad, which is what the
 * previous renderer only pretended to be: it painted a 2D canvas on the CPU
 * and uploaded it as a texture every frame, paying a full-resolution texture
 * upload per frame for the privilege of not using the GPU.
 *
 * Scene changes crossfade through render targets. The second target is only
 * allocated and drawn while a transition is running, so the steady-state cost
 * is a single full-screen pass.
 */

export interface MusicalFrame {
  /** Continuous beat position; the fraction is the position in the beat. */
  beat: number;
  beatPhase: number;
  barPhase: number;
  phrasePhase: number;
  barInPhrase: number;
  /** 0-1. */
  energy: number;
  bands: { low: number; mid: number; high: number };
  paletteId: string;
}

const TRANSITION_SECONDS = 0.45;

interface SceneSlot {
  scene: VisualScene;
  target: Scene;
  material: ShaderMaterial;
  seed: number;
}

export class VisualSystem {
  private readonly renderer: WebGLRenderer;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);

  private current: SceneSlot;
  private outgoing: SceneSlot | null = null;
  private transitionRemaining = 0;

  private currentTarget: WebGLRenderTarget | null = null;
  private outgoingTarget: WebGLRenderTarget | null = null;
  private readonly compositeScene = new Scene();
  private readonly compositeMaterial: ShaderMaterial;

  private width = 1;
  private height = 1;
  private renderScale = 1;
  private palette: Palette = paletteById(null);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true
    });
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setClearColor(0x000000, 1);

    this.current = this.createSlot(visualScenes[0]);

    this.compositeMaterial = new ShaderMaterial({
      uniforms: {
        uFrom: { value: null },
        uTo: { value: null },
        uMix: { value: 0 }
      },
      vertexShader: FULLSCREEN_VERTEX_GLSL,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uFrom;
        uniform sampler2D uTo;
        uniform float uMix;
        varying vec2 vUv;
        void main() {
          vec3 from = texture2D(uFrom, vUv).rgb;
          vec3 to = texture2D(uTo, vUv).rgb;
          // Additive in the middle of the blend: two line drawings crossfading
          // linearly read as a dip to grey, whereas letting them overlap keeps
          // the image bright through the cut.
          float overlap = 1.0 - abs(uMix * 2.0 - 1.0);
          vec3 mixed = mix(from, to, uMix) + min(from, to) * overlap * 0.6;
          gl_FragColor = vec4(mixed, 1.0);
        }
      `
    });
    this.compositeScene.add(new Mesh(this.geometry, this.compositeMaterial));

    this.resize();
  }

  get activeSceneId(): string {
    return this.current.scene.id;
  }

  private createSlot(scene: VisualScene): SceneSlot {
    const material = new ShaderMaterial({
      uniforms: {
        uResolution: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
        uBeat: { value: 0 },
        uBeatPhase: { value: 0 },
        uBarPhase: { value: 0 },
        uPhrasePhase: { value: 0 },
        uBarInPhrase: { value: 0 },
        uEnergy: { value: 0.5 },
        uBands: { value: new Vector3(0, 0, 0) },
        uInk: { value: new Vector3(1, 1, 1) },
        uAccent: { value: new Vector3(1, 1, 1) },
        uBackground: { value: new Vector3(0, 0, 0) },
        uIntensity: { value: 1 },
        uSeed: { value: Math.random() }
      },
      vertexShader: FULLSCREEN_VERTEX_GLSL,
      fragmentShader: `${COMMON_GLSL}\n${scene.fragmentShader}`
    });
    const target = new Scene();
    target.add(new Mesh(this.geometry, material));
    return { scene, target, material, seed: material.uniforms.uSeed.value as number };
  }

  /** Switches scenes, crossfading unless `immediate` is set. */
  setScene(sceneId: string, immediate = false): void {
    if (sceneId === this.current.scene.id) {
      return;
    }
    const next = sceneById(sceneId);
    if (!next) {
      return;
    }
    const slot = this.createSlot(next);
    if (immediate || this.transitionRemaining > 0) {
      this.disposeSlot(this.outgoing);
      this.outgoing = null;
      this.transitionRemaining = 0;
      this.disposeSlot(this.current);
      this.current = slot;
      return;
    }
    this.disposeSlot(this.outgoing);
    this.outgoing = this.current;
    this.current = slot;
    this.transitionRemaining = TRANSITION_SECONDS;
    this.ensureTargets();
  }

  private disposeSlot(slot: SceneSlot | null): void {
    slot?.material.dispose();
  }

  setRenderScale(scale: number): number {
    this.renderScale = Math.min(1, Math.max(0.35, Number.isFinite(scale) ? scale : 1));
    this.resize();
    return this.renderScale;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);

    const pixelWidth = Math.max(1, Math.floor(this.width * pixelRatio));
    const pixelHeight = Math.max(1, Math.floor(this.height * pixelRatio));
    this.currentTarget?.setSize(pixelWidth, pixelHeight);
    this.outgoingTarget?.setSize(pixelWidth, pixelHeight);
  }

  private ensureTargets(): void {
    if (this.currentTarget && this.outgoingTarget) {
      return;
    }
    const pixelRatio = this.renderer.getPixelRatio();
    const pixelWidth = Math.max(1, Math.floor(this.width * pixelRatio));
    const pixelHeight = Math.max(1, Math.floor(this.height * pixelRatio));
    const create = (): WebGLRenderTarget =>
      new WebGLRenderTarget(pixelWidth, pixelHeight, {
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        stencilBuffer: false
      });
    this.currentTarget ??= create();
    this.outgoingTarget ??= create();
  }

  render(frame: MusicalFrame, elapsedSeconds: number, deltaSeconds: number): void {
    this.palette = paletteById(frame.paletteId);
    this.applyUniforms(this.current, frame, elapsedSeconds);

    if (this.transitionRemaining > 0 && this.outgoing) {
      this.transitionRemaining = Math.max(0, this.transitionRemaining - deltaSeconds);
      const progress = 1 - this.transitionRemaining / TRANSITION_SECONDS;
      this.applyUniforms(this.outgoing, frame, elapsedSeconds);
      this.ensureTargets();

      this.renderer.setRenderTarget(this.outgoingTarget);
      this.renderer.render(this.outgoing.target, this.camera);
      this.renderer.setRenderTarget(this.currentTarget);
      this.renderer.render(this.current.target, this.camera);
      this.renderer.setRenderTarget(null);

      this.compositeMaterial.uniforms.uFrom.value = this.outgoingTarget?.texture ?? null;
      this.compositeMaterial.uniforms.uTo.value = this.currentTarget?.texture ?? null;
      this.compositeMaterial.uniforms.uMix.value = progress;
      this.renderer.render(this.compositeScene, this.camera);

      if (this.transitionRemaining <= 0) {
        this.disposeSlot(this.outgoing);
        this.outgoing = null;
      }
      return;
    }

    this.renderer.render(this.current.target, this.camera);
  }

  private applyUniforms(slot: SceneSlot, frame: MusicalFrame, elapsedSeconds: number): void {
    const uniforms = slot.material.uniforms;
    (uniforms.uResolution.value as Vector2).set(
      this.width * this.renderer.getPixelRatio(),
      this.height * this.renderer.getPixelRatio()
    );
    uniforms.uTime.value = elapsedSeconds;
    uniforms.uBeat.value = frame.beat;
    uniforms.uBeatPhase.value = frame.beatPhase;
    uniforms.uBarPhase.value = frame.barPhase;
    uniforms.uPhrasePhase.value = frame.phrasePhase;
    uniforms.uBarInPhrase.value = frame.barInPhrase;
    uniforms.uEnergy.value = frame.energy;
    (uniforms.uBands.value as Vector3).set(frame.bands.low, frame.bands.mid, frame.bands.high);
    (uniforms.uInk.value as Vector3).fromArray(this.palette.ink);
    (uniforms.uAccent.value as Vector3).fromArray(this.palette.accent);
    (uniforms.uBackground.value as Vector3).fromArray(this.palette.background);
    uniforms.uIntensity.value = 1;
  }

  /** PNG data URL of the current frame, for exports and thumbnails. */
  snapshotDataUrl(): string {
    return this.renderer.domElement.toDataURL("image/png");
  }

  dispose(): void {
    this.disposeSlot(this.current);
    this.disposeSlot(this.outgoing);
    this.compositeMaterial.dispose();
    this.geometry.dispose();
    this.currentTarget?.dispose();
    this.outgoingTarget?.dispose();
    this.renderer.dispose();
  }
}
