/**
 * キューブ姿勢追跡のテスト。
 *
 * 合成映像に既知の3D姿勢を与え、推定した面四角形・セル中心との px 誤差で評価する。
 * 「見た感じ動いた」で終わらせないための本体。
 */
import { describe, it, expect } from 'vitest';
import { CubeTracker, featureUv, trackedCellSamplePoints, faceConfidence } from '../src/tracking/cubeTracker';
import { defaultTrackingConfig } from '../src/tracking/types';
import { renderFrame, defaultCamera, defaultPose, groundTruth } from '../src/dev/cubeRender';
import { rgbaToGray } from '../src/tracking/opticalFlow';
import { runScenario, standardScenarios, FALSE_TRACKING_PX } from '../src/dev/trackingEval';
import { homographyFromQuad, applyH, type Quad } from '../src/tracking/geometry';
import { hexToFaces, hexFromFaces, seedHexFromTap, gridLockScore } from '../src/tracking/hexModel';

const cam = defaultCamera();
const gtQuads = (pose = defaultPose()): Quad[] => {
  const gt = groundTruth(pose, cam);
  return (['U', 'F', 'R'] as const).map((id) => gt.find((f) => f.id === id)!.quad);
};
const grayAt = (pose = defaultPose(), opts = {}) => {
  const f = renderFrame(pose, cam, opts);
  return rgbaToGray(f.rgba, f.width, f.height);
};

describe('初期化', () => {
  it('四角形を直接与えると、そのままの位置で TRACKING に入る', () => {
    const tr = new CubeTracker();
    expect(tr.currentStatus).toBe('UNINITIALIZED');
    expect(tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() })).toBe(true);
    expect(tr.currentStatus).toBe('INITIALIZING');
    const q = tr.getFaceQuad('U')!;
    const gt = gtQuads()[0];
    for (let i = 0; i < 4; i++) {
      // アフィン六角形モデルを経由すると透視ぶんの系統誤差が入る。経由しないこと
      expect(q[i].x).toBeCloseTo(gt[i].x, 6);
      expect(q[i].y).toBeCloseTo(gt[i].y, 6);
    }
  });

  it('数フレームで INITIALIZING -> TRACKING に上がる', () => {
    const tr = new CubeTracker();
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    const seen: string[] = [];
    for (let i = 1; i <= 5; i++) seen.push(tr.step(grayAt(), i * 16).status);
    expect(seen[seen.length - 1]).toBe('TRACKING');
    expect(seen[0]).toBe('INITIALIZING');
  });

  it('4隅指定（手前の角 + 3方向）から初期化できる', () => {
    const q = gtQuads();
    const hex = hexFromFaces({ U: q[0], F: q[1], R: q[2] });
    const tr = new CubeTracker();
    const ok = tr.initialize(grayAt(), {
      kind: 'corners',
      corners: [
        hex.N,
        { x: hex.N.x + hex.p.x, y: hex.N.y + hex.p.y },
        { x: hex.N.x + hex.q.x, y: hex.N.y + hex.q.y },
        { x: hex.N.x + hex.r.x, y: hex.N.y + hex.r.y },
      ],
    });
    expect(ok).toBe(true);
    // 六角形モデルはアフィン近似で、透視による「対辺が平行でない」ぶんを表現できない。
    // 輪郭へのエッジ吸着で誤差はかなり落ちるが（実測 38px -> 7px）、
    // 四角形を直接与える経路ほど正確ではない。精度が要るときは quads を使う。
    const err = (id: 'U' | 'F' | 'R', i: number) => {
      const e = tr.getFaceQuad(id)!;
      const g = q[i];
      return e.reduce((a, p, k) => a + Math.hypot(p.x - g[k].x, p.y - g[k].y), 0) / 4;
    };
    for (const [id, i] of [['U', 0], ['F', 1], ['R', 2]] as ['U' | 'F' | 'R', number][]) {
      expect(err(id, i), id).toBeLessThan(15);
    }
    for (let i = 1; i <= 10; i++) tr.step(grayAt(), i * 16);
    expect(tr.currentStatus, 'LOST にはならない').not.toBe('LOST');
  });

  it('タップからの初期化はエッジに吸着して大まかに合う', () => {
    const tr = new CubeTracker();
    const ok = tr.initialize(grayAt(), {
      kind: 'tap', point: { x: cam.cx, y: cam.cy }, radius: Math.min(cam.width, cam.height) * 0.18,
    });
    expect(ok).toBe(true);
    const q = tr.getFaceQuad('U')!;
    const gt = gtQuads()[0];
    // 自動検出は完全ではない。段階的フォールバックが要る根拠として数値を残す
    const err = q.reduce((a, p, i) => a + Math.hypot(p.x - gt[i].x, p.y - gt[i].y), 0) / 4;
    expect(err).toBeLessThan(80);
  });

  it('退化した入力は初期化に失敗して LOST になる', () => {
    const tr = new CubeTracker();
    const flat: Quad = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    expect(tr.initialize(grayAt(), { kind: 'quads', quads: [flat, flat, flat] })).toBe(false);
    expect(tr.currentStatus).toBe('LOST');
    expect(tr.snapshot().reason).toBeTruthy();
  });

  it('reset で UNINITIALIZED に戻る', () => {
    const tr = new CubeTracker();
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    tr.reset();
    expect(tr.currentStatus).toBe('UNINITIALIZED');
    expect(tr.snapshot().faces.length).toBe(0);
  });
});

