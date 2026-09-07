/**
 * キューブ姿勢追跡エンジン。
 *
 * 純粋モジュール。入力はグレースケール画像と時刻だけで、カメラも DOM も知らない。
 * 合成フレームを流し込めば Node でそのまま数値評価できる。
 *
 * 方針（CLAUDE.md 原則 §2 と同じ考え方）:
 *   毎フレーム全画面から再検出しない。「前フレームのモデルを動かして、
 *   観測と整合するかを確かめる」方向で解く。整合しなければ正直に落とす。
 *
 * このレイヤが吸収するのは **カメラ内でのキューブ全体の位置・姿勢変化** だけ。
 * ステッカー配置の変化（= 面回転）は既存の core/tracker.ts が判定する。
 * ここで回転手を推定してはいけない。
 */

import {
  applyH, homographyFromQuad, quadFromHomography, ransacHomography, reprojectionError,
  validateQuad, defaultQuadLimits, smoothQuad, cloneQuad, quadArea, solve2x2Map,
  maxCornerJump, identity3 as identityMat,
  type Mat3, type Point2D, type Quad, type QuadLimits,
} from './geometry';
import {
  buildPyramid, trackPoints, defaultFlowOptions,
  type FlowOptions, type GrayImage, type Pyramid,
} from './opticalFlow';
import {
  hexFromFaces, hexToFaces, refineHexModel, isPlausibleHex, seedHexFromTap, hexFromCorners,
  hexEdgeSupport, gridLockScore, faceScalePx, snapToGrid, shiftHomographyPublic,
  SHARED_VERTEX_GROUPS, VISIBLE_FACE_IDS,
  type HexModel, type VisibleFaceId,
} from './hexModel';
import {
  defaultTrackingConfig,
  type CubeTrackingState, type InitHint, type TrackedFace, type TrackedPointDebug,
  type TrackingConfig, type TrackingStatus,
} from './types';

/**
 * 特徴点の面内座標。黒い枠線の交点・T字部・面の角に置く。
 * ステッカー中央は単色でテクスチャが無く LK が解けない（tests/opticalFlow.test.ts）。
 *
 * 外周は inset だけ内側に寄せる。縁ちょうどに置くと LK の窓に背景や
 * 隣接面（別平面）が入り、系統ドリフトの原因になる。
 */
export function featureUv(inset: number): [number, number][] {
  const lo = Math.max(0, Math.min(0.25, inset));
  const hi = 1 - lo;
  const out: [number, number][] = [];
  for (const v of [lo, 1 / 3, 2 / 3, hi]) for (const u of [lo, 1 / 3, 2 / 3, hi]) out.push([u, v]);
  return out;
}

/** 既定の配置（設定を変えない場合）。 */
export const FEATURE_UV: [number, number][] = featureUv(0.05);
export const FEATURE_COUNT = 16;

interface FaceState {
  id: VisibleFaceId;
  corners: Quad;
  H: Mat3;
  confidence: number;
  inliers: number;
  totalPoints: number;
  error: number;
  measured: boolean;
  /** 連続で観測できなかったフレーム数 */
  missFrames: number;
  /** 直近のグリッドロック比 */
  lock: number;
}

export interface TrackStepTiming {
  flowMs: number;
  homographyMs: number;
  totalMs: number;
}

export class CubeTracker {
  config: TrackingConfig;
  flowOptions: FlowOptions;
  quadLimits: QuadLimits;

  private status: TrackingStatus = 'UNINITIALIZED';
  private faces: FaceState[] = [];
  private prevPyramid: Pyramid | null = null;
  private confidence = 0;
  private lastGood = 0;
  private degradedFrames = 0;
  private goodStreak = 0;
  private initFrames = 0;
  private reason: string | null = null;
  private lastPoints: TrackedPointDebug[] = [];
  private lastError = 0;
  /** 直近の妥当なモデル。再検出の出発点になる */
  private lastHex: HexModel | null = null;
  /**
   * グリッドロック比。1 付近 = キューブのグリッドに乗っていない。
   * 背景のテクスチャに貼り付いたまま高い信頼度を出す事故を防ぐ要。
   */
  private lastLock = 1;
  /** 直近フレームで直接観測できた面の数 */
  private lastUsableFaces = 3;
  /** 全ての面を見失っている連続フレーム数 */
  private blindFrames = 0;

