// アプリの中枢: カメラ → 認識 Worker → スキャン／追跡 の流れをまとめる。UI はこのストアを購読するだけ。
import { Matrix4, Quaternion } from "three";
import { type Mat3, ORIENTATIONS, mul } from "../cube/model";
import { F, isSolved, solvedState } from "../cube/model";
import { setupMovesFor } from "../cube/solver";
import { FaceCapture, type ScanResult, type ScanStep, type ScannedFace, assembleScan, scanSteps } from "../scan/scan";
import { analyzeState, type StateProblem } from "../cube/pattern";
import type { EngineOptions, TrackUpdate } from "../track/engine";
import { type CameraInfo, CameraSource, cameraErrorMessage, listCameras } from "../vision/camera";
import { type Lab, NAMED_COLORS } from "../vision/color";
import type { PipelineConfig } from "../vision/pipeline";
import type { FrameMessage, StreamPartial } from "../vision/protocol";
import type { RefineInput, RefineResult } from "../vision/refine";
import { FrameRecorder } from "../vision/recorder";
import type { VideoFileInfo } from "../vision/videoFile";
import { RefineClient, VisionClient } from "../vision/visionClient";
import { ARUCO_OBSERVER } from "../track/observer";
import { ARUCO_NAMES, ARUCO_REFS } from "../aruco/palette";
import { type Settings, facingOf, settingsStore } from "./settings";
import { STICKERS } from "../aruco/design";
import { loadSolves, personalSequences } from "./storage";
import { createStore } from "./store";
import { markPhase, safeLevel } from "./crashGuard";

// 画面: プレイ・データ（グラフと履歴）・1 回の記録の詳しい画面・解析（スロー動画・ArUco の画面）・設定（使い方も）
export type Screen = "play" | "data" | "solve" | "analyze" | "settings";
// 解析の画面のタブ
export type AnalyzeTab = "timer-video" | "free-video" | "aruco";

// aruco.html（移動するだけのページ）や #aruco で開かれたら ArUco の画面から始める。古い Service Worker が
// aruco.html への移動に本体の index.html を返したときも、URL を見て ArUco の画面を開く
const openedAruco = () => typeof location !== "undefined" && (/aruco\.html$/.test(location.pathname) || location.hash === "#aruco");
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
  covered?: boolean[]; // 正面の各マスについて、読みがそろったか（隠れているマスを画面に示す）
  result?: ScanResult;
  edited?: number[]; // 手で直した状態
  problems?: StateProblem[];
}

export interface AppState {
  screen: Screen;
  analyzeTab: AnalyzeTab;
  solveId: string | null; // 詳しい画面で開いている記録
  panel: Panel;
  camera: "off" | "starting" | "on" | "error";
  cameraError: string | null;
  cameraInfo: CameraInfo | null;
  mirror: boolean; // プレビューを鏡像にする（インカメラ。背面カメラ・デモはしない: facingOf）
  cameras: { id: string; label: string }[];
  vision: "loading" | "ready" | "error"; // error: 画像認識（OpenCV）を読み込めなかった
  visionLoadMs: number;
  demo: boolean;
  scan: ScanUi | null;
  cube: CubeSetup | null;
  track: TrackUpdate | null;
  baseMoves: number; // 「手順をクリア」した位置
  stats: { camFps: number; procFps: number; procMs: number; faces: number };
  // ソルブ中から進めている精密解析（録画からの遅れ。null = 動いていない）
  analysis: { behindMs: number; frames: number } | null;
  toast: string | null;
}

// 面ごとの表示色（標準の 6 色）
export const displayColors = (names: string[]): string[] => names.map((n) => NAMED_COLORS.find((c) => c.id === n)?.display ?? "#888");

// 動画ファイルを解析するフレームの間隔の上限（実際の時間で）。240fps のスロー撮影は 2 枚に 1 枚
export const VIDEO_MAX_FPS = 120;

const LIVE_REST_MAX_MS = 20000; // 止めた後の残りの解析の間、ライブの認識を休むのは長くてもこれだけ

// 追跡の探索と観測器の設定（ライブと精密解析で共通の部分）
const searchOptions = (s: Settings) => ({ beamWidth: s.beamWidth, maxMovesPerStep: s.maxMovesPerStep, rotationCost: s.rotationCost });
const observerOptions = (s: Settings) => ({ stableMs: s.stableMs, ...ARUCO_OBSERVER });

