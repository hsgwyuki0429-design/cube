import { describe, it, expect } from 'vitest';
import {
  solvedState, applyMove, applySequence, getFacelets, generateScramble, makeRng,
  parseSequence, stateSignature, type CubeState, type FaceIndex, type Rng,
} from '../src/core/cube';
import { Tracker, defaultThresholds, type RoiObservation } from '../src/core/tracker';

interface ObsOpts {
  conf?: number;
  /** ラベルを別の色に化けさせる確率 */
  errorRate?: number;
  /** 信頼度を 0 にする（手で隠れる）確率 */
  dropoutRate?: number;
  rng?: Rng;
}

/** 真の状態から観測を合成する。 */
function observe(state: CubeState, faces: FaceIndex[], o: ObsOpts = {}): RoiObservation[] {
  const rng = o.rng ?? (() => 0.99);
  return faces.map((face) => {
    const truth = getFacelets(state, face);
    const labels = new Int8Array(9);
    const conf = new Float32Array(9);
    for (let i = 0; i < 9; i++) {
      let l = truth[i];
      if (o.errorRate && rng() < o.errorRate) l = ((l + 1 + Math.floor(rng() * 5)) % 6) as FaceIndex;
      labels[i] = l;
      conf[i] = o.dropoutRate && rng() < o.dropoutRate ? 0 : (o.conf ?? 1);
    }
    return { face, labels, conf };
  });
}

const FACES_UF: FaceIndex[] = [0, 2]; // U と F
const FACES_UFR: FaceIndex[] = [0, 2, 1]; // U と F と R（固定カメラで見える最大3面）

/** 手順を「1手ごとに framesPerMove 枚」観測させて追跡させる。 */
function runSequence(
  tracker: Tracker,
  notation: string,
  faces: FaceIndex[] = FACES_UF,
  framesPerMove = 3,
  opts: ObsOpts = {},
): { truth: CubeState; statuses: string[] } {
  let truth = solvedState();
  const statuses: string[] = [];
  let t = 0;
  // 最初に静止フレームを入れる
  for (let i = 0; i < framesPerMove; i++) statuses.push(tracker.step(observe(truth, faces, opts), t++).status);
  for (const m of parseSequence(notation)) {
    truth = applyMove(truth, m);
    for (let i = 0; i < framesPerMove; i++) {
      statuses.push(tracker.step(observe(truth, faces, opts), t++).status);
    }
  }
  return { truth, statuses };
}

describe('追跡エンジン: 理想的な観測', () => {
  it('単発の手を1つずつ確定できる（18手すべて）', () => {
    for (const m of parseSequence("U U' U2 R R' R2 F F' F2 D D' D2 L L' L2 B B' B2")) {
      const tr = new Tracker();
      const { truth } = runSequence(tr, m.token);
      expect(tr.moves.map((x) => x.notation), m.token).toEqual([m.token]);
      expect(stateSignature(tr.state)).toBe(stateSignature(truth));
      expect(tr.status).toBe('TRACKING');
    }
  });

  it('全体回転も候補として拾える', () => {
    for (const r of ['x', "x'", 'y', "y'", 'z', "z'"]) {
      const tr = new Tracker();
      const { truth } = runSequence(tr, r);
      expect(tr.moves.map((x) => x.notation), r).toEqual([r]);
      expect(stateSignature(tr.state)).toBe(stateSignature(truth));
    }
  });

  it('T-perm を完走し、内部状態が真の状態と一致する', () => {
    const tr = new Tracker();
    const seq = "R U R' U' R' F R2 U' R' U' R U R' F'";
    const { truth, statuses } = runSequence(tr, seq);
    expect(tr.moves.map((x) => x.notation).join(' ')).toBe(seq);
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
    expect(statuses.includes('LOST')).toBe(false);
    expect(tr.lostCount).toBe(0);
  });

  it('ROI 3枚なら理想観測でランダムスクランブル20手を必ず完走する（40シード）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const scramble = generateScramble(20, makeRng(seed));
      const tr = new Tracker();
      const { truth } = runSequence(tr, scramble, FACES_UFR);
      expect(tr.moves.map((x) => x.notation).join(' '), scramble).toBe(scramble);
      expect(stateSignature(tr.state)).toBe(stateSignature(truth));
    }
  });

  it('ROI 2枚では稀に可視面の盲点を踏む（完走率を測る）', () => {
    // observability.test.ts の通り、2面だと約0.1%の手が恒等と区別できない。
    // 追跡側は「無理に推測しない」ので、そこで手を取りこぼす。完走率として測る。
    let complete = 0;
    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const scramble = generateScramble(20, makeRng(seed));
      const tr = new Tracker();
      const { truth } = runSequence(tr, scramble, FACES_UF);
      if (stateSignature(tr.state) === stateSignature(truth)) complete++;
    }
    expect(complete / N).toBeGreaterThanOrEqual(0.9);
    expect(complete).toBeLessThan(N); // 2枚では 100% にはならない
  });

  it('スクランブルとその逆順を追跡すると完成を検出する', () => {
    const tr = new Tracker();
    const scramble = generateScramble(15, makeRng(7));
    const inverse = parseSequence(scramble).reverse().map((m) => (m.amount === 1 ? m.letter : m.amount === 3 ? m.letter : m.letter + '2')).join(' ');
    runSequence(tr, scramble, FACES_UFR);
    expect(tr.solved).toBe(false);
    // 逆順（プライムを正しく作り直す）
    const inv = parseSequence(scramble).reverse().map((m) =>
      m.letter + (m.amount === 2 ? '2' : m.amount === 1 ? "'" : '')).join(' ');
    let truth = tr.state;
    let t = 1000;
    for (const m of parseSequence(inv)) {
      truth = applyMove(truth, m);
      for (let i = 0; i < 3; i++) tr.step(observe(truth, FACES_UFR), t++);
    }
    expect(inverse.length).toBeGreaterThan(0);
    expect(tr.solved).toBe(true);
  });
});

