import { describe, it, expect } from 'vitest';
import {
  solvedState,
  applyMove,
  applySequence,
  getFacelets,
  getAllFacelets,
  faceletString,
  isSolved,
  stateSignature,
  invertSequence,
  formatSequence,
  parseSequence,
  parseMove,
  generateScramble,
  makeRng,
  MOVES_18,
  ROTATIONS_6,
  FACE_NAMES,
  type CubeState,
} from '../src/core/cube';

const SOLVED_SIG = stateSignature(solvedState());
const isIdentity = (s: CubeState) => stateSignature(s) === SOLVED_SIG;
const seq = (n: string) => applySequence(solvedState(), n);

describe('CLAUDE.md 必須ユニットテスト', () => {
  it('U を4回 → 初期状態', () => {
    expect(isIdentity(seq('U U U U'))).toBe(true);
    // 途中では初期状態でないこと（テストが空回りしていないことの確認）
    expect(isIdentity(seq('U'))).toBe(false);
    expect(isIdentity(seq('U U'))).toBe(false);
    expect(isIdentity(seq('U U U'))).toBe(false);
  });

  it('各18手について、その手と逆手を適用 → 初期状態', () => {
    for (const m of MOVES_18) {
      const inv = formatSequence(invertSequence(m));
      const s = seq(`${m} ${inv}`);
      expect(isIdentity(s), `${m} ${inv}`).toBe(true);
      expect(isIdentity(applyMove(solvedState(), m)), `${m} alone`).toBe(false);
    }
  });

  it('(R U R\' U\') を6回 → 初期状態', () => {
    let s = solvedState();
    for (let i = 0; i < 6; i++) {
      s = applySequence(s, "R U R' U'");
      expect(isIdentity(s)).toBe(i === 5);
    }
  });

  it('T-perm ×2 → 初期状態', () => {
    const tperm = "R U R' U' R' F R2 U' R' U' R U R' F'";
    let s = applySequence(solvedState(), tperm);
    expect(isIdentity(s)).toBe(false);
    s = applySequence(s, tperm);
    expect(isIdentity(s)).toBe(true);
  });

  it('任意のスクランブルとその逆順 → 初期状態', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const scramble = generateScramble(25, makeRng(seed));
      let s = applySequence(solvedState(), scramble);
      expect(isIdentity(s), scramble).toBe(false);
      s = applySequence(s, invertSequence(scramble));
      expect(isIdentity(s), scramble).toBe(true);
    }
  });

  it('全体回転を混ぜた任意手順とその逆順 → 初期状態', () => {
    const rng = makeRng(99);
    const all = [...MOVES_18, ...ROTATIONS_6];
    for (let trial = 0; trial < 30; trial++) {
      const moves: string[] = [];
      for (let i = 0; i < 30; i++) moves.push(all[Math.floor(rng() * all.length)]);
      const n = moves.join(' ');
      const s = applySequence(applySequence(solvedState(), n), invertSequence(n));
      expect(isIdentity(s), n).toBe(true);
    }
  });

  it('全54 facelet について、各色がちょうど9個ずつ存在する（任意手順適用後も）', () => {
    const rng = makeRng(4242);
    const all = [...MOVES_18, ...ROTATIONS_6];
    const check = (s: CubeState, label: string) => {
      const f = getAllFacelets(s);
      expect(f.length).toBe(54);
      const counts = [0, 0, 0, 0, 0, 0];
      for (const c of f) counts[c]++;
      expect(counts, label).toEqual([9, 9, 9, 9, 9, 9]);
    };
    check(solvedState(), 'solved');
    let s = solvedState();
    for (let i = 0; i < 300; i++) {
      s = applyMove(s, all[Math.floor(rng() * all.length)]);
      check(s, `after ${i + 1} random moves`);
    }
  });

  it('y を4回 → 初期状態 / x, z も同様', () => {
    expect(isIdentity(seq('y y y y'))).toBe(true);
    expect(isIdentity(seq('x x x x'))).toBe(true);
    expect(isIdentity(seq('z z z z'))).toBe(true);
    expect(isIdentity(seq('y y'))).toBe(false);
  });

  it("x y x' y' 系の整合性", () => {
    // 全体回転の交換子は体対角線まわりの120度回転 → 3回で恒等
    let s = solvedState();
    for (let i = 0; i < 3; i++) {
      s = applySequence(s, "x y x' y'");
      expect(isIdentity(s)).toBe(i === 2);
    }
    // 全体回転は完成状態を壊さない
    const rng = makeRng(7);
    let t = solvedState();
    for (let i = 0; i < 50; i++) {
      t = applyMove(t, ROTATIONS_6[Math.floor(rng() * 6)]);
      expect(isSolved(t)).toBe(true);
    }
    // 共役: y は R の位置に B を運ぶので "y R y'" は B 手に等しい
    expect(stateSignature(seq("y R y'"))).toBe(stateSignature(seq('B')));
    expect(stateSignature(seq("y' R y"))).toBe(stateSignature(seq('F')));
    // x は F の位置に U... x: F(0,0,1) -> (0,1,0)=U なので "x U x'" は F 手
    expect(stateSignature(seq("x U x'"))).toBe(stateSignature(seq('F')));
    expect(stateSignature(seq("z F z'"))).toBe(stateSignature(seq('F')));
  });
});