  timing: TrackStepTiming = { flowMs: 0, homographyMs: 0, totalMs: 0 };
  private featurePoints: [number, number][] = FEATURE_UV;
  /** デバッグ点を集めるか。false だと少し速い */
  collectPoints = true;

  constructor(config: TrackingConfig = defaultTrackingConfig(), flow: FlowOptions = defaultFlowOptions()) {
    this.config = config;
    this.flowOptions = flow;
    this.quadLimits = defaultQuadLimits();
    this.featurePoints = featureUv(config.featureInset);
  }

  // -------------------------------------------------------------------------
  // 初期化
  // -------------------------------------------------------------------------

  /**
   * 追跡を開始する。段階的フォールバック（CLAUDE 指示の Level1〜3）に対応する。
   * @returns 成功したか
   */
  initialize(gray: GrayImage, hint: InitHint, t = 0): boolean {
    this.featurePoints = featureUv(this.config.featureInset);
    let model: HexModel | null = null;
    /** 与えられた四角形をそのまま使う場合。六角形モデルはアフィン近似なので、
     *  透視を含む正確な四角形を往復させると系統誤差が入る。 */
    let directQuads: Record<VisibleFaceId, Quad> | null = null;

    if (hint.kind === 'quads' && hint.quads && hint.quads.length >= 3) {
      const q = hint.quads;
      directQuads = { U: q[0], F: q[1], R: q[2] };
      model = hexFromFaces(directQuads);
    } else if (hint.kind === 'corners' && hint.corners) {
      const [n, a, b, c] = hint.corners;
      model = hexFromCorners(n, a, b, c);
    } else if (hint.kind === 'box' && hint.box) {
      const { x, y, w, h } = hint.box;
      model = seedHexFromTap({ x: x + w / 2, y: y + h / 2 }, Math.min(w, h) * 0.5);
    } else if (hint.kind === 'tap' && hint.point) {
      model = seedHexFromTap(hint.point, hint.radius ?? Math.min(gray.width, gray.height) * 0.18);
    }

    if (!model || !isPlausibleHex(model)) {
      this.fail('初期モデルが作れませんでした');
      return false;
    }

    // 四角形を直接与えられた場合は、ユーザー（または上流）が合わせた位置をそのまま尊重する。
    // それ以外（タップ / 矩形 / 4隅指定）は六角形モデルなので、輪郭に吸着させて整える。
    //
    // 注意: 六角形モデルはアフィン近似で、透視による「対辺が平行でない」ぶんを
    // 表現できない。強い透視ではここに系統誤差が残る（実測で最大 40px 弱）。
    // 追跡が始まれば面ごとの射影変換になるが、ずれが1セルに近いと
    // 隣のセルに吸着してしまうため、初期化の精度は重要。
    if (!directQuads) {
      const refined = refineHexModel(gray, model, {
        initialStep: hint.kind === 'corners'
          ? Math.min(gray.width, gray.height) * 0.02
          : Math.min(gray.width, gray.height) * 0.05,
        minStep: 0.4,
        passesPerStep: 4,
        samplesPerEdge: 16,
      });
      if (isPlausibleHex(refined.model)) model = refined.model;
    }

    const quads = directQuads ?? hexToFaces(model);
    const faces: FaceState[] = [];
    for (const id of VISIBLE_FACE_IDS) {
      const corners = quads[id];
      const v = validateQuad(corners, this.quadLimits);
      if (!v.ok) {
        this.fail(`初期化に失敗: ${id} 面が不正 (${v.reasons.join(',')})`);
        return false;
      }
      const H = homographyFromQuad(corners);
      if (!H) {
        this.fail(`初期化に失敗: ${id} 面のホモグラフィが解けません`);
        return false;
      }
      faces.push({
        id, corners, H, confidence: 1, inliers: this.featurePoints.length,
        totalPoints: this.featurePoints.length, error: 0, measured: true, missFrames: 0, lock: 2,
      });
    }

    this.faces = faces;
    this.lastHex = model;
    this.prevPyramid = buildPyramid(gray, this.flowOptions.levels);
    this.status = 'INITIALIZING';
    this.initFrames = 0;
    this.degradedFrames = 0;
    this.goodStreak = 0;
    this.confidence = 1;
    this.lastGood = t;
    this.reason = null;
    this.lastPoints = [];
    this.lastLock = this.measureLock(gray);
    return true;
  }