describe('追跡エンジン: 劣化した観測', () => {
  it('セルの30%が隠れていても追跡できる（部分照合）', () => {
    const tr = new Tracker();
    const rng = makeRng(5);
    const { truth } = runSequence(tr, "R U R' U' R U2 R'", FACES_UF, 4, { dropoutRate: 0.3, rng });
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
    expect(tr.moves.length).toBe(7);
  });

  it('信頼度が全体的に低くても、相対的な一致で追跡できる', () => {
    const tr = new Tracker();
    const { truth } = runSequence(tr, "R U R' U'", FACES_UF, 3, { conf: 0.3 });
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
  });

  it('誤分類が混じるとスコアが下がり、閾値次第で採用が止まる', () => {
    const tr = new Tracker();
    tr.thresholds.scoreThreshold = 0.95;
    const rng = makeRng(9);
    runSequence(tr, 'R U R\' U\'', FACES_UF, 3, { errorRate: 0.25, rng });
    // 誤りが多いフレームでは確定せず、無理に手順を作らない
    expect(tr.moves.length).toBeLessThan(4);
  });

  it('でたらめな観測が続くと LOST に落ちる', () => {
    const tr = new Tracker();
    tr.thresholds.lostFrames = 10;
    const rng = makeRng(3);
    for (let i = 0; i < 40; i++) {
      const labels = new Int8Array(9);
      for (let k = 0; k < 9; k++) labels[k] = Math.floor(rng() * 6);
      tr.step([{ face: 0, labels, conf: new Float32Array(9).fill(1) },
               { face: 2, labels, conf: new Float32Array(9).fill(1) }], i);
    }
    expect(tr.status).toBe('LOST');
    expect(tr.lostCount).toBe(1);
  });

  it('可視セルが少なすぎるフレームは判定しない', () => {
    const tr = new Tracker();
    const obs = observe(solvedState(), FACES_UF);
    for (const o of obs) (o.conf as Float32Array).fill(0);
    const r = tr.step(obs, 0);
    expect(r.visibleCells).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.status).toBe('TRANSITION');
  });
});

