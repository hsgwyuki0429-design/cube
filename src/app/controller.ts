// アプリの中枢: カメラ → 認識 Worker → スキャン／追跡 の流れをまとめる。UI はこのストアを購読するだけ。
import { F, isSolved, solvedState } from "../cube/model";
import { setupMovesFor } from "../cube/solver";
import { FaceCapture, type ScanResult, type ScanStep, type ScannedFace, assembleScan, scanSteps } from "../scan/scan";
import { analyzeState, type StateProblem } from "../cube/pattern";
import type { EngineOptions, TrackUpdate } from "../track/engine";
import { type CameraInfo, CameraSource, cameraErrorMessage, listCameras } from "../vision/camera";
import { type Lab, NAMED_COLORS, labToRgb, rgbCss } from "../vision/color";
import { HandsClient } from "../vision/handsClient";
import type { FrameMessage } from "../vision/protocol";
import { FrameRecorder } from "../vision/recorder";
import { RefineClient, VisionClient } from "../vision/visionClient";
import { type Settings, settingsStore } from "./settings";
import { type Calibration, loadCalibration, saveCalibration } from "./storage";
import { createStore } from "./store";

export type Screen = "main" | "history" | "settings" | "help";
export type Panel = "free" | "timer";

export interface CubeSetup {
  state: number[]; // 追跡開始時の状態（キューブ固定フレーム）
  refs: Lab[];
  names: string[];
  display: string[]; // 面ごとの表示色
  setupMoves: number[] | null; // 3D 表示用（完成 → state）
  epoch: number; // 追跡をやり直すたびに増える
}

export interface ScanUi {
  steps: ScanStep[];
  step: number;
  captured: ScannedFace[];
  progress: number;
  reason?: string;
  result?: ScanResult;
  edited?: number[]; // 手で直した状態
  problems?: StateProblem[];
}

export interface AppState {
  screen: Screen;
  panel: Panel;
  camera: "off" | "starting" | "on" | "error";
  cameraError: string | null;
  cameraInfo: CameraInfo | null;
  cameras: { id: string; label: string }[];
  vision: "loading" | "ready" | "guide-only";
  visionLoadMs: number;
  hands: "off" | "loading" | "ready" | "error";
  demo: boolean;
  scan: ScanUi | null;
  cube: CubeSetup | null;
  track: TrackUpdate | null;
  baseMoves: number; // 「手順をクリア」した位置
  stats: { camFps: number; procFps: number; procMs: number; faces: number };
  calibration: Calibration | null;
  toast: string | null;
}

export function displayColors(refs: Lab[], names: string[], scheme: Settings["scheme"]): string[] {
  if (scheme === "standard") return names.map((n) => NAMED_COLORS.find((c) => c.id === n)?.display ?? "#888");
  // 実測の色を、明るさを揃えて少し鮮やかに
  return refs.map(([L, a, b]) => rgbCss(labToRgb([Math.min(92, Math.max(45, L * 1.1)), a * 1.25, b * 1.25])));
}

class Controller {
  readonly store = createStore<AppState>({
    screen: "main",
    panel: "free",
    camera: "off",
    cameraError: null,
    cameraInfo: null,
    cameras: [],
    vision: "loading",
    visionLoadMs: 0,
    hands: "off",
    demo: false,
    scan: null,
    cube: null,
    track: null,
    baseMoves: 0,
    stats: { camFps: 0, procFps: 0, procMs: 0, faces: 0 },
    calibration: loadCalibration(),
    toast: null,
  });
  readonly camera = new CameraSource();
  vision: VisionClient | null = null;
  readonly hands = new HandsClient();
  readonly recorder = new FrameRecorder(); // タイマー計測中の録画（ソルブ後の精密解析用）
  readonly refiner = new RefineClient();
  private capture = new FaceCapture();
  private frameListeners = new Set<(m: FrameMessage) => void>();
  private trackListeners = new Set<(u: TrackUpdate) => void>();
  latestFrame: FrameMessage | null = null;
  synthetic: import("../synthetic/syntheticCube").SyntheticCube | null = null;
  private statsTimer = 0;
  private toastTimer = 0;
  private epoch = 0;
  private preScanTrack: TrackUpdate | null = null;
  private stalled = 0;
  private lastRetry = -Infinity;