  /** 3面の平均グリッドロック比。 */
  private measureLock(gray: GrayImage): number {
    if (!this.faces.length) return 1;
    let s = 0;
    for (const f of this.faces) s += gridLockScore(gray, f.H);
    return s / this.faces.length;
  }

  reset(): void {
    this.status = 'UNINITIALIZED';
    this.faces = [];
    this.prevPyramid = null;
    this.confidence = 0;
    this.degradedFrames = 0;
    this.goodStreak = 0;
    this.initFrames = 0;
    this.reason = null;
    this.lastPoints = [];
    this.lastHex = null;
  }

  private fail(reason: string): void {
    this.status = 'LOST';
    this.reason = reason;
    this.confidence = 0;
    this.prevPyramid = null;
  }

  // -------------------------------------------------------------------------
  // 1フレーム分の追跡
  // -------------------------------------------------------------------------

  step(gray: GrayImage, t: number): CubeTrackingState {
    const t0 = now();

    if (this.status === 'UNINITIALIZED' || this.status === 'LOST' || !this.prevPyramid) {
      this.timing = { flowMs: 0, homographyMs: 0, totalMs: now() - t0 };
      return this.snapshot();
    }

    const pyr = buildPyramid(gray, this.flowOptions.levels);

    // --- 特徴点を前フレームのモデル位置から張り直す ---
    // 点をフレーム間で引き継ぐと誤差が溜まるので、毎フレーム正準位置に置き直す。
    // 「点を追う」のではなく「モデルを追う」ためのループ。
    const src: number[] = [];
    const faceOf: number[] = [];
    const uvOf: [number, number][] = [];
    const p: Point2D = { x: 0, y: 0 };
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      for (const [u, v] of this.featurePoints) {
        applyH(f.H, u, v, p);
        src.push(p.x, p.y);
        faceOf.push(fi);
        uvOf.push([u, v]);
      }
    }

    const tFlow = now();
    const flow = trackPoints(this.prevPyramid, pyr, src, this.flowOptions);
    const flowMs = now() - tFlow;

    // --- 面ごとにホモグラフィを再推定 ---
    const tHomo = now();
    const rng = mulberry(0x5eed + Math.floor(t) % 65536);
    const newCorners: (Quad | null)[] = [];
    const inlierFlags = new Uint8Array(flow.length);
    const results: { inliers: number; error: number }[] = [];

