/**
 * 録画 → JSON → リプレイの往復と、リプレイの決定性を確認する。
 * ここが壊れると回帰テストの数字が信用できなくなる。
 */
import { describe, it, expect } from 'vitest';
import { Recorder, parseSession, SESSION_VERSION, type RecordedSession } from '../src/dev/recorder';
import { replaySession, sweep } from '../src/dev/replay';
import { synthesizeSession, standardPalette } from '../src/dev/synth';
import { defaultThresholds } from '../src/core/tracker';
import { makeRng, applySequence, solvedState, stateSignature, type FaceIndex } from '../src/core/cube';
import type { FrameSample } from '../src/vision/types';

const UF: FaceIndex[] = [0, 2];

function session(overrides: Partial<Parameters<typeof synthesizeSession>[0]> = {}): RecordedSession {
  return synthesizeSession({
    name: 'test', moves: "R U R' U' F", faces: UF, fps: 60, tps: 4,
    blurFraction: 0.4, labNoise: 2, occlusion: 0.05, rng: makeRng(42), ...overrides,
  });
}

describe('Recorder', () => {
  it('フレームを記録し、JSON を往復できる', () => {
    const rec = new Recorder();
    rec.start({ name: 's', faces: UF, initialScramble: null });
    const frame: FrameSample = {
      seq: 0, t: 16.7, procMs: 3.25,
      rois: [
        { lab: Float32Array.from({ length: 27 }, (_, i) => i * 1.111), rgb: new Float32Array(27) },
        { lab: Float32Array.from({ length: 27 }, (_, i) => -i), rgb: new Float32Array(27) },
      ],
    };
    rec.add(frame, [new Int8Array(9).fill(2), new Int8Array(9).fill(0)],
                   [new Float32Array(9).fill(0.9), new Float32Array(9).fill(0.5)], 59.9);
    const s = rec.stop()!;
    expect(rec.frameCount).toBe(1);
    const back = parseSession(JSON.stringify(s));
    expect(back.version).toBe(SESSION_VERSION);
    expect(back.frames.length).toBe(1);
    expect(back.frames[0].rois.length).toBe(2);
    expect(back.frames[0].rois[0].cells.length).toBe(9);
    expect(back.frames[0].rois[0].cells[1]).toEqual([3.33, 4.44, 5.55]);
    expect(back.frames[0].rois[0].labels).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(back.frames[0].fps).toBe(59.9);
  });

  it('stop 後は記録しない', () => {
    const rec = new Recorder();
    rec.start({ name: 's', faces: UF, initialScramble: null });
    rec.stop();
    rec.add({ seq: 1, t: 0, procMs: 0, rois: [{ lab: new Float32Array(27), rgb: new Float32Array(27) }] }, [], [], 60);
    expect(rec.frameCount).toBe(0);
  });

  it('v2: 追跡情報と trusted フラグを記録する', () => {
    const rec = new Recorder();
    rec.start({ name: 's', faces: UF, initialScramble: null, roiMode: 'tracked' });
    rec.add(
      {
        seq: 0, t: 0, procMs: 2,
        rois: [
          { lab: new Float32Array(27), rgb: new Float32Array(27), trusted: true },
          { lab: new Float32Array(27), rgb: new Float32Array(27), trusted: false },
        ],
        timing: { samplingMs: 0.4, trackingMs: 5.1, flowMs: 3, homographyMs: 1.5 },
        tracking: {
          status: 'DEGRADED', faces: [
            { id: 'U', corners: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }],
              confidence: 0.9, visible: true, gridLock: 2.1, inliers: 15, totalPoints: 16,
              reprojectionError: 0.4, measured: true },
          ],
          confidence: 0.5, lastGoodTimestamp: 0, reprojectionError: 0.4,
          trackedPoints: 15, totalPoints: 48, degradedFrames: 2, reason: 'F 面を観測できません',
          gridSupport: 1.4, points: [],
        },
      },
      [new Int8Array(9), new Int8Array(9)],
      [new Float32Array(9), new Float32Array(9)],
      60,
    );
    const back = parseSession(JSON.stringify(rec.stop()!));
    expect(back.version).toBe(2);
    expect(back.roiMode).toBe('tracked');
    const f = back.frames[0];
    expect(f.rois[0].trusted).toBe(true);
    expect(f.rois[1].trusted).toBe(false);
    expect(f.tracking?.status).toBe('DEGRADED');
    expect(f.tracking?.gridLock).toBe(1.4);
    expect(f.tracking?.faces[0].corners).toEqual([[1, 2], [3, 4], [5, 6], [7, 8]]);
    expect(f.trackMs).toBe(5.1);
  });

  it('v1 の録画もそのまま読める（既存 fixture 互換）', () => {
    const v1 = {
      version: 1, name: 'old', createdAt: 0, faces: UF, initialScramble: null,
      frames: [{ t: 0, rois: [{ cells: Array.from({ length: 9 }, () => [50, 0, 0]), labels: new Array(9).fill(0), conf: new Array(9).fill(1) }], fps: 60, procMs: 1 }],
    };
    const back = parseSession(JSON.stringify(v1));
    expect(back.version).toBe(1);
    expect(back.frames[0].tracking).toBeUndefined();
    expect(back.frames[0].rois[0].trusted).toBeUndefined();
  });

  it('壊れた JSON は例外', () => {
    expect(() => parseSession('{}')).toThrow();
    expect(() => parseSession(JSON.stringify({ version: 99, frames: [], faces: [] }))).toThrow();
    expect(() => parseSession('not json')).toThrow();
  });
});