  init(): void {
    if (this.vision) return;
    this.vision = new VisionClient();
    this.applySettings(settingsStore.get());
    settingsStore.subscribe((s) => this.applySettings(s));
    this.vision.ready
      .then(({ opencv, ms }) => this.store.set({ vision: opencv ? "ready" : "guide-only", visionLoadMs: ms }))
      .catch(() => this.store.set({ vision: "guide-only" }));
    this.vision.onResult((m) => this.onFrame(m));
    this.camera.onFrame((t) => {
      this.vision?.submit(this.camera.video, t);
      if (this.recorder.recording) this.recorder.add(this.camera.video, t);
      if (settingsStore.get().handMask && !this.store.get().demo) this.hands.submit(this.camera.video, t);
    });
    this.hands.onUpdate = (hulls) => this.vision?.setHands(hulls);
    this.camera.onEnded(() => this.onCameraLost());
    this.statsTimer = window.setInterval(() => {
      const v = this.vision;
      // カメラは「オン」なのに映像が来ない（Windows のカメラ設定・他のアプリ・USB の接触など）
      if (this.store.get().camera === "on" && !this.store.get().demo && this.camera.fps === 0) {
        if (++this.stalled === 6) this.toast("カメラの映像が届いていません。他のアプリがカメラを使っていないか確認してください。", 8000);
      } else this.stalled = 0;
      this.store.set({
        stats: { camFps: this.camera.fps, procFps: v?.procFps ?? 0, procMs: v?.lastProcMs ?? 0, faces: this.latestFrame?.faces.length ?? 0 },
        hands: this.hands.status,
      });
    }, 500);
    // 以前カメラを許可していれば自動で開始
    navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((p) => {
        if (p.state === "granted" && this.store.get().camera === "off" && !this.store.get().demo) this.startCamera();
      })
      .catch(() => undefined);
  }

  private applySettings(s: Settings): void {
    if (!this.vision) return;
    this.vision.workWidth = s.workWidth;
    this.vision.setConfig({ mode: s.detection });
    this.vision.setTrackingOptions(this.engineOptions(s));
    // デモの合成映像には本物の手が映らないので、手の検出は動かさない（CPU を食うだけ）
    const wantHands = s.handMask && !this.store.get().demo;
    if (wantHands && this.hands.status === "off") this.hands.start();
    if (!wantHands && this.hands.status !== "off") this.hands.stop();
  }

  engineOptions(s: Settings = settingsStore.get()): Partial<EngineOptions> {
    return {
      decoder: { beamWidth: s.beamWidth, maxMovesPerStep: s.maxMovesPerStep, rotationCost: s.rotationCost },
      observer: { stableMs: s.stableMs },
      colors: { maxDistance: s.maxColorDistance },
    };
  }