describe('追跡エンジン: 曖昧性', () => {
  it('U 面しか見ていないと D 手は恒等と区別できない', () => {
    const tr = new Tracker();
    const truth = applyMove(solvedState(), 'D');
    let last = tr.step(observe(truth, [0]), 0);
    for (let i = 0; i < 5; i++) last = tr.step(observe(truth, [0]), i + 1);
    // 既定（恒等優先）: 追跡は続くが手は記録されない = 静止と区別できないことを認める
    expect(tr.moves.length).toBe(0);
    expect(tr.status).toBe('TRACKING');
    expect(last.candidates[0].aliases.length).toBeGreaterThan(0); // 同点候補が可視化されている
  });

  it('恒等優先を切ると、曖昧なフレームは TRANSITION になる', () => {
    const tr = new Tracker();
    tr.thresholds.preferIdentityOnTie = false;
    const truth = applyMove(solvedState(), 'D');
    let last = tr.step(observe(truth, [0]), 0);
    for (let i = 0; i < 5; i++) last = tr.step(observe(truth, [0]), i + 1);
    expect(last.ambiguous).toBe(true);
    expect(tr.status).toBe('TRANSITION');
    expect(tr.moves.length).toBe(0);
  });

  it('ROI が2枚あれば D 手を検出できる（2枚必要な理由）', () => {
    const tr = new Tracker();
    const { truth } = runSequence(tr, 'D', FACES_UF);
    expect(tr.moves.map((m) => m.notation)).toEqual(['D']);
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
  });
});

describe('追跡エンジン: ヒステリシスと閾値', () => {
  it('連続1フレームだけでは確定しない', () => {
    const tr = new Tracker();
    tr.thresholds.hysteresisFrames = 3;
    const truth = applyMove(solvedState(), 'R');
    tr.step(observe(truth, FACES_UF), 0);
    expect(tr.moves.length).toBe(0);
    tr.step(observe(truth, FACES_UF), 1);
    expect(tr.moves.length).toBe(0);
    tr.step(observe(truth, FACES_UF), 2);
    expect(tr.moves.length).toBe(1);
  });

  it('マージン閾値を上げると採用されにくくなる', () => {
    const tr = new Tracker();
    tr.thresholds.marginThreshold = 0.99;
    runSequence(tr, "R U R'");
    expect(tr.moves.length).toBe(0);
    expect(tr.status).not.toBe('TRACKING');
  });

  it('確定した手には時刻とスコアが入る', () => {
    const tr = new Tracker();
    runSequence(tr, 'R U');
    expect(tr.moves.length).toBe(2);
    for (const m of tr.moves) {
      expect(m.t).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeGreaterThan(0.85);
    }
    expect(tr.moves[1].t).toBeGreaterThan(tr.moves[0].t);
  });
});

describe('追跡エンジン: 2手同時展開（オプション）', () => {
  it('既定 OFF では1フレーム間に2手進むと追従できない', () => {
    const tr = new Tracker();
    expect(tr.thresholds.twoMoveEnabled).toBe(false);
    const truth = applySequence(solvedState(), 'R U');
    for (let i = 0; i < 6; i++) tr.step(observe(truth, FACES_UF), i);
    expect(tr.moves.length).toBe(0);
    expect(tr.status).not.toBe('TRACKING');
  });

  it('ON にすると2手をまとめて確定できる', () => {
    const tr = new Tracker(solvedState(), { ...defaultThresholds(), twoMoveEnabled: true });
    const truth = applySequence(solvedState(), 'R U');
    for (let i = 0; i < 4; i++) tr.step(observe(truth, FACES_UF), i);
    expect(tr.moves.map((m) => m.notation)).toEqual(['R', 'U']);
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
  });

  it('ON でも1手ずつの観測は1手ずつ確定する', () => {
    const tr = new Tracker(solvedState(), { ...defaultThresholds(), twoMoveEnabled: true });
    const { truth } = runSequence(tr, "R U R' U'");
    expect(tr.moves.map((m) => m.notation)).toEqual(['R', 'U', "R'", "U'"]);
    expect(stateSignature(tr.state)).toBe(stateSignature(truth));
  });
});

describe('追跡エンジン: リセット', () => {
  it('reset で状態と統計が初期化される', () => {
    const tr = new Tracker();
    runSequence(tr, 'R U');
    const target = applySequence(solvedState(), 'F B');
    tr.reset(target);
    expect(tr.moves.length).toBe(0);
    expect(tr.frameCount).toBe(0);
    expect(tr.lostCount).toBe(0);
    expect(stateSignature(tr.state)).toBe(stateSignature(target));
    expect(tr.status).toBe('TRACKING');
  });
});