    for (let fi = 0; fi < this.faces.length; fi++) {
      const corr: number[] = [];
      const globalIdx: number[] = [];
      for (let i = 0; i < flow.length; i++) {
        if (faceOf[i] !== fi || !flow[i].ok) continue;
        const [u, v] = uvOf[i];
        globalIdx.push(i);
        corr.push(u, v, flow[i].x, flow[i].y);
      }
      const n = globalIdx.length;
      // 見失っている面は、戻ってこられるように下限を緩める。
      // 誤った再ロックは後段の整合ゲートとグリッドロックで弾く。
      const minPts = this.faces[fi].measured ? this.config.minInliersPerFace : 4;
      if (n < minPts) {
        newCorners.push(null);
        results.push({ inliers: n, error: Infinity });
        continue;
      }
      const idx = globalIdx.map((_, k) => k);
      const r = ransacHomography(corr, idx, {
        threshold: this.config.ransacThreshold,
        iterations: this.config.ransacIterations,
        rng,
      });
      if (!r || r.inliers.length < minPts) {
        newCorners.push(null);
        results.push({ inliers: r ? r.inliers.length : 0, error: Infinity });
        continue;
      }
      // インライアが面内で偏っていると、四隅はデータの外側への外挿になり破綻する。
      // 「点は足りているが片側だけ」という状態を弾く（手で半分隠れたときに起きる）。
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (const k of r.inliers) {
        const [u, v] = uvOf[globalIdx[k]];
        u0 = Math.min(u0, u); u1 = Math.max(u1, u);
        v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const spread = Math.max(0, u1 - u0) * Math.max(0, v1 - v0);
      if (spread < this.config.minInlierSpread) {
        newCorners.push(null);
        results.push({ inliers: r.inliers.length, error: Infinity });
        continue;
      }
      for (const k of r.inliers) inlierFlags[globalIdx[k]] = 1;
      newCorners.push(quadFromHomography(r.H));
      results.push({ inliers: r.inliers.length, error: r.error });
    }

    // --- 妥当性検証 ---
    const accepted: (Quad | null)[] = [];
    for (let fi = 0; fi < this.faces.length; fi++) {
      const cand = newCorners[fi];
      if (!cand) {
        accepted.push(null);
        continue;
      }
      const v = validateQuad(cand, this.quadLimits, this.faces[fi].corners);
      accepted.push(v.ok ? cand : null);
      if (!v.ok) results[fi] = { inliers: results[fi].inliers, error: Infinity };
    }

    // --- モデル全体の形が立方体としてありえるか ---
    // 立方体の3可視面の面積は同程度になる。片方が極端に膨らんだら、
    // どこかで当てはめが外れている。個々の面の検証だけでは
    // ゆっくり膨らむ破綻を止められない（実測で確認）。
    const areas = accepted.map((q) => (q ? quadArea(q) : 0)).filter((a) => a > 0);
    if (areas.length >= 2) {
      const ratio = Math.max(...areas) / Math.max(1e-6, Math.min(...areas));
      if (ratio > this.config.maxFaceAreaRatio) {
        for (let fi = 0; fi < accepted.length; fi++) {
          accepted[fi] = null;
          results[fi] = { inliers: 0, error: Infinity };
        }
      }
    }

    // --- 面ごとに「本当にキューブのグリッドに乗っているか」を確かめる ---
    // 特徴点の整合だけでは、背景のテクスチャや1セルずれた位置にも
    // 自己整合的に貼り付けてしまう。ここで歯止めをかける。
    const usable: boolean[] = [];
    const locks: number[] = [];
    for (let fi = 0; fi < this.faces.length; fi++) {
      const q = accepted[fi];
      let lock = 0;
      if (q) {
        const H = homographyFromQuad(q);
        if (H) lock = gridLockScore(gray, H);
      }
      locks.push(lock);
      usable.push(!!q && (!this.config.useGridSupport || lock >= this.config.minGridLock));
    }

    // --- 使えない面を剛体構造から再構成する ---
    const predicted: (Quad | null)[] = accepted.map((q, i) => (usable[i] ? null : q));
    if (this.config.predictFailedFaces) {
      const work: (Quad | null)[] = accepted.slice();
      this.reconstructMissing(work, usable);
      for (let fi = 0; fi < work.length; fi++) {
        if (usable[fi]) continue;
        const measured = accepted[fi];
        const pred = work[fi];
        if (!pred) continue;
        // 見失っていた面が戻ってくるとき、観測が予測から大きく飛んでいたら
        // 採用しない。グリッドは1セル周期なので、ずれた位置にも自己整合的に
        // 貼り付いてしまう（実測で1セルずれたまま高い信頼度が出た）。
        if (measured) {
          const scale = faceScalePx(homographyFromQuad(pred) ?? identityMat());
          const jump = maxCornerJump(measured, pred);
          // 復帰の条件は継続より厳しくする（ヒステリシス）。
          // 緩い条件で戻すと、点数が少なく偏った当てはめがそのまま通ってしまう。
          if (jump <= scale * this.config.maxReentryJumpRatio &&
              results[fi].inliers >= this.config.minInliersPerFace) {
            const H = homographyFromQuad(measured);
            const lockM = H ? gridLockScore(gray, H) : 0;
            if (lockM >= this.config.fullGridLock) {
              accepted[fi] = measured;
              locks[fi] = lockM;
              usable[fi] = true;
              continue;
            }
          }
        }
        // 予測面をグリッドへ吸着させる。半セル未満に制限しているので
        // セル単位で飛ぶことはない。累積した予測誤差をここで戻す。
        let finalQuad = pred;
        const Hp = homographyFromQuad(pred);
        if (Hp && this.config.snapPredictedFaces) {
          const snap = snapToGrid(gray, Hp, this.config.maxSnapShift);
          if (snap.improved) {
            // 吸着は幾何の補正であって観測の証拠ではない。
            // ここで usable にすると「見えていないのに可視」と主張してしまう。
            finalQuad = quadFromHomography(shiftHomographyPublic(Hp, snap.du, snap.dv));
            locks[fi] = snap.lock;
          } else {
            locks[fi] = snap.lock;
          }
        }
        accepted[fi] = finalQuad;
        predicted[fi] = finalQuad;
      }
    }

    // --- 共有頂点を一致させる ---
    if (this.config.enforceSharedEdges) this.enforceShared(accepted, results, usable);

    // --- 面状態を更新 ---
    let confSum = 0;
    let errSum = 0;
    let errN = 0;
    let totalInliers = 0;
    let totalPoints = 0;
    let usableCount = 0;
    const lo = this.config.minGridLock;
    const hi = this.config.fullGridLock;

    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const cand = accepted[fi];
      const res = results[fi];
      void predicted;
      f.totalPoints = this.featurePoints.length;
      totalPoints += f.totalPoints;
      f.lock = locks[fi];

      if (cand) {
        const next = this.config.smoothing >= 1
          ? cand
          : smoothQuad(f.corners, cand, this.config.smoothing);
        const H = homographyFromQuad(next);
        if (H) {
          f.corners = next;
          f.H = H;
        }
      }

      if (usable[fi]) {
        usableCount++;
        f.measured = true;
        f.missFrames = 0;
        f.inliers = res.inliers;
        f.error = Number.isFinite(res.error) ? res.error : this.config.ransacThreshold;
        const lockFactor = this.config.useGridSupport
          ? Math.max(0, Math.min(1, (f.lock - lo) / Math.max(1e-6, hi - lo)))
          : 1;
        f.confidence = faceConfidence(res.inliers, f.totalPoints, f.error, this.config) * lockFactor;
        errSum += f.error;
        errN++;
        totalInliers += res.inliers;
      } else {
        // 直接は観測できていない。剛体構造から復元できていれば形は保てるが、
        // 証拠が無いので信頼度は上げない。
        f.measured = false;
        f.missFrames++;
        f.inliers = Math.min(res.inliers, this.config.minInliersPerFace - 1);
        f.error = this.config.ransacThreshold * 2;
        f.confidence = accepted[fi] ? 0.3 : 0;
      }
      confSum += f.confidence;
    }