  toast(message: string, ms = 3500): void {
    this.store.set({ toast: message });
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.store.set({ toast: null }), ms);
  }

  onFrameResult(cb: (m: FrameMessage) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onTrack(cb: (u: TrackUpdate) => void): () => void {
    this.trackListeners.add(cb);
    return () => this.trackListeners.delete(cb);
  }

  // ---- カメラ ----

  async refreshCameras(): Promise<void> {
    const list = await listCameras();
    this.store.set({ cameras: list.map((d, i) => ({ id: d.deviceId, label: d.label || `カメラ ${i + 1}` })) });
  }

  async startCamera(): Promise<void> {
    this.init();
    this.stopDemo();
    const s = settingsStore.get();
    this.store.set({ camera: "starting", cameraError: null });
    try {
      const info = await this.camera.start({ deviceId: s.cameraId || undefined, facingMode: s.facingMode, height: s.resolution, frameRate: s.cameraFps });
      this.store.set({ camera: "on", cameraInfo: info });
      this.refreshCameras();
    } catch (e) {
      // 指定したカメラが無くなっていたら既定のカメラで再試行
      if (s.cameraId) {
        settingsStore.set({ cameraId: "" });
        return this.startCamera();
      }
      this.store.set({ camera: "error", cameraError: cameraErrorMessage(e) });
    }
  }

  // 映像が途中で止まった: 一度だけ自動でつなぎ直し、だめなら理由を出す
  private async onCameraLost(): Promise<void> {
    if (this.store.get().demo || this.store.get().camera !== "on") return;
    this.camera.stop();
    const retry = performance.now() - this.lastRetry > 10000;
    this.lastRetry = performance.now();
    this.store.set({ camera: "error", cameraError: "カメラの映像が止まりました。他のアプリ（Zoom・Teams など）がカメラを使い始めたか、カメラが外れた可能性があります。" });
    if (retry) {
      await new Promise((r) => setTimeout(r, 800));
      if (this.store.get().camera === "error" && !this.store.get().demo) await this.startCamera();
    }
  }

  stopCamera(): void {
    this.camera.stop();
    this.store.set({ camera: "off" });
  }

  // ---- デモ（合成カメラ） ----

  async startDemo(options: { autoplay?: boolean; seed?: number; script?: import("../synthetic/demo").DemoOptions } = {}): Promise<void> {
    this.init();
    const { SyntheticCube } = await import("../synthetic/syntheticCube");
    this.camera.stop();
    this.synthetic?.stop();
    const syn = new SyntheticCube();
    this.synthetic = syn;
    syn.setView("front", 0);
    const info = await this.camera.attach(syn.stream());
    this.store.set({ demo: true, camera: "on", cameraInfo: { ...info, label: "デモ（合成カメラ）" }, cameraError: null });
    this.applySettings(settingsStore.get());
    if (options.autoplay !== false) {
      const { runDemo } = await import("../synthetic/demo");
      runDemo(this, syn, options.seed, options.script);
    }
  }

  stopDemo(): void {
    if (!this.synthetic) return;
    this.synthetic.stop();
    this.synthetic = null;
    this.camera.stop();
    this.store.set({ demo: false, camera: "off" });
    this.applySettings(settingsStore.get());
  }

  // ---- スキャン ----

  beginScan(): void {
    this.init();
    this.preScanTrack = this.store.get().track;
    this.vision?.stopTracking();
    this.vision?.setRefs(null);
    this.capture.reset();
    this.store.set({ scan: { steps: scanSteps(settingsStore.get().scheme), step: 0, captured: [], progress: 0 }, track: null });
  }

  cancelScan(): void {
    this.store.set({ scan: null });
    const cube = this.store.get().cube;
    if (!cube) return;
    // スキャン前に追跡していた最新の状態から再開する
    const last = this.preScanTrack;
    if (last) this.startTrackingFrom(Uint8Array.from(last.state), last.refs, cube.names);
    else this.restartTracking(cube.state, cube.refs);
  }

  retakeFace(step: number): void {
    const scan = this.store.get().scan;
    if (!scan) return;
    this.capture.reset();
    this.store.set({ scan: { ...scan, step, captured: scan.captured.slice(0, step), result: undefined, edited: undefined, progress: 0 } });
  }

  private onScanFrame(m: FrameMessage): void {
    const scan = this.store.get().scan;
    if (!scan || scan.result) return;
    const front = m.faces.find((f) => f.slot === F);
    const reading = front ? { labs: front.labs, valid: front.valid.map((v, i) => v && !front.masked[i]) } : null;
    const p = this.capture.push(reading, scan.captured.map((c) => c.labs[4]));
    if (!p.labs) {
      if (Math.abs(p.progress - scan.progress) > 0.05 || p.reason !== scan.reason) this.store.set({ scan: { ...scan, progress: p.progress, reason: p.reason } });
      return;
    }
    const captured = [...scan.captured, { face: scan.steps[scan.step].face, labs: p.labs }];
    if (captured.length < 6) {
      this.store.set({ scan: { ...scan, captured, step: scan.step + 1, progress: 0, reason: undefined } });
      this.beep(880, 0.08);
      return;
    }
    this.beep(1320, 0.12);
    try {
      const result = assembleScan(captured, settingsStore.get().scheme);
      this.store.set({ scan: { ...scan, captured, step: 6, progress: 1, result, edited: Array.from(result.state), problems: result.problems } });
    } catch (e) {
      this.toast(String(e));
      this.retakeFace(0);
    }
  }

  editScanCell(facelet: number): void {
    const scan = this.store.get().scan;
    if (!scan?.edited || facelet % 9 === 4) return;
    const edited = [...scan.edited];
    edited[facelet] = (edited[facelet] + 1) % 6;
    this.store.set({ scan: { ...scan, edited, problems: analyzeState(Uint8Array.from(edited)).problems } });
  }

  confirmScan(): void {
    const scan = this.store.get().scan;
    if (!scan?.result || !scan.edited) return;
    const state = Uint8Array.from(scan.edited);
    if (analyzeState(state).problems.length) {
      this.toast("このままでは追跡を始められません。色を直すか、もう一度スキャンしてください。");
      return;
    }
    const { refs, names } = scan.result;
    const scheme = settingsStore.get().scheme;
    const calibration: Calibration = { refs, names, scheme, savedAt: Date.now() };
    saveCalibration(calibration);
    this.store.set({ scan: null, calibration });
    this.startTrackingFrom(state, refs, names);
  }

  // 前回の色設定で、完成状態から始める
  startFromSolved(): void {
    const cal = this.store.get().calibration;
    if (!cal) return this.beginScan();
    this.startTrackingFrom(solvedState(), cal.refs, cal.names);
  }

  // ---- 追跡 ----

  private startTrackingFrom(state: Uint8Array, refs: Lab[], names: string[]): void {
    this.epoch++;
    const cube: CubeSetup = {
      state: Array.from(state),
      refs,
      names,
      display: displayColors(refs, names, settingsStore.get().scheme),
      setupMoves: isSolved(state) ? [] : null,
      epoch: this.epoch,
    };
    this.store.set({ cube, track: null, baseMoves: 0, scan: null });
    this.restartTracking(cube.state, refs);
    if (!cube.setupMoves) {
      const epoch = this.epoch;
      setupMovesFor(state)
        .then((moves) => {
          const cur = this.store.get().cube;
          if (cur && cur.epoch === epoch) this.store.set({ cube: { ...cur, setupMoves: moves } });
        })
        .catch((e) => {
          console.error("setupMovesFor failed", e);
          this.toast("3D 表示用の手順を計算できませんでした");
        });
    }
  }

  private restartTracking(state: number[], refs: Lab[]): void {
    this.vision?.startTracking(state, refs, this.engineOptions());
  }

  // キューブを完成させた（見失った後など）: 完成状態からやり直す
  resetToSolved(): void {
    const cube = this.store.get().cube;
    const cal = this.store.get().calibration;
    const refs = this.store.get().track?.refs ?? cube?.refs ?? cal?.refs;
    const names = cube?.names ?? cal?.names;
    if (!refs || !names) return this.beginScan();
    this.startTrackingFrom(solvedState(), refs, names);
    this.toast("完成状態から追跡し直します");
  }

  // タイマー用の録画を始める（インスペクション中は直近の数秒だけ残す）
  async startRecording(keepMs = 4000): Promise<boolean> {
    if (!settingsStore.get().analyzeSolves || this.store.get().camera !== "on") return false;
    this.recorder.clear();
    return this.recorder.start(this.camera.video, settingsStore.get().workWidth, keepMs);
  }

  clearMoves(): void {
    this.store.set({ baseMoves: this.store.get().track?.moves.length ?? 0 });
  }

  private onFrame(m: FrameMessage): void {
    this.latestFrame = m;
    for (const l of this.frameListeners) l(m);
    if (this.store.get().scan) this.onScanFrame(m);
    if (m.track) {
      this.store.set({ track: m.track });
      for (const l of this.trackListeners) l(m.track);
    }
  }

  // ---- 効果音 ----
  private audio: AudioContext | null = null;
  beep(freq = 880, duration = 0.1): void {
    if (!settingsStore.get().sound) return;
    try {
      this.audio ??= new AudioContext();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(this.audio.currentTime + duration);
    } catch {
      // 音が出せない環境
    }
  }

  dispose(): void {
    clearInterval(this.statsTimer);
  }
}

export const controller = new Controller();
export type { Controller };
