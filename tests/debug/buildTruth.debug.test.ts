// 確かな読みに全部合う「正解」を作る（これまでの正解 = 原画質の精密解析の手順は、途中の状態が局所的に間違っていた: CLAUDE.md）。
// 確かな読み = 直接読んだマス（4 マス以上の面）で、5 枚続けて同じマスに同じステッカー（5 枚以上）。exact.ts の decodeExact を、これを
// アンカー（絶対の条件）にし、ほかの読みでは候補を落とさない（並べ替えにだけ使う）設定で、動画の最初から完成まで通す。
//   BT_DIR=dump BT_REF=bm（これまでの正解: 始まりの状態とソルブの始まりの時刻に使う）BT_OUT=フォルダ npx vitest run -c vitest.debug.config.ts tests/debug/buildTruth.debug.test.ts --silent=false
//   BT_ONLY=正規表現・BT_EXACT='{"maxSet":1024}'・BT_DEBUG=1（飛ばしたアンカー）
// 出来上がった正解を確かめる: 確かな読みのフレームがどれも、時刻の近く（前後 3 手）の状態のどれかと合うこと
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, VIEW, applyMove, parseMoves, solvedState } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { canonicalMoves, decodeExact } from "../../src/track/exact";

// これまでの正解の、ソルブの始まり（手の番号。その前に長い間がある = インスペクション）
const SOLVE_START: Record<string, number> = { IMG_4970: 0, IMG_4971: 0, IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };

// 確かな読み（5 枚続けて同じ）はアンカーでなくても絶対の条件（hardFrames）。ほかの読みでは落とさない（tolerance）
export const TRUTH_OPTIONS = { anchorFrames: 2, hardFrames: 5, pairMs: 260, tolerance: 1e5, maxSet: 512, slack: 8, deepHyps: 64, maxSkip: 8, maxDepth: 10, extraMax: 8, budgetMs: 1800000 };
// 手順が分かっている動画（T-perm 2 回）
const KNOWN: Record<string, string> = { IMG_4970: "R U R' U' R' F R2 U' R' U' R U R' F' R U R' U' R' F R2 U' R' U' R U R' F'", IMG_4971: "R U R' U' R' F R2 U' R' U' R U R' F' R U R' U' R' F R2 U' R' U' R U R' F'" };

function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

// 確かな読みのフレーム
export function stableFrames(readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[]): { t: number; cells: [number, number][] }[] {
  const maps = readings.map((r) => {
    const m = new Map<number, number>();
    for (const fc of r.faces) {
      const n = fc.ids.filter((x, c) => x >= 0 && (fc.w?.[c] ?? 1) >= 0.85).length;
      if (n >= 4) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0 && (fc.w?.[c] ?? 1) >= 0.85) m.set(fc.slot * 9 + c, fc.ids[c]);
    }
    return m;
  });
  const out: { t: number; cells: [number, number][] }[] = [];
  for (let i = 2; i + 2 < maps.length; i++) {
    const cells = [...maps[i]].filter(([p, x]) => [-2, -1, 1, 2].every((d) => maps[i + d].get(p) === x));
    if (cells.length >= 5) out.push({ t: readings[i].t, cells });
  }
  return out;
}

// 手順（時刻つき）と確かな読みの食い違い: 時刻の前後 near 手の状態のどれとも合わないフレーム
export function contradictions(start: CubeState, moves: { move: number; end: number }[], frames: { t: number; cells: [number, number][] }[], near = 3): { t: number }[] {
  const ids = [stickerIds(start)];
  let s = start;
  for (const m of moves) ids.push(stickerIds((s = applyMove(s, m.move))));
  const bad: { t: number }[] = [];
  for (const fr of frames) {
    const k0 = moves.filter((m) => m.end <= fr.t).length;
    let ok = false;
    for (let k = Math.max(0, k0 - near); k <= Math.min(ids.length - 1, k0 + near) && !ok; k++)
      for (let o = 0; o < 24 && !ok; o++) ok = fr.cells.every(([p, x]) => ids[k][VIEW[o * 54 + p]] === x);
    if (!ok) bad.push({ t: fr.t });
  }
  return bad;
}

// 手順（時刻つき）が、直接読んだマス（4 マス以上の面）とどれだけ食い違うか（フレームごとに時刻の前後 near 手・24 姿勢で一番合う状態と）
export function readingMismatch(start: CubeState, moves: { move: number; end: number }[], readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[], near = 2): { n: number; bad: number; badFrames: number[] } {
  const ids = [stickerIds(start)];
  let s = start;
  for (const m of moves) ids.push(stickerIds((s = applyMove(s, m.move))));
  let n = 0;
  let bad = 0;
  let k0 = 0;
  const badFrames: number[] = [];
  for (const r of readings) {
    const cells: [number, number][] = [];
    for (const fc of r.faces) {
      const k = fc.ids.filter((x, c) => x >= 0 && (fc.w?.[c] ?? 1) >= 0.85).length;
      if (k >= 4) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0 && (fc.w?.[c] ?? 1) >= 0.85) cells.push([fc.slot * 9 + c, fc.ids[c]]);
    }
    if (!cells.length) continue;
    while (k0 < moves.length && moves[k0].end <= r.t) k0++;
    let best = Infinity;
    for (let k = Math.max(0, k0 - near); k <= Math.min(ids.length - 1, k0 + near); k++)
      for (let o = 0; o < 24; o++) best = Math.min(best, cells.filter(([p, x]) => ids[k][VIEW[o * 54 + p]] !== x).length);
    n += cells.length;
    bad += best;
    if (best >= 2) badFrames.push(r.t);
  }
  return { n, bad, badFrames };
}