describe('状態遷移', () => {
  it('UNINITIALIZED -> INITIALIZING -> TRACKING -> DEGRADED -> TRACKING', () => {
    const tr = new CubeTracker();
    expect(tr.currentStatus).toBe('UNINITIALIZED');
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    expect(tr.currentStatus).toBe('INITIALIZING');
    for (let i = 1; i <= 4; i++) tr.step(grayAt(), i * 16);
    expect(tr.currentStatus).toBe('TRACKING');

    // 全面を隠す -> DEGRADED
    const occ = { occlusion: { x: 0, y: 0, w: cam.width, h: cam.height } };
    const s1 = tr.step(grayAt(defaultPose(), occ), 200);
    expect(s1.status).toBe('DEGRADED');

    // 遮蔽を外す -> TRACKING に戻る
    let last = s1.status;
    for (let i = 0; i < 8; i++) last = tr.step(grayAt(), 300 + i * 16).status;
    expect(last).toBe('TRACKING');
  });

  it('TRACKING -> DEGRADED -> LOST（見失い続けた場合）', () => {
    const tr = new CubeTracker(
      { ...defaultTrackingConfig(), blindFramesBeforeLost: 5 },
    );
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    for (let i = 1; i <= 4; i++) tr.step(grayAt(), i * 16);
    expect(tr.currentStatus).toBe('TRACKING');
    const occ = { occlusion: { x: 0, y: 0, w: cam.width, h: cam.height } };
    let status = '';
    for (let i = 0; i < 12; i++) status = tr.step(grayAt(defaultPose(), occ), 200 + i * 16).status;
    expect(status).toBe('LOST');
    expect(tr.snapshot().reason).toContain('見失い');
  });

  it('LOST の後は step しても状態が変わらない（再初期化が要る）', () => {
    const tr = new CubeTracker({ ...defaultTrackingConfig(), blindFramesBeforeLost: 3 });
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    const occ = { occlusion: { x: 0, y: 0, w: cam.width, h: cam.height } };
    for (let i = 0; i < 10; i++) tr.step(grayAt(defaultPose(), occ), i * 16);
    expect(tr.currentStatus).toBe('LOST');
    for (let i = 0; i < 5; i++) tr.step(grayAt(), 500 + i * 16);
    expect(tr.currentStatus).toBe('LOST');
    // 再初期化すれば戻る
    expect(tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() })).toBe(true);
    expect(tr.currentStatus).toBe('INITIALIZING');
  });
});

