/**
 * 回帰テスト用の合成録画セットの定義と生成。
 *
 * 実機録画が手に入ったら fixtures/ に置くこと。**合成データは
 * アルゴリズムの回帰検出用であって、Go/No-Go の根拠にはならない。**
 */

import { generateScramble, makeRng, type FaceIndex } from '../core/cube';
import { synthesizeSession } from './synth';
import type { RecordedSession } from './recorder';

const UF: FaceIndex[] = [0, 2];
const UFR: FaceIndex[] = [0, 2, 1];

export interface FixtureSpec {
  file: string;
  tps: number;
  faces: FaceIndex[];
  labNoise: number;
  occlusion: number;
  blurFraction: number;
  seed: number;
  moveCount: number;
}

export const FIXTURE_SPECS: FixtureSpec[] = [
  { file: 'tps3_2roi_clean.json', tps: 3, faces: UF, labNoise: 1.5, occlusion: 0.0, blurFraction: 0.35, seed: 101, moveCount: 14 },
  { file: 'tps5_2roi_noisy.json', tps: 5, faces: UF, labNoise: 3.0, occlusion: 0.08, blurFraction: 0.45, seed: 102, moveCount: 14 },
  { file: 'tps8_2roi_hard.json', tps: 8, faces: UF, labNoise: 4.0, occlusion: 0.15, blurFraction: 0.5, seed: 103, moveCount: 14 },
  { file: 'tps5_3roi_noisy.json', tps: 5, faces: UFR, labNoise: 3.0, occlusion: 0.08, blurFraction: 0.45, seed: 104, moveCount: 14 },
  { file: 'tps8_3roi_hard.json', tps: 8, faces: UFR, labNoise: 4.0, occlusion: 0.15, blurFraction: 0.5, seed: 105, moveCount: 14 },
];

export function buildFixture(spec: FixtureSpec): RecordedSession {
  const moves = generateScramble(spec.moveCount, makeRng(spec.seed + 900));
  const session = synthesizeSession({
    name: spec.file.replace('.json', ''),
    moves,
    faces: spec.faces,
    fps: 60,
    tps: spec.tps,
    blurFraction: spec.blurFraction,
    labNoise: spec.labNoise,
    occlusion: spec.occlusion,
    rng: makeRng(spec.seed),
  });
  session.createdAt = 0; // 再生成しても差分が出ないように固定
  return session;
}