it("確かな読みに全部合う正解を作る", () => {
  const dir = process.env.BT_DIR;
  if (!dir) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith("_orig.read.json") && new RegExp(process.env.BT_ONLY ?? ".").test(x)).sort()) {
    const name = f.replace("_orig.read.json", "");
    const refF = readdirSync(process.env.BT_REF!).find((x) => x.startsWith(name))!;
    const old = JSON.parse(readFileSync(`${process.env.BT_REF}/${refF}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const rd = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    const obs = JSON.parse(readFileSync(`${dir}/${name}_orig.obs.json`, "utf8"));
    const start0 = Uint8Array.from(old.startState ?? obs.start);
    const K = SOLVE_START[name] ?? 0;
    const solveStart = old.moves[K].start;
    const frames = stableFrames(rd.readings);
    // ソルブの部分だけ: 始まりの状態はこれまでの正解のその時の状態（インスペクション中の確かな読みと食い違わないことを確かめる）
    let start: CubeState = start0;
    for (let i = 0; i < K; i++) start = applyMove(start, old.moves[i].move);
    const insp = frames.filter((fr) => fr.t >= solveStart - 3000 && fr.t < solveStart - 100);
    const badInsp = contradictions(start, [], insp, 0).length;
    const solveFrames = frames.filter((fr) => fr.t >= solveStart - 1500);
    const oldSolve = old.moves.slice(K);
    if (KNOWN[name]) {
      const known = parseMoves(KNOWN[name]);
      const same = known.length === oldSolve.length && known.every((m, i) => m === oldSolve[i].move);
      const bad = contradictions(start, oldSolve, solveFrames).length;
      process.stdout.write(`${name}: 手順が分かっている（これまでの正解と${same ? "同じ" : "違う"}・確かな読みと合わない ${bad}）\n`);
      if (process.env.BT_OUT && same) writeFileSync(`${process.env.BT_OUT}/${refF}`, JSON.stringify({ moves: oldSolve, startState: Array.from(start), solveStart, method: "known" }));
      continue;
    }
    const sights = rd.readings.filter((x: { t: number }) => x.t >= solveStart - 1500);
    const r = decodeExact(sights, start, solvedState(), { ...TRUTH_OPTIONS, ...JSON.parse(process.env.BT_EXACT ?? "{}"), ...(process.env.BT_DEBUG ? { debug: (m: string) => m.includes("飛ばす") && process.stdout.write(`  ${m}\n`) } : {}) });
    const moves = r.moves.map((m) => ({ move: m.move, start: m.t0 ?? m.t, end: m.t, ...(m.inferred ? { inferred: true } : {}) }));
    const badNew = contradictions(start, moves, solveFrames);
    const badOld = contradictions(start, oldSolve, solveFrames);
    const cut = (ms: { move: number; start: number }[]) => ms.map((m) => m.move);
    const dSolve = editDistance(canonicalMoves(cut(moves)), canonicalMoves(cut(oldSolve)));
    process.stdout.write(
      `${name}: ${r.method}・${(r.ms / 1000).toFixed(0)} 秒・${moves.length} 手（推定 ${moves.filter((m) => m.inferred).length}）・アンカー ${r.anchors}・インスペクション中の確かな読みと始まりの状態の食い違い ${badInsp}/${insp.length}・確かな読みのフレーム ${solveFrames.length} のうち合わない: 新しい正解 ${badNew.length}・これまでの正解 ${badOld.length}・手順の違い ${dSolve}（これまでの正解 ${canonicalMoves(cut(oldSolve)).length} 手）${r.reason ? `・${r.reason}` : ""}\n`,
    );
    if (badNew.length) process.stdout.write(`  新しい正解と合わない時刻: ${badNew.slice(0, 20).map((b) => (b.t / 1000).toFixed(2)).join(" ")}\n`);
    if (process.env.BT_SHOW) process.stdout.write(`  新 ${moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ")}\n  旧 ${cut(oldSolve).map((m) => MOVE_NAMES[m]).join(" ")}\n`);
    if (process.env.BT_OUT && r.reachedEnd) writeFileSync(`${process.env.BT_OUT}/${refF}`, JSON.stringify({ moves, startState: Array.from(start), solveStart, method: r.method }));
  }
}, 36000000);