    this.lastUsableFaces = usableCount;
    this.lastLock = this.faces.length
      ? this.faces.reduce((a, f) => a + f.lock, 0) / this.faces.length
      : 1;
    this.confidence = this.faces.length ? confSum / this.faces.length : 0;
    this.lastError = errN ? errSum / errN : this.config.ransacThreshold * 2;

    const homographyMs = now() - tHomo;

    // --- 状態遷移 ---
    this.updateStatus(gray, t);

    if (this.collectPoints) {
      this.lastPoints = flow.map((r, i) => ({
        x: r.x, y: r.y, px: src[i * 2], py: src[i * 2 + 1],
        ok: r.ok, inlier: inlierFlags[i] === 1, face: this.faces[faceOf[i]].id,
      }));
    } else {
      this.lastPoints = [];
    }

    this.prevPyramid = pyr;
    if (this.status === 'TRACKING') {
      this.lastHex = hexFromFaces({
        U: this.faces[0].corners, F: this.faces[1].corners, R: this.faces[2].corners,
      });
    }

    const s = this.snapshot();
    s.trackedPoints = totalInliers;
    s.totalPoints = totalPoints;
    this.timing = { flowMs, homographyMs, totalMs: now() - t0 };
    return s;
  }

  /**
   * 観測できなかった面を、キューブの剛体構造から再構成する。
   *
   * 3面は六角形モデル (N, p, q, r) の8自由度で表せる。
   *   U = {N+p, N, N+r, N+p+r} → N, p, r が分かる
   *   F = {N+p, N, N+q, N+p+q} → N, p, q
   *   R = {N+r, N, N+q, N+q+r} → N, q, r
   * 使える面が2枚あれば4つとも決まる。1枚しか無くても3つは決まるので、
   * 残る1本は「決まった2本が前フレームからどう変わったか」から
   * 2x2 の線形変換を解いて前フレームの値に当てる。
   *
   * 見失った面をその場に凍結すると、遮蔽が明けたときにモデルが実物から
   * 離れすぎていて LK が戻れなくなる（実測で 17px ずれたまま復帰不能だった）。
   */
  private reconstructMissing(quads: (Quad | null)[], usable: boolean[]): void {
    const idx: Record<VisibleFaceId, number> = { U: 0, F: 1, R: 2 };
    const ok = (id: VisibleFaceId) => usable[idx[id]] && !!quads[idx[id]];
    const q = (id: VisibleFaceId) => quads[idx[id]]!;
    if (usable.every((u, i) => u && quads[i])) return;

    const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
    const Ns: Point2D[] = [];
    const ps: Point2D[] = [];
    const qs: Point2D[] = [];
    const rs: Point2D[] = [];
    if (ok('U')) { Ns.push(q('U')[1]); ps.push(sub(q('U')[0], q('U')[1])); rs.push(sub(q('U')[2], q('U')[1])); }
    if (ok('F')) { Ns.push(q('F')[1]); ps.push(sub(q('F')[0], q('F')[1])); qs.push(sub(q('F')[2], q('F')[1])); }
    if (ok('R')) { Ns.push(q('R')[1]); rs.push(sub(q('R')[0], q('R')[1])); qs.push(sub(q('R')[2], q('R')[1])); }
    if (!Ns.length) return;

    const mean = (list: Point2D[]): Point2D | null => list.length
      ? { x: list.reduce((a, v) => a + v.x, 0) / list.length, y: list.reduce((a, v) => a + v.y, 0) / list.length }
      : null;

    const prev = this.lastHex;
    let N = mean(Ns)!;
    let p = mean(ps);
    let qv = mean(qs);
    let r = mean(rs);

    // 足りないベクトルを、既知ベクトルの変化から求めた 2x2 線形変換で補う
    const missing = [!p, !qv, !r].filter(Boolean).length;
    if (missing > 0) {
      if (!prev) return;
      const knownNew: Point2D[] = [];
      const knownOld: Point2D[] = [];
      if (p) { knownNew.push(p); knownOld.push(prev.p); }
      if (qv) { knownNew.push(qv); knownOld.push(prev.q); }
      if (r) { knownNew.push(r); knownOld.push(prev.r); }
      if (knownNew.length < 2) return;
      // 既知の2ベクトルが平行に近いと 2x2 変換が悪条件になり、
      // 未知ベクトルが極端に拡大される。そのときは予測しない。
      const cross = Math.abs(knownOld[0].x * knownOld[1].y - knownOld[0].y * knownOld[1].x);
      const norms = Math.hypot(knownOld[0].x, knownOld[0].y) * Math.hypot(knownOld[1].x, knownOld[1].y);
      if (norms < 1e-6 || cross / norms < 0.15) return;
      const M = solve2x2Map(knownOld[0], knownOld[1], knownNew[0], knownNew[1]);
      if (!M) return;
      const apply = (v: Point2D): Point2D => ({ x: M[0] * v.x + M[1] * v.y, y: M[2] * v.x + M[3] * v.y });
      if (!p) p = apply(prev.p);
      if (!qv) qv = apply(prev.q);
      if (!r) r = apply(prev.r);
    }
    if (!p || !qv || !r) return;

    const model: HexModel = { N, p, q: qv, r };
    if (!isPlausibleHex(model)) return;
    const rebuilt = hexToFaces(model);
    for (let fi = 0; fi < this.faces.length; fi++) {
      if (usable[fi] && quads[fi]) continue;
      quads[fi] = rebuilt[this.faces[fi].id];
    }
  }

  /** 面をまたぐ共有頂点を信頼度で重み付けして一致させる。 */
  private enforceShared(
    quads: (Quad | null)[],
    results: { inliers: number; error: number }[],
    usable: boolean[],
  ): void {
    const indexOfFace: Record<string, number> = { U: 0, F: 1, R: 2 };
    for (const group of SHARED_VERTEX_GROUPS) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      const members: { q: Quad; corner: number }[] = [];
      for (const g of group) {
        const fi = indexOfFace[g.face];
        const q = quads[fi];
        if (!q) continue;
        members.push({ q, corner: g.corner });
        // 観測できていない面は平均に入れない。入れると、正しく追えている面の
        // 頂点まで引っ張られる（実測で U 面が最大 15px ずれた）。
        if (!usable[fi]) continue;
        const w = Math.max(0.05, results[fi].inliers);
        sx += q[g.corner].x * w;
        sy += q[g.corner].y * w;
        sw += w;
      }
      if (members.length < 2 || sw <= 0) continue;
      const cx = sx / sw;
      const cy = sy / sw;
      for (const m of members) {
        m.q[m.corner] = { x: cx, y: cy };
      }
    }
  }

  private updateStatus(gray: GrayImage, t: number): void {
    const c = this.config;
    // 直接観測できている面が2枚あれば、残り1枚は剛体構造から誤差なく復元できる。
    // 1枚以下だとモデルが決まらないので信頼できない。
    const good = this.lastUsableFaces >= 2 && this.confidence >= c.degradedConfidence;

    if (this.lastUsableFaces === 0) this.blindFrames++;
    else this.blindFrames = 0;

    // 全面を見失った状態が続いたら、盲目的に再ロックせず正直に LOST にする。
    // 実測では、全面遮蔽の後に再ロックすると1セルずれた位置に貼り付いたまま
    // 高い信頼度を出し続けてしまう。誤追跡を続けるより LOST が正しい。
    if (this.blindFrames > c.blindFramesBeforeLost) {
      this.fail('キューブを完全に見失いました。再取得してください');
      return;
    }

    if (this.status === 'INITIALIZING') {
      if (good) {
        this.initFrames++;
        if (this.initFrames >= c.initializingFrames) {
          this.status = 'TRACKING';
          this.lastGood = t;
        }
      } else {
        this.degradedFrames++;
        if (this.degradedFrames > c.lostAfterDegradedFrames) {
          this.fail('初期化直後に追跡が安定しませんでした');
        }
      }
      return;
    }

    if (good) {
      this.goodStreak++;
      this.degradedFrames = 0;
      if (this.status === 'DEGRADED') {
        if (this.goodStreak >= c.recoverFrames) {
          this.status = 'TRACKING';
          this.lastGood = t;
          this.reason = null;
        }
      } else {
        this.status = 'TRACKING';
        this.lastGood = t;
      }
      return;
    }

    this.goodStreak = 0;
    this.degradedFrames++;
    this.status = 'DEGRADED';
    this.reason = this.degradeReason();

    // 完全に見失う前に、予測位置の周りでエッジに貼り直してみる。
    // ただし「本当に面を観測できていない」ときだけ。信頼度が下がっただけで
    // モデルを動かすと、正しく追えているものを壊してしまう（実測で確認済み）。
    if (c.localRedetect && this.lastHex && this.lastUsableFaces === 0 && this.degradedFrames % 5 === 0) {
      this.tryLocalRedetect(gray);
    }

    if (this.degradedFrames > c.lostAfterDegradedFrames) {
      this.fail(`追跡不能: ${this.reason ?? '信頼度低下'}`);
    }
  }

  private degradeReason(): string {
    if (this.config.useGridSupport && this.lastLock < this.config.fullGridLock) {
      return `キューブのグリッドに乗っていません（ロック比 ${this.lastLock.toFixed(2)}）`;
    }
    const bad = this.faces.filter((f) => !f.measured).map((f) => f.id);
    if (bad.length) return `${bad.join('/')} 面を観測できません`;
    const worst = this.faces.reduce((a, b) => (a.confidence < b.confidence ? a : b));
    return `信頼度低下（最低 ${worst.id}: ${worst.confidence.toFixed(2)}）`;
  }

  /** 予測位置の周りだけで輪郭に貼り直す。全画面スキャンはしない。 */
  private tryLocalRedetect(gray: GrayImage): boolean {
    if (!this.lastHex) return false;
    const before = hexEdgeSupport(gray, this.lastHex);
    // 探索幅は面の大きさに比例させる。遮蔽中にキューブが動いていると
    // 固定幅では届かない（実測: 16フレームの全面遮蔽で約30px ずれる）。
    const scale = Math.max(
      12,
      Math.hypot(this.lastHex.p.x, this.lastHex.p.y),
      Math.hypot(this.lastHex.q.x, this.lastHex.q.y),
    );
    const r = refineHexModel(gray, this.lastHex, {
      initialStep: Math.max(6, scale * 0.35), minStep: 0.5, passesPerStep: 3, samplesPerEdge: 14,
    });
    if (!isPlausibleHex(r.model) || r.support <= before * 1.15) return false;
    const quads = hexToFaces(r.model);
    for (let fi = 0; fi < this.faces.length; fi++) {
      const f = this.faces[fi];
      const q = quads[f.id];
      if (!validateQuad(q, this.quadLimits).ok) return false;
      const H = homographyFromQuad(q);
      if (!H) return false;
      f.corners = q;
      f.H = H;
      f.missFrames = 0;
    }
    this.lastHex = r.model;
    this.reason = '局所再検出で位置を貼り直しました';
    return true;
  }

  // -------------------------------------------------------------------------
  // 出力
  // -------------------------------------------------------------------------

  snapshot(): CubeTrackingState {
    return {
      status: this.status,
      faces: this.faces.map((f): TrackedFace => ({
        id: f.id,
        corners: cloneQuad(f.corners),
        confidence: f.confidence,
        visible: f.missFrames === 0,
        inliers: f.inliers,
        totalPoints: f.totalPoints,
        reprojectionError: f.error,
        measured: f.measured,
        gridLock: f.lock,
      })),
      confidence: this.confidence,
      lastGoodTimestamp: this.lastGood,
      reprojectionError: this.lastError,
      trackedPoints: this.faces.reduce((a, f) => a + f.inliers, 0),
      totalPoints: this.faces.length * this.featurePoints.length,
      degradedFrames: this.degradedFrames,
      reason: this.reason,
      gridSupport: this.lastLock,
      points: this.lastPoints,
    };
  }

  get faceHomography(): Record<VisibleFaceId, Mat3 | null> {
    const out = { U: null, F: null, R: null } as Record<VisibleFaceId, Mat3 | null>;
    for (const f of this.faces) out[f.id] = f.H;
    return out;
  }

  /** 追跡中の面の四角形。追跡していなければ null。 */
  getFaceQuad(id: VisibleFaceId): Quad | null {
    const f = this.faces.find((x) => x.id === id);
    return f ? cloneQuad(f.corners) : null;
  }

  get currentStatus(): TrackingStatus {
    return this.status;
  }
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/**
 * 面の信頼度。
 * インライア率・再投影誤差の両方が良いときだけ高くなる。
 * 片方だけ良くても高くならないように積で効かせる。
 */