describe('信頼度', () => {
  it('インライアが多く誤差が小さいほど高い（単調）', () => {
    const cfg = defaultTrackingConfig();
    expect(faceConfidence(16, 16, 0, cfg)).toBeGreaterThan(faceConfidence(10, 16, 0, cfg));
    expect(faceConfidence(16, 16, 0, cfg)).toBeGreaterThan(faceConfidence(16, 16, 2, cfg));
    expect(faceConfidence(16, 16, 0, cfg)).toBeCloseTo(1, 6);
    // 最小インライアを割ったら 0
    expect(faceConfidence(cfg.minInliersPerFace - 1, 16, 0, cfg)).toBe(0);
    expect(faceConfidence(0, 0, 0, cfg)).toBe(0);
  });

  it('良い追跡では高く、遮蔽では下がる', () => {
    const tr = new CubeTracker();
    tr.initialize(grayAt(), { kind: 'quads', quads: gtQuads() });
    for (let i = 1; i <= 4; i++) tr.step(grayAt(), i * 16);
    const good = tr.snapshot().confidence;
    expect(good).toBeGreaterThan(0.8);
    const occ = { occlusion: { x: 0, y: 0, w: cam.width, h: cam.height } };
    const bad = tr.step(grayAt(defaultPose(), occ), 200).confidence;
    expect(bad).toBeLessThan(good);
    expect(bad).toBeLessThan(defaultTrackingConfig().degradedConfidence);
  });

  it('グリッドロック比が正しい位置で高く、半セルずらすと下がる', () => {
    const gray = grayAt();
    const H = homographyFromQuad(gtQuads()[1])!;
    const good = gridLockScore(gray, H);
    const shifted: Quad = [
      applyH(H, 1 / 6, 0), applyH(H, 1 + 1 / 6, 0), applyH(H, 1 + 1 / 6, 1), applyH(H, 1 / 6, 1),
    ];
    const bad = gridLockScore(gray, homographyFromQuad(shifted)!);
    expect(good).toBeGreaterThan(defaultTrackingConfig().minGridLock);
    expect(bad).toBeLessThan(good);
  });
});

