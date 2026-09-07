/**
 * 追跡の数値評価。「見た感じ動いた」で終わらせないための土台。
 *
 * 既知の3D姿勢列から合成フレームを作り、正解の面四角形・セル中心と
 * 推定値の px 誤差を測る。実機録画が無くてもアルゴリズム変更の影響を数値で見られる。
 */

import {
  renderFrame, defaultCamera, defaultPose, groundTruth,
  type Camera3D, type CubePose, type RenderOptions, type VisibleFaceId,
} from './cubeRender';
import { rgbaToGray, type GrayImage } from '../tracking/opticalFlow';
import { CubeTracker } from '../tracking/cubeTracker';
import { defaultTrackingConfig, type TrackingConfig, type TrackingStatus } from '../tracking/types';
import { applyH, homographyFromQuad, type Point2D, type Quad } from '../tracking/geometry';
import { makeRng, type Rng } from '../core/cube';

export interface MotionScenario {
  name: string;
  frames: number;
  /** フレーム i の姿勢 */
  pose(i: number, base: CubePose): CubePose;
  /** フレーム i のレンダリング設定（遮蔽・ぼかし・ノイズ） */
  render?(i: number, rng: Rng): RenderOptions;
  /** この区間は遮蔽されている想定（復帰率の計算に使う） */
  occludedRange?: [number, number];
  /** 追跡が破綻すべきシナリオか */
  expectLost?: boolean;
  /** 誤差評価から外すフレーム（遮蔽中など） */
  skipErrorRange?: [number, number];
}

export interface TrackingMetrics {
  name: string;
  frames: number;
  /** 正解頂点との平均/最大 px 誤差（評価対象フレームのみ） */
  cornerErrorMean: number;
  cornerErrorMax: number;
  /** 正解セル中心との平均/最大 px 誤差 */
  cellErrorMean: number;
  cellErrorMax: number;
  /** 最後の 20% のフレームでの平均セル誤差。復帰後に精度が戻るかを見る */
  cellErrorFinal: number;
  /**
   * 誤追跡率。「可視」と主張した面のうち、実際には誤差が大きかった割合。
   * 追跡が苦しいときに黙って嘘をつかないことの確認。ここは 0 に近くなければならない。
   */
  falseVisibleRate: number;
  /** 平均可視面数 / 3。追跡できている面の割合 */
  visibleFaceRate: number;
  /** LOST せずに追えたフレーム数 / 全フレーム */
  survivalFrames: number;
  survivalRate: number;
  trackingFrames: number;
  degradedFrames: number;
  lostFrames: number;
  /** 遮蔽区間の後に TRACKING へ戻れたか */
  recovered: boolean | null;
  meanConfidence: number;
  meanTrackMs: number;
  statuses: TrackingStatus[];
  /** 評価に使えたフレーム数 */
  evaluatedFrames: number;
}

/** これを超える誤差の面を「可視」と主張していたら誤追跡とみなす（px） */
export const FALSE_TRACKING_PX = 8;

export interface EvalOptions {
  camera?: Camera3D;
  basePose?: CubePose;
  config?: Partial<TrackingConfig>;
  seed?: number;
  /** 初期化方法。'gt' は正解四角形から、'tap' はタップ位置から */
  init?: 'gt' | 'tap';
  /** 各フレームの状態を受け取る（デバッグ用） */
  onFrame?(i: number, gray: GrayImage, state: ReturnType<CubeTracker['snapshot']>): void;
}

const FACE_ORDER: VisibleFaceId[] = ['U', 'F', 'R'];

function cellCentersFromQuad(q: Quad): Point2D[] {
  const H = homographyFromQuad(q);
  if (!H) return [];
  const out: Point2D[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(applyH(H, (c * 2 + 1) / 6, (r * 2 + 1) / 6));
  }
  return out;
}

