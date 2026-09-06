/**
 * 「見えている面だけで手を識別できるか」の可観測性を測る。
 *
 * CLAUDE.md が ROI 2枚を要求する根拠であり、フェーズ0の Go/No-Go に直結する数値。
 * ここが崩れると追跡アルゴリズムを何度直しても上限に当たる。
 */
import { describe, it, expect } from 'vitest';
import {
  solvedState, applySequence, applyMove, getFacelets, generateScramble, makeRng,
  MOVES_18, ROTATIONS_6, type CubeState, type FaceIndex,
} from '../src/core/cube';

const viewKey = (s: CubeState, faces: FaceIndex[]) => faces.map((f) => getFacelets(s, f).join('')).join('|');

/** 可視面 faces のもとで、候補手のうち恒等と区別できないものの割合。 */
function measure(faces: FaceIndex[], trials = 400) {
  const all = [...MOVES_18, ...ROTATIONS_6];
  const rng = makeRng(1);
  let invisible = 0;
  let total = 0;
  let ambiguousGroups = 0;
  for (let t = 0; t < trials; t++) {
    const st = applySequence(solvedState(), generateScramble(20, rng));
    const idKey = viewKey(st, faces);
    const groups = new Map<string, string[]>([[idKey, ['.']]]);
    for (const m of all) {
      const k = viewKey(applyMove(st, m), faces);
      if (k === idKey) invisible++;
      total++;
      const g = groups.get(k);
      if (g) g.push(m);
      else groups.set(k, [m]);
    }
    for (const g of groups.values()) if (g.length > 1 && !g.includes('.')) ambiguousGroups++;
  }
  return { invisibleRate: invisible / total, ambiguousPerPosition: ambiguousGroups / trials };
}

describe('可視面と手の識別可能性', () => {
  it('1面だけでは1割以上の手が恒等と区別できない（ROIが2枚必要な理由）', () => {
    const r = measure([2]);
    expect(r.invisibleRate).toBeGreaterThan(0.05);
  });

  it('2面なら区別できない手は 0.5% 未満まで落ちる', () => {
    for (const faces of [[0, 2], [0, 1], [2, 1]] as FaceIndex[][]) {
      const r = measure(faces);
      expect(r.invisibleRate, faces.join('+')).toBeLessThan(0.005);
      expect(r.invisibleRate, faces.join('+')).toBeGreaterThan(0); // 盲点は 0 にはならない
    }
  });

  it('3面あれば盲点が消える', () => {
    const r = measure([0, 2, 1]);
    expect(r.invisibleRate).toBe(0);
    expect(r.ambiguousPerPosition).toBe(0);
  });
});