describe('剛体構造', () => {
  it('六角形モデルの往復で3面が矛盾なく再構成される', () => {
    const q = gtQuads();
    const hex = hexFromFaces({ U: q[0], F: q[1], R: q[2] });
    const back = hexToFaces(hex);
    // 共有頂点が一致していること
    expect(back.U[1]).toEqual(back.F[1]);
    expect(back.F[1]).toEqual(back.R[1]);
    expect(back.U[0]).toEqual(back.F[0]);
    expect(back.U[2]).toEqual(back.R[0]);
    expect(back.F[2]).toEqual(back.R[2]);
  });

  it('追跡中も面の共有辺がズレない', () => {
    const tr = new CubeTracker();
    const base = defaultPose();
    tr.initialize(grayAt(base), { kind: 'quads', quads: gtQuads(base) });
    for (let i = 1; i <= 20; i++) {
      const pose = { ...base, tx: base.tx + 0.02 * i, ry: base.ry + 0.004 * i };
      tr.step(grayAt(pose), i * 16);
    }
    const s = tr.snapshot();
    const f = (id: string) => s.faces.find((x) => x.id === id)!;
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(f('U').corners[1], f('F').corners[1])).toBeLessThan(0.01);
    expect(d(f('U').corners[2], f('R').corners[0])).toBeLessThan(0.01);
    expect(d(f('F').corners[2], f('R').corners[2])).toBeLessThan(0.01);
  });

  it('タップの種モデルは3辺が張った妥当な六角形になる', () => {
    const hex = seedHexFromTap({ x: 200, y: 150 }, 60);
    const faces = hexToFaces(hex);
    for (const id of ['U', 'F', 'R'] as const) {
      expect(faces[id].length).toBe(4);
      for (const p of faces[id]) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('セルサンプリング点', () => {
  it('9セル分の点が面の内側に入り、中央 inset 領域に収まる', () => {
    const H = homographyFromQuad([
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 },
    ])!;
    const k = 4;
    const inset = 0.5;
    const pts = trackedCellSamplePoints(H, 600, 600, k, inset);
    expect(pts.length).toBe(9 * k * k * 2);
    for (let cell = 0; cell < 9; cell++) {
      const row = Math.floor(cell / 3);
      const col = cell % 3;
      const margin = (1 - inset) / 2;
      for (let s = 0; s < k * k; s++) {
        const base = (cell * k * k + s) * 2;
        // 正規化画像座標 -> 面座標（面は 0..300、画像は 600）
        const u = (pts[base] * 600) / 300;
        const v = (pts[base + 1] * 600) / 300;
        expect(u).toBeGreaterThanOrEqual((col + margin) / 3 - 1e-9);
        expect(u).toBeLessThanOrEqual((col + 1 - margin) / 3 + 1e-9);
        expect(v).toBeGreaterThanOrEqual((row + margin) / 3 - 1e-9);
        expect(v).toBeLessThanOrEqual((row + 1 - margin) / 3 + 1e-9);
      }
    }
  });

  it('rotate / mirror が既存 ROI と同じ意味で効く', () => {
    const H = homographyFromQuad([
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 },
    ])!;
    const a = trackedCellSamplePoints(H, 300, 300, 1, 0.5, 0, false);
    const b = trackedCellSamplePoints(H, 300, 300, 1, 0.5, 1, false);
    const m = trackedCellSamplePoints(H, 300, 300, 1, 0.5, 0, true);
    // facelet(0,0) は rotate=1 で ROI グリッドの (0,2) に行く
    expect(b[0]).toBeCloseTo(a[2 * 2], 6);
    // mirror は列を反転する
    expect(m[0]).toBeCloseTo(a[2 * 2], 6);
  });

  it('特徴点は面の縁ぴったりには置かない（ドリフトの原因）', () => {
    const uv = featureUv(0.07);
    expect(uv.length).toBe(16);
    for (const [u, v] of uv) {
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    // 内側の交点（1/3, 2/3）は含む
    expect(uv.some(([u, v]) => Math.abs(u - 1 / 3) < 1e-9 && Math.abs(v - 2 / 3) < 1e-9)).toBe(true);
  });
});

describe('合成シナリオでの数値評価', () => {
  const scenarios = standardScenarios();
  const run = (name: string) => runScenario(scenarios.find((s) => s.name === name)!, { seed: 7 });

  it('静止では誤差 0', () => {
    const m = run('static');
    expect(m.cellErrorMean).toBeLessThan(0.01);
    expect(m.lostFrames).toBe(0);
  });

  for (const [name, cellLimit] of [
    ['translate', 4], ['scale', 4], ['rotate-small', 4], ['combined', 4], ['noisy-blur', 4],
    ['perspective', 6], ['fast-motion', 6],
  ] as [string, number][]) {
    it(`${name}: 平均セル誤差 < ${cellLimit}px / 生存率 > 95% / 誤追跡 0%`, () => {
      const m = run(name);
      expect(m.cellErrorMean, 'cell').toBeLessThan(cellLimit);
      expect(m.survivalRate, 'survival').toBeGreaterThan(0.95);
      expect(m.falseVisibleRate, 'false tracking').toBe(0);
      expect(m.lostFrames, 'lost').toBe(0);
    });
  }

  it('一部が手で隠れても追跡を維持し、隠れた面は可視から外す', () => {
    const m = run('partial-occlusion');
    expect(m.survivalRate).toBeGreaterThan(0.95);
    expect(m.recovered).toBe(true);
    expect(m.falseVisibleRate).toBe(0);
    expect(m.cellErrorMean).toBeLessThan(4);
    // 隠れている間は可視面が減ること（黙って全部見えているとは言わない）
    expect(m.visibleFaceRate).toBeLessThan(1);
  });

  it('全面が長時間隠れたら LOST に落ちる', () => {
    const m = run('full-occlusion');
    expect(m.lostFrames).toBeGreaterThan(10);
    expect(m.falseVisibleRate).toBe(0);
  });

  it('キューブが画面から消えたら LOST に落ちる（背景に貼り付かない）', () => {
    const m = run('cube-removed');
    expect(m.lostFrames).toBeGreaterThan(10);
    expect(m.falseVisibleRate).toBe(0);
  });

  it('全面遮蔽の後は盲目的に再ロックせず LOST にする', () => {
    const m = run('brief-full-occlusion');
    // 遮蔽中にキューブが動いていると1セルずれた位置に貼り付きうる。
    // 誤追跡を続けるより LOST が正しい（再取得を要求する）
    expect(m.falseVisibleRate).toBe(0);
    expect(m.lostFrames).toBeGreaterThan(0);
  });

  it('誤追跡の判定閾値が想定どおり', () => {
    expect(FALSE_TRACKING_PX).toBe(8);
  });
});