class Controller {
  readonly store = createStore<AppState>({
    screen: openedAruco() ? "analyze" : "play",
    analyzeTab: openedAruco() ? "aruco" : "timer-video",
    solveId: null,
    panel: "timer",
    camera: "off",
    cameraError: null,
    cameraInfo: null,
    mirror: true,
    cameras: [],
    vision: "loading",
    visionLoadMs: 0,
    demo: false,
    scan: null,
    cube: null,
    track: null,
    baseMoves: 0,
    stats: { camFps: 0, procFps: 0, procMs: 0, faces: 0 },
    analysis: null,
    toast: null,
  });
  readonly camera = new CameraSource();
  vision: VisionClient | null = null;
  readonly recorder = new FrameRecorder(); // タイマー計測中の録画（ソルブ後の精密解析用）
  readonly refiner = new RefineClient();
  // 動画ファイルの解析（ソルブ中から進める解析と別の Worker。並べて動かしても追跡を止めない）
  private readonly videoRefiner = new RefineClient();
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
  private session: AnalysisSession | null = null;
  private liveResting = false; // 止めた後の残りの解析の間（ライブの認識を休む）
  private snapLive = true; // ライブの作り変えを使うか（タイマーのスクランブル中は使わない）

  // ライブの作り変え（見えている色に合わせる）を使うか。タイマーのスクランブル中は、前のライブ（一番合う手順を回して見せる）にする
  setLiveSnap(on: boolean): void {
    if (this.snapLive === on) return;
    this.snapLive = on;
    this.vision?.setTrackingOptions(this.liveEngineOptions());
  }

  init(): void {
    if (this.vision) return;
    this.vision = new VisionClient();
    this.refiner.onPhase = (phase) => markPhase(phase);
    this.applySettings(settingsStore.get());
    settingsStore.subscribe((s) => this.applySettings(s));
    this.vision.ready
      .then(({ opencv, ms }) => this.store.set({ vision: opencv ? "ready" : "error", visionLoadMs: ms }))
      .catch(() => this.store.set({ vision: "error" }));
    this.vision.onResult((m) => this.onFrame(m));
    this.camera.onFrame((t) => {
      // 止めた後の残りの解析の間は、ライブの認識を休む（1 秒に何枚も作る画像でメモリの山が高くなり、iPhone で落ちる元になる。
      // 休んでいる間に回した手は、再開したときに見えている色への作り変えで追いつく）
      if (!this.liveResting) this.vision?.submit(this.camera.video, t);
      if (this.recorder.recording) this.recorder.add(this.camera.video, t);
    });
    this.camera.onEnded(() => this.onCameraLost());
    this.statsTimer = window.setInterval(() => {
      const v = this.vision;
      // カメラは「オン」なのに映像が来ない（Windows のカメラ設定・他のアプリ・USB の接触など）
      if (this.store.get().camera === "on" && !this.store.get().demo && this.camera.fps === 0) {
        if (++this.stalled === 6) this.toast("カメラの映像が届いていません。他のアプリがカメラを使っていないか確認してください。", 8000);
      } else this.stalled = 0;
      this.store.set({
        stats: { camFps: this.camera.fps, procFps: v?.procFps ?? 0, procMs: v?.lastProcMs ?? 0, faces: this.latestFrame?.faces.length ?? 0 },
      });
    }, 500);
    // 以前カメラを許可していれば自動で開始。ArUco の画面から始めたときは、メインを開くまで待つ（動画の解析が遅くなるので）
    navigator.permissions
      ?.query({ name: "camera" as PermissionName })
      .then((p) => {
        if (p.state !== "granted") return;
        const start = () => {
          if (this.store.get().camera === "off" && !this.store.get().demo) this.startCamera();
        };
        if (this.store.get().screen === "play") return start();
        const off = this.store.subscribe((st) => {
          if (st.screen !== "play") return;
          off();
          start();
        });
      })
      .catch(() => undefined);
  }

  private applySettings(s: Settings): void {
    if (!this.vision) return;
    this.vision.workWidth = s.workWidth;
    this.vision.setConfig(this.liveConfig());
    this.vision.setTrackingOptions(this.liveEngineOptions(s));
  }

  // 認識の設定（ステッカーの符号・マーカーの配置は STICKERS だけ）。ライブも直前のマーカーの周りだけで検出する（arucoRegion）
  pipelineConfig(): Partial<PipelineConfig> {
    return { ...STICKERS, arucoRegion: true, arucoTrack: true };
  }