export function runScenario(scenario: MotionScenario, opts: EvalOptions = {}): TrackingMetrics {
  const cam = opts.camera ?? defaultCamera();
  const base = opts.basePose ?? defaultPose();
  const rng = makeRng(opts.seed ?? 12345);
  const tracker = new CubeTracker({ ...defaultTrackingConfig(), ...opts.config });
  tracker.collectPoints = false;

  let cornerSum = 0;
  let cornerMax = 0;
  let cellSum = 0;
  let cellMax = 0;
  let cornerN = 0;
  let cellN = 0;
  let evalN = 0;
  let visibleFaceSum = 0;
  let visiblePairs = 0;
  let falsePairs = 0;
  const perFrameCellError: { i: number; e: number }[] = [];
  let confSum = 0;
  let msSum = 0;
  let survival = 0;
  let survivalDone = false;
  const statuses: TrackingStatus[] = [];
  const counts: Record<string, number> = { TRACKING: 0, DEGRADED: 0, LOST: 0, INITIALIZING: 0, UNINITIALIZED: 0 };

  for (let i = 0; i < scenario.frames; i++) {
    const pose = scenario.pose(i, base);
    const ropts: RenderOptions = { rng, ...(scenario.render ? scenario.render(i, rng) : {}) };
    const frame = renderFrame(pose, cam, ropts);
    const gray = rgbaToGray(frame.rgba, frame.width, frame.height);
    const gt = groundTruth(pose, cam);
    const t = i * 16.7;

    if (i === 0) {
      const ok = opts.init === 'tap'
        ? tracker.initialize(gray, {
            kind: 'tap',
            point: { x: cam.cx, y: cam.cy },
            radius: Math.min(cam.width, cam.height) * 0.18,
          }, t)
        : tracker.initialize(gray, {
            kind: 'quads',
            quads: FACE_ORDER.map((id) => gt.find((f) => f.id === id)!.quad),
          }, t);
      if (!ok) {
        statuses.push('LOST');
        counts.LOST++;
        break;
      }
      statuses.push(tracker.currentStatus);
      counts[tracker.currentStatus]++;
      continue;
    }

    const state = tracker.step(gray, t);
    opts.onFrame?.(i, gray, state);
    statuses.push(state.status);
    counts[state.status] = (counts[state.status] ?? 0) + 1;
    confSum += state.confidence;
    msSum += tracker.timing.totalMs;
    if (state.status === 'LOST') survivalDone = true;
    else if (!survivalDone) survival = i;

    const skip = scenario.skipErrorRange;
    const inSkip = skip && i >= skip[0] && i <= skip[1];
    if (state.status === 'LOST' || inSkip) continue;
    let frameCell = 0;
    let frameCellN = 0;

    // 誤差は「トラッカーが可視と主張した面」だけで測る。
    // 可視でないと明示した面は下流の色サンプリングにも使われないので、
    // そこの誤差を混ぜると追跡の正直さを評価できない。
    let evaluatedThisFrame = false;
    for (const id of FACE_ORDER) {
      const g = gt.find((f) => f.id === id)!;
      const e = state.faces.find((f) => f.id === id);
      if (!e) continue;
      if (e.visible) visibleFaceSum++;
      if (!e.visible) continue;
      evaluatedThisFrame = true;
      for (let k = 0; k < 4; k++) {
        const d = Math.hypot(e.corners[k].x - g.quad[k].x, e.corners[k].y - g.quad[k].y);
        cornerSum += d;
        cornerN++;
        cornerMax = Math.max(cornerMax, d);
      }
      const cells = cellCentersFromQuad(e.corners);
      let faceCell = 0;
      let faceCellN = 0;
      for (let k = 0; k < 9 && k < cells.length; k++) {
        const d = Math.hypot(cells[k].x - g.cellCenters[k].x, cells[k].y - g.cellCenters[k].y);
        cellSum += d;
        cellN++;
        faceCell += d;
        faceCellN++;
        frameCell += d;
        frameCellN++;
        cellMax = Math.max(cellMax, d);
      }
      visiblePairs++;
      if (faceCellN && faceCell / faceCellN > FALSE_TRACKING_PX) falsePairs++;
    }
    if (frameCellN) perFrameCellError.push({ i, e: frameCell / frameCellN });
    if (evaluatedThisFrame) evalN++;
  }

  const stepFrames = Math.max(1, statuses.length - 1);
  let recovered: boolean | null = null;
  if (scenario.occludedRange) {
    const after = statuses.slice(scenario.occludedRange[1] + 1);
    recovered = after.some((s) => s === 'TRACKING');
  }

  void evalN;
  const tail = perFrameCellError.filter((r) => r.i >= scenario.frames * 0.8);
  const cellErrorFinal = tail.length ? tail.reduce((a, r) => a + r.e, 0) / tail.length : NaN;

  return {
    name: scenario.name,
    frames: statuses.length,
    cornerErrorMean: cornerN ? cornerSum / cornerN : NaN,
    cornerErrorMax: cornerMax,
    cellErrorMean: cellN ? cellSum / cellN : NaN,
    cellErrorMax: cellMax,
    cellErrorFinal,
    falseVisibleRate: visiblePairs ? falsePairs / visiblePairs : 0,
    visibleFaceRate: visibleFaceSum / (stepFrames * FACE_ORDER.length),
    survivalFrames: survival,
    survivalRate: survival / stepFrames,
    trackingFrames: counts.TRACKING,
    degradedFrames: counts.DEGRADED,
    lostFrames: counts.LOST,
    recovered,
    meanConfidence: confSum / stepFrames,
    meanTrackMs: msSum / stepFrames,
    statuses,
    evaluatedFrames: evalN,
  };
}