describe('リプレイ', () => {
  it('カメラなしで追跡を再実行し、正解手順と比較できる', () => {
    const s = session();
    const r = replaySession(s, { thresholds: defaultThresholds() });
    expect(r.frames).toBe(s.frames.length);
    expect(r.comparison).not.toBeNull();
    expect(r.comparison!.expected).toEqual(["R", "U", "R'", "U'", "F"]);
    expect(r.comparison!.complete).toBe(true);
    expect(r.comparison!.finalStateMatches).toBe(true);
    expect(r.comparison!.falsePositives).toBe(0);
  });

  it('同じ入力・同じ閾値なら結果は完全に決定的', () => {
    const s = session();
    const a = replaySession(s);
    const b = replaySession(s);
    expect(a.moves.map((m) => m.notation)).toEqual(b.moves.map((m) => m.notation));
    expect(stateSignature(a.finalState)).toBe(stateSignature(b.finalState));
    expect(a.lostCount).toBe(b.lostCount);
  });

  it('閾値を変えると結果が変わる（比較の意味がある）', () => {
    const s = session({ labNoise: 5, occlusion: 0.2, tps: 8 });
    const strict = replaySession(s, { thresholds: { scoreThreshold: 0.99, marginThreshold: 0.4 } });
    const loose = replaySession(s, { thresholds: { hysteresisMode: 'window', hysteresisFrames: 3, hysteresisWindow: 6 } });
    expect(strict.moves.length).toBeLessThan(loose.moves.length);
  });

  it('記録開始時の内部状態がスクランブル済みでも追える', () => {
    const scramble = "R2 U' F B2 D";
    const s = session({ initialScramble: scramble, moves: "U R U'" });
    // 既定閾値では余計な R' R の組（自己訂正）が入るが、最終状態は一致する
    const spec = replaySession(s);
    expect(spec.comparison!.finalStateMatches).toBe(true);
    expect(stateSignature(spec.finalState))
      .toBe(stateSignature(applySequence(solvedState(), `${scramble} U R U'`)));
    // 窓ヒステリシスなら手順そのものも一致する
    const win = replaySession(s, {
      thresholds: { hysteresisMode: 'window', hysteresisFrames: 3, hysteresisWindow: 6 },
    });
    expect(win.comparison!.complete).toBe(true);
    expect(win.comparison!.got).toEqual(['U', 'R', "U'"]);
  });

  it('Lab から再分類しても、記録済みラベルを使っても同じ結果になる（合成データは無矛盾）', () => {
    const s = session();
    const a = replaySession(s, { reclassify: true });
    const b = replaySession(s, { reclassify: false });
    expect(a.moves.map((m) => m.notation)).toEqual(b.moves.map((m) => m.notation));
  });

  it('別の代表ベクトルで再分類すると結果が崩れる（色分類側も評価できる）', () => {
    const s = session();
    const base = standardPalette();
    const wrong = Float32Array.from(base);
    // 6色を全て同じ方向に潰して判別不能にする（キャリブレーションが崩れた状況）
    for (let f = 0; f < 6; f++) wrong.set([base[f * 3], 0, 0], f * 3);
    const r = replaySession(s, { reclassify: true, refLab: wrong });
    expect(r.comparison!.complete).toBe(false);
    expect(r.status).not.toBe('TRACKING');
  });

  it('sweep で複数設定を一度に比較できる', () => {
    const s = session({ labNoise: 4, occlusion: 0.15, tps: 8 });
    const out = sweep(s, [
      { name: 'spec', thresholds: {} },
      { name: 'window', thresholds: { hysteresisMode: 'window', hysteresisFrames: 3, hysteresisWindow: 6 } },
    ]);
    expect(out.map((o) => o.name)).toEqual(['spec', 'window']);
    for (const o of out) expect(o.result.comparison).not.toBeNull();
  });
});

describe('合成データ生成', () => {
  it('synthetic フラグが立ち、正解手順と代表ベクトルが入る', () => {
    const s = session();
    expect(s.synthetic).toBe(true);
    expect(s.expectedMoves?.length).toBe(5);
    expect(s.refLab?.length).toBe(18);
    expect(s.faces).toEqual(UF);
  });

  it('TPS を上げるとフレーム数が減る', () => {
    const slow = session({ tps: 2 });
    const fast = session({ tps: 8 });
    expect(fast.frames.length).toBeLessThan(slow.frames.length);
  });

  it('遮蔽率を上げると低信頼セルが増える', () => {
    const clean = session({ occlusion: 0 });
    const dirty = session({ occlusion: 0.4 });
    const lowConf = (s: RecordedSession) =>
      s.frames.flatMap((f) => f.rois.flatMap((r) => r.conf)).filter((c) => c < 0.2).length;
    expect(lowConf(dirty)).toBeGreaterThan(lowConf(clean));
  });
});