  // ライブの認識: 面の格子で追う（arucoGrid。src/vision/arucoFrame.ts の liveMarkers）。回転途中の形（arucoTurn）は使わない。
  // ライブは 1 秒 10 枚前後しか処理できず、回している途中を 3 枚以上続けて捉えることがほとんどないので手がかりにならず、
  // 1 フレームの 3 割ほど（合成の 30fps で 50 → 32ms）を使っていた（精密解析では使う）
  // 色で補う（arucoColorFill）も使わない: 実物の動画（T-perm 2 回）で、色で補ったマスの読み違い（白を赤など）が続いて作り変えが
  // 起き、手順は正しいのに 3D の状態が揃わなかった。合成の 10 手でも手順の正しさは同じで、1 フレーム 17 → 11ms
  liveConfig(): Partial<PipelineConfig> {
    return { ...this.pipelineConfig(), arucoTurn: false, arucoGrid: true, arucoColorFill: false };
  }

  // ライブの追跡: 見えているキューブに従う。手順の知識（PLL など・自分のソルブ）は使わない（精密解析では使う）。
  // 3D は確定した手（有力な仮説がすべて同じ手で一致）だけ回す。有力とみなすコスト差は 1.0（2.5 だと、止めた後も最後の 1〜2 手が
  // 確定しないことが多かった。合成の 10 手で、確定した手だけの正しさ 速い 15/20 → 18/20・普通 15/20 → 18/20・持ち替え 9/12 → 12/12。
  // 残りは写らない面の手で、写らない手は回さない）
  liveEngineOptions(s: Settings = settingsStore.get()): Partial<EngineOptions> {
    return {
      decoder: { ...searchOptions(s), priorWeight: 0, confirmMargin: 1 },
      observer: observerOptions(s),
      // 見え方とはっきり合わなければ、見えている色に合う状態にその場で作り変え、そこから追跡をやり直す（src/track/snap.ts）。
      // スクランブル中は使わない（setLiveSnap。手順を追って案内するので、見えていない面の分からない作り変えは道筋を乱す）
      snapToView: this.snapLive,
    };
  }