// ---------------------------------------------------------------------------
// 標準シナリオ
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

export function standardScenarios(): MotionScenario[] {
  return [
    {
      name: 'static',
      frames: 60,
      pose: (_i, b) => b,
    },
    {
      name: 'translate',
      frames: 90,
      // 5秒弱かけて画面内を大きく往復する
      pose: (i, b) => ({ ...b, tx: b.tx + 1.6 * Math.sin((i / 90) * TAU), ty: b.ty + 0.7 * Math.sin((i / 45) * TAU) }),
    },
    {
      name: 'scale',
      frames: 90,
      // 近づけたり遠ざけたり
      pose: (i, b) => ({ ...b, tz: b.tz * (1 + 0.32 * Math.sin((i / 90) * TAU)) }),
    },
    {
      name: 'rotate-small',
      frames: 90,
      pose: (i, b) => ({ ...b, rz: b.rz + 0.28 * Math.sin((i / 90) * TAU) }),
    },
    {
      name: 'perspective',
      frames: 90,
      // 姿勢そのものを傾ける。見え方が台形として大きく変わる
      pose: (i, b) => ({
        ...b,
        rx: b.rx + 0.2 * Math.sin((i / 90) * TAU),
        ry: b.ry + 0.24 * Math.sin((i / 60) * TAU + 1),
      }),
    },
    {
      name: 'combined',
      frames: 120,
      pose: (i, b) => ({
        ...b,
        tx: b.tx + 1.0 * Math.sin((i / 80) * TAU),
        ty: b.ty + 0.5 * Math.cos((i / 55) * TAU),
        tz: b.tz * (1 + 0.16 * Math.sin((i / 70) * TAU)),
        rx: b.rx + 0.13 * Math.sin((i / 65) * TAU),
        ry: b.ry + 0.15 * Math.cos((i / 50) * TAU),
        rz: b.rz + 0.1 * Math.sin((i / 40) * TAU),
      }),
    },
    {
      name: 'noisy-blur',
      frames: 90,
      pose: (i, b) => ({ ...b, tx: b.tx + 0.9 * Math.sin((i / 70) * TAU), ry: b.ry + 0.1 * Math.sin((i / 45) * TAU) }),
      render: () => ({ noise: 7, blur: 1 }),
    },
    {
      name: 'fast-motion',
      frames: 50,
      // 1フレームあたり約15px の等速移動（往復）。モーションブラー付き。
      // 画面内に収まる範囲で、LK のピラミッド探索の限界に近い速さ。
      pose: (i, b) => {
        const k = i <= 12 ? i : i <= 24 ? 24 - i : 0;
        return { ...b, tx: b.tx + 0.25 * k };
      },
      render: () => ({ blur: 2 }),
    },
    {
      // 手でキューブの一部を隠す。要件が想定している遮蔽はこちら
      name: 'partial-occlusion',
      frames: 100,
      pose: (i, b) => ({ ...b, tx: b.tx + 0.5 * Math.sin((i / 80) * TAU) }),
      // F 面（x 139-278 / y 161-271）だけを覆う。U と R は見えたまま。
      render: (i) => (i >= 35 && i <= 55
        ? { occlusion: { x: 130, y: 168, w: 155, h: 115 } }
        : {}),
      occludedRange: [35, 55],
      skipErrorRange: [35, 60],
    },
    {
      // 全面を短時間だけ隠す。復帰には局所再検出が要る
      name: 'brief-full-occlusion',
      frames: 100,
      pose: (i, b) => ({ ...b, tx: b.tx + 0.5 * Math.sin((i / 80) * TAU) }),
      render: (i) => (i >= 35 && i <= 47
        ? { occlusion: { x: 90, y: 40, w: 320, h: 290 } }
        : {}),
      occludedRange: [35, 47],
      skipErrorRange: [35, 60],
    },
    {
      name: 'full-occlusion',
      frames: 90,
      pose: (_i, b) => b,
      // 30フレーム目以降ずっと全面が隠れる。LOST に落ちなければならない
      render: (i) => (i >= 30 ? { occlusion: { x: 0, y: 0, w: 480, h: 360 } } : {}),
      expectLost: true,
      skipErrorRange: [30, 999],
    },
    {
      name: 'cube-removed',
      frames: 110,
      // 40フレーム目で画面外へ飛ばす（別物体に貼り付かないことの確認）
      pose: (i, b) => (i < 40 ? b : { ...b, tx: b.tx + 40, tz: b.tz }),
      expectLost: true,
      skipErrorRange: [40, 999],
    },
  ];
}