describe('facelet 抽出', () => {
  it('完成状態は各面が自分の色', () => {
    const s = solvedState();
    for (let f = 0; f < 6; f++) {
      expect(getFacelets(s, f as 0)).toEqual([f, f, f, f, f, f, f, f, f]);
    }
    expect(faceletString(s)).toBe(
      'UUUUUUUUU' + 'RRRRRRRRR' + 'FFFFFFFFF' + 'DDDDDDDDD' + 'LLLLLLLLL' + 'BBBBBBBBB',
    );
  });

  it('R 手後の 54 facelet が標準の並びと一致する（外部リファレンス）', () => {
    // Kociemba facelet 表記での既知の結果
    expect(faceletString(seq('R'))).toBe(
      'UUFUUFUUF' + 'RRRRRRRRR' + 'FFDFFDFFD' + 'DDBDDBDDB' + 'LLLLLLLLL' + 'UBBUBBUBB',
    );
  });

  it('U 手後の 54 facelet が標準の並びと一致する（外部リファレンス）', () => {
    expect(faceletString(seq('U'))).toBe(
      'UUUUUUUUU' + 'BBBRRRRRR' + 'RRRFFFFFF' + 'DDDDDDDDD' + 'FFFLLLLLL' + 'LLLBBBBBB',
    );
  });

  it('y 回転後は各面が別の単色になる（センターも動く）', () => {
    const s = seq('y');
    expect(isSolved(s)).toBe(true);
    // y: F -> L なので、L 面には元の F 色が来る
    expect(getFacelets(s, 'L').every((c) => c === FACE_NAMES.indexOf('F'))).toBe(true);
    expect(getFacelets(s, 'F').every((c) => c === FACE_NAMES.indexOf('R'))).toBe(true);
  });
});

describe('isSolved', () => {
  it('完成 / 全体回転後は true、1手でも回すと false', () => {
    expect(isSolved(solvedState())).toBe(true);
    expect(isSolved(seq("y x' z2"))).toBe(true);
    for (const m of MOVES_18) expect(isSolved(applyMove(solvedState(), m)), m).toBe(false);
  });
});

describe('記法パーサ', () => {
  it('U U\' U2 R L F B D x y z とそのプライム/ダブルを解釈する', () => {
    expect(parseMove('U')).toMatchObject({ letter: 'U', amount: 1, token: 'U' });
    expect(parseMove("U'")).toMatchObject({ letter: 'U', amount: 3, token: "U'" });
    expect(parseMove('U2')).toMatchObject({ letter: 'U', amount: 2, token: 'U2' });
    expect(parseMove('x2')).toMatchObject({ letter: 'x', amount: 2 });
    expect(parseMove("Y'")).toMatchObject({ letter: 'y', amount: 3 });
    expect(parseMove('U’')).toMatchObject({ letter: 'U', amount: 3 });
    expect(formatSequence(parseSequence("  R  U'   F2 \n y "))).toBe("R U' F2 y");
  });

  it('不正な記法は例外', () => {
    for (const bad of ['Q', 'u', 'R3', "R''", 'R2\'', '', 'Rw']) {
      expect(() => parseMove(bad), bad).toThrow();
    }
  });

  it('x2 は x を2回と同じ', () => {
    expect(stateSignature(seq('x2'))).toBe(stateSignature(seq('x x')));
  });
});

describe('スクランブル生成', () => {
  it('指定手数・連続同軸なし・全て有効な記法', () => {
    const AXIS: Record<string, number> = { R: 0, L: 0, U: 1, D: 1, F: 2, B: 2 };
    for (let seed = 1; seed <= 200; seed++) {
      const moves = parseSequence(generateScramble(20, makeRng(seed)));
      expect(moves.length).toBe(20);
      for (let i = 0; i < moves.length; i++) {
        expect('URFDLB').toContain(moves[i].letter);
        if (i > 0) expect(AXIS[moves[i].letter]).not.toBe(AXIS[moves[i - 1].letter]);
      }
    }
  });

  it('スクランブル適用後は未完成', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(isSolved(applySequence(solvedState(), generateScramble(20, makeRng(seed))))).toBe(false);
    }
  });
});

describe('イミュータビリティ', () => {
  it('applyMove は元の状態を変更しない', () => {
    const s = applySequence(solvedState(), "R U F' D2");
    const before = stateSignature(s);
    applyMove(s, 'R');
    applySequence(s, "U R' F2 y");
    expect(stateSignature(s)).toBe(before);
  });
});