  // 精密解析の追跡: 手順の知識と自分のソルブの手順も手がかりにする
  engineOptions(s: Settings = settingsStore.get()): Partial<EngineOptions> {
    return {
      decoder: searchOptions(s),
      observer: observerOptions(s),
      personal: personalSequences(loadSolves()),
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
      // カメラの向きから、鏡像と持ち方基準の表記の向きを決める（インカメラ: 鏡像・自分から見た向き。背面: そのまま・カメラから見た向き）
      const facing = facingOf(info, s.facingMode);
      this.store.set({ camera: "on", cameraInfo: info, mirror: facing === "user" });
      settingsStore.set({ viewpoint: facing === "user" ? "user" : "camera" });
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
    this.cancelAnalysis();
    this.camera.stop();
    this.store.set({ camera: "off" });
  }

  // ---- デモ（合成カメラ） ----

  async startDemo(options: { autoplay?: boolean; seed?: number; script?: import("../synthetic/demo").DemoOptions } = {}): Promise<void> {
    this.init();
    const { SyntheticCube } = await import("../synthetic/syntheticCube");
    this.camera.stop();
    this.synthetic?.stop();
    const syn = new SyntheticCube({ aruco: STICKERS.stickers, design: STICKERS.arucoDesign });
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
    this.cancelAnalysis();
    this.preScanTrack = this.store.get().track;
    this.vision?.stopTracking();
    this.capture.reset();
    this.store.set({ scan: { steps: scanSteps(), step: 0, captured: [], progress: 0 }, track: null });
  }

  cancelScan(): void {
    this.store.set({ scan: null });
    const cube = this.store.get().cube;
    if (!cube) return;
    // スキャン前に追跡していた最新の状態から再開する
    const last = this.preScanTrack;
    if (last) this.startTrackingFrom(Uint8Array.from(last.state));
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
      const coveredChanged = (p.covered ?? []).join() !== (scan.covered ?? []).join();
      if (Math.abs(p.progress - scan.progress) > 0.05 || p.reason !== scan.reason || coveredChanged) this.store.set({ scan: { ...scan, progress: p.progress, reason: p.reason, covered: p.covered } });
      return;
    }
    const captured = [...scan.captured, { face: scan.steps[scan.step].face, labs: p.labs }];
    if (captured.length < 6) {
      this.store.set({ scan: { ...scan, captured, step: scan.step + 1, progress: 0, reason: undefined, covered: undefined } });
      this.beep(880, 0.08);
      return;
    }
    this.beep(1320, 0.12);
    try {
      const result = assembleScan(captured);
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
    this.store.set({ scan: null });
    this.startTrackingFrom(state);
  }

  // 完成状態から始める（色はマーカーの ID で決まるので、スキャンしなくてよい）
  startFromSolved(): void {
    this.startTrackingFrom(solvedState());
  }

  // ---- 追跡 ----

  // 色はマーカーの代表色（src/aruco/palette.ts）
  private startTrackingFrom(state: Uint8Array): void {
    this.epoch++;
    const refs = ARUCO_REFS;
    const cube: CubeSetup = {
      state: Array.from(state),
      refs,
      names: ARUCO_NAMES,
      display: displayColors(ARUCO_NAMES),
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

  // ライブは見えているキューブに従い、精密解析の結果で過去の手を書き換えない。精密解析はタイマーの計測（インスペクションから）だけ
  private restartTracking(state: number[], refs: Lab[]): void {
    this.cancelAnalysis();
    this.vision?.startTracking(state, refs, this.liveEngineOptions());
  }

  // ---- ソルブ中から進める精密解析 ----
  //
  // 録画を少しずつ解析用の Worker に渡し、リアルタイムより重い設定（全体の画像・溝の候補・窓の別の読み・手順の知識）で
  // 1 フレームずつ解き直す。途中結果が届くたびに、リアルタイムの追跡をそれに乗り換える（その後の観測は通し直す）。
  // タイマーでは止めたときに残りを解析して、タイムと手順を確定する（止めてから解析を始めるより早く終わる）。
  // フリーでは遅れたらフレームを間引いて追いつく。タイマーは間引かない（タイムの正確さのため）

  // timed: タイマーの計測（止めたときに結果を使う）。keep: いまの追跡の手のうち、解析の前からある手の数
  async startAnalysis(opts: { state: ArrayLike<number>; refs?: Lab[]; keep: number; timed: boolean }): Promise<boolean> {
    this.cancelAnalysis();
    const s = settingsStore.get();
    const refs = opts.refs ?? this.store.get().track?.refs ?? this.store.get().cube?.refs;
    // 前回の解析中に 2 回落ちていたら解析しない（速報値のまま。設定から戻せる: src/app/crashGuard.ts）
    if (!s.analyzeSolves || safeLevel() >= 2 || !refs || this.store.get().camera !== "on" || !FrameRecorder.available()) return false;
    this.recorder.clear();
    const session: AnalysisSession = { id: -1, keep: opts.keep, timed: opts.timed, timer: 0, started: false, from: performance.now(), input: null as unknown as RefineInput };
    this.session = session;
    // 始められなかった・待っている間に別の解析に替わった
    const abandon = () => {
      if (this.session === session) this.session = null;
      return false;
    };
    if (!(await this.recorder.start(this.camera.video, s.workWidth, opts.timed ? 150000 : 20000)) || this.session !== session) return abandon();
    session.from = performance.now();
    session.input = {
      state: Array.from(opts.state),
      refs,
      from: session.from,
      to: Infinity,
      engine: this.engineOptions(),
      pipeline: this.pipelineConfig(),
      ...(opts.timed ? {} : { keepPatchesMs: 3000 }),
      ...(safeLevel() === 1 ? { light: true } : {}),
    };
    const id = await this.refiner.startStream((p) => this.onAnalysisPartial(session, p));
    if (id === null || this.session !== session) return abandon();
    session.id = id;
    session.timer = window.setInterval(() => this.feedAnalysis(session), 250);
    return true;
  }

  private feedAnalysis(session: AnalysisSession, untilMs = Infinity): void {
    const rec = this.recorder.takeNew(untilMs);
    if (!rec || session.id < 0 || !rec.chunks.length) return;
    this.refiner.feed(session.id, rec, session.started ? undefined : session.input);
    session.started = true;
  }

  private onAnalysisPartial(session: AnalysisSession, p: StreamPartial): void {
    if (this.session !== session) return;
    // ライブには反映しない（見えているキューブに従う）。遅れだけ画面に出す
    this.store.set({ analysis: { behindMs: p.behindMs, frames: p.frames } });
  }

  // タイマーを止めた: to までの録画を渡し切り、終わりの状態（完成）で解き直した結果を待つ Promise を返す
  async endAnalysis(to: number, target: ArrayLike<number> | null, progress?: (p: number) => void): Promise<Promise<RefineResult> | null> {
    const session = this.session;
    if (!session || session.id < 0 || !session.timed) return null;
    clearInterval(session.timer);
    this.session = null;
    this.store.set({ analysis: null });
    await this.recorder.finish(to);
    this.feedAnalysis(session, to);
    // 解析が途中で失敗した（Worker が落ちた・例外）ときのために、録画全体を取っておく（圧縮した映像のかたまりを指すだけ）
    const backup = this.recorder.extract(session.from, to);
    this.recorder.clear(); // 渡し終えた録画は使わない（解析の Worker が自分の分を持っている）
    // 時間がかかっても結果は出す: 失敗したら、Worker を作り直して軽い設定で録画全体を最初から解析し直す
    const result = this.refiner.endStream(session.id, to, target, progress).catch(async (e) => {
      if (!backup) throw e;
      console.warn("解析をやり直します", e);
      this.refiner.close();
      return this.refiner.run(backup, { ...session.input, to, light: true }, progress);
    });
    this.liveResting = true;
    const rest = window.setTimeout(() => (this.liveResting = false), LIVE_REST_MAX_MS);
    // 終わったら解析の Worker を閉じてメモリを返す（次のインスペクションで作り直す）
    void result
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(rest);
        this.liveResting = false;
        this.refiner.closeIfIdle();
      });
    return result;
  }

  cancelAnalysis(): void {
    const session = this.session;
    if (!session) return;
    markPhase(null);
    clearInterval(session.timer);
    if (session.id >= 0) this.refiner.cancelStream(session.id);
    this.session = null;
    this.recorder.clear();
    this.store.set({ analysis: null });
  }


  // キューブを完成させた（見失った後など）: 完成状態からやり直す
  resetToSolved(): void {
    this.startTrackingFrom(solvedState());
    this.toast("完成状態から追跡し直します");
  }

  // 動画ファイル（スマホのカメラアプリで撮ったスロー撮影など）を精密解析する。state: 動画の始まりの状態、target: 終わりの状態
  // （タイマーなら完成。分からなければ null）
  analyzeVideo(
    file: Blob,
    opts: { state: ArrayLike<number>; target: ArrayLike<number> | null; captureFps?: number; maxFps?: number },
    progress?: (p: number) => void,
    onInfo?: (info: VideoFileInfo, analyzedFrames: number) => void,
  ): { result: Promise<RefineResult>; cancel: () => void } {
    const s = settingsStore.get();
    const input: RefineInput = { state: Array.from(opts.state), refs: ARUCO_REFS, from: 0, to: Infinity, engine: this.engineOptions(), pipeline: this.pipelineConfig() };
    return this.videoRefiner.runVideo(file, input, opts.target, { maxSide: s.workWidth, captureFps: opts.captureFps, maxFps: opts.maxFps ?? VIDEO_MAX_FPS }, progress, onInfo);
  }

  clearMoves(): void {
    this.store.set({ baseMoves: this.store.get().track?.moves.length ?? 0 });
  }

  // 直近のキューブの連続的な向き（キューブ固定 → カメラの四元数）。記録の詳しい画面の 3D で、カメラから見えた傾きのまま再生する
  readonly poseLog: { t: number; q: number[] }[] = [];
  private onFrame(m: FrameMessage): void {
    this.latestFrame = m;
    if (m.pose) {
      const r = mul(m.pose.R as Mat3, ORIENTATIONS[m.pose.orient]);
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1));
      this.poseLog.push({ t: m.t, q: [q.x, q.y, q.z, q.w] });
      while (this.poseLog.length && m.t - this.poseLog[0].t > 180000) this.poseLog.shift();
    }
    for (const l of this.frameListeners) l(m);
    if (this.store.get().scan) this.onScanFrame(m);
    if (m.track) {
      this.store.set({ track: m.track });
      for (const l of this.trackListeners) l(m.track);
    }
  }

  // ---- 効果音 ----
  // 層を回した音（記録の再生）: 短いノイズを帯域で絞って、カチッという音にする
  turnSound(): void {
    if (!settingsStore.get().sound) return;
    try {
      this.audio ??= new AudioContext();
      const a = this.audio;
      const len = Math.floor(a.sampleRate * 0.06);
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const src = a.createBufferSource();
      src.buffer = buf;
      const bp = a.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1800 + Math.random() * 600;
      bp.Q.value = 1.2;
      const gain = a.createGain();
      gain.gain.value = 0.5;
      src.connect(bp).connect(gain).connect(a.destination);
      src.start();
    } catch {
      // 音が出せない環境
    }
  }

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

interface AnalysisSession {
  id: number; // 解析 Worker の中の番号（始まるまで -1）
  keep: number;
  timed: boolean;
  timer: number;
  started: boolean;
  from: number;
  input: RefineInput;
}

export const controller = new Controller();
export type { Controller };