export function faceConfidence(
  inliers: number, total: number, error: number, cfg: TrackingConfig,
): number {
  if (total <= 0) return 0;
  if (inliers < cfg.minInliersPerFace) return 0;
  const ratio = Math.min(1, inliers / total);
  const errScore = Math.max(0, 1 - error / cfg.ransacThreshold);
  return Math.max(0, Math.min(1, ratio * 0.55 + errScore * 0.45));
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 追跡中の面から 3x3 セルのサンプリング点を作る。
 * 既存の manual ROI と同じ「セル中央 inset の領域を複数点平均」に揃える。
 * 出力は正規化画像座標（0..1）で、既存 Worker がそのまま使える形。
 */
export function trackedCellSamplePoints(
  H: Mat3,
  imageWidth: number,
  imageHeight: number,
  samplesPerAxis: number,
  inset: number,
  rotate = 0,
  mirror = false,
): Float32Array {
  const k = samplesPerAxis;
  const out = new Float32Array(9 * k * k * 2);
  const p: Point2D = { x: 0, y: 0 };
  const margin = (1 - inset) / 2;
  let w = 0;
  for (let i = 0; i < 9; i++) {
    let row = Math.floor(i / 3);
    let col = i % 3;
    if (mirror) col = 2 - col;
    for (let t = 0; t < ((rotate % 4) + 4) % 4; t++) {
      const nr = col;
      const nc = 2 - row;
      row = nr;
      col = nc;
    }
    for (let sy = 0; sy < k; sy++) {
      const v = (row + margin + (inset * (sy + 0.5)) / k) / 3;
      for (let sx = 0; sx < k; sx++) {
        const u = (col + margin + (inset * (sx + 0.5)) / k) / 3;
        applyH(H, u, v, p);
        out[w++] = p.x / imageWidth;
        out[w++] = p.y / imageHeight;
      }
    }
  }
  return out;
}

export { defaultTrackingConfig, quadArea, reprojectionError };
