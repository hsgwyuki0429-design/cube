// 精密解析 3 の前の計測: 「島に分けて解く」（確かな読みで続いている所は確定に、確かな読みのない所だけ「分からない」に）を作る価値が
// あるかを、作る前に上限で測る。アプリの動きは変えない（src/track/pieces/solve.ts の solveForwardOnly・strongReadings は調査用）。
//   IB_DIR=材料（piecesBench と同じ .read.json・.obs.json）IB_TRUTH=buildTruth の BT_OUT IB_BM=原画質の動画全体の精密解析（REAL_REF）
//   IB_ORIG=原画質の材料のフォルダ（隙間の原因の見立て。<動画>_orig.read.json）IB_ONLY=正規表現 IB_OUT=ファイル（1 行 1 つの JSON を足す）
//   IB_NOFLOW=1（今の流れを解かない）IB_SHOW=1（島・隙間を並べる）
//   npx vitest run -c vitest.debug.config.ts tests/debug/islandBound.debug.test.ts --silent=false
// 1 本ずつ別のプロセスで回すこと（解き直しには時間の上限があり、重さで答えが変わりうる）。
//
// 測るもの（本ごと）:
//   今の流れ: 本体と同じ（ピース方式 = 表の AND 版 → 完成までつながらなければ今の方式。src/vision/refine.ts の result）。確定にできた手の
//     割合（まとめた形で正解と対応する確定の手 / 正解の手）と確定の間違い（まとめた形 wrongSure・状態で照らす wrongByState）。今の方式でも
//     つながらない本は、本体ではライブと同じ前向きの結果に戻るが、ここでは確定 0・間違い 0 と数える（piecesBench と同じ）
//   隙間・島: 見え方（decode.ts の buildSights）のうち、確かな読み（solve.ts の strongOf: strongBits を満たす読み）が 1 つ以上あり、それが
//     正解の状態（見え方の前後 150ms の正解の状態のどれか）と合うものを「確かな見え方」とする。確かな見え方の間（前の終わり〜次の始め）が
//     MIN_GAP_MS より長いものを隙間（ソルブの間 = 正解の最初の手の回し始め〜最後の手の回し終わりに切る）、1 秒より短いものを短い隙間とする。
//     島 = 隙間で切った確かな見え方の続き（主は 1 秒以上の隙間だけで切る: 短い隙間は島の中。分けて、短い隙間でも切ったものも）
//   上限 A: 正解の手（まとめた形）のうち、回し始めと回し終わりの両側に同じ島の確かな見え方がある手の割合
//   上限 B: 島ごとに（1 秒以上の隙間で切った島）、島のフレームだけで表を作り、島の始まりの状態を正解から与えて（ずる）解く:
//     B1 = 前向きだけ（solveForwardOnly: いちばんよい仮説の終わりの状態で verifyPath）、B2 = 終わりの状態も正解から与えて solvePieces（前後から）。
//     島の中の正解の手（島の始め〜終わりに回し終わった手）と比べ、確定にできた手・確定の間違い・推定を足す
//   上限 B3（始まりの状態を与えない見込み）: 島の始めは何も分からないとし、確かな見え方ごとに、分かっているピース（前に確かに読み、その後の
//     手で行き先が 1 つに決まったもの）からその見え方の確かな読みへの式を表の AND で解き、最小の手の数の解が 1 つで正解と同じなら「決まる」。
//     読めないピースは「分からない」のまま。読み違いもそのまま使う（解が 1 つで正解と違えば「間違って決まる」）。弱い読み・答えの確かめは使わない
//   隙間の原因（IB_ORIG があれば）: 原画質でもその時刻に確かな見え方がなければ原画質の原因（面が見つからないフレームが半分より多ければ
//     「画面の外」、正解の手が 1 秒に 3 手以上なら「回している（ぶれ）」、それ以外は「指・角度」）、原画質なら確かな見え方があれば「圧縮」
//     （精密解析 1a の gapCause と同じ割り振り。時間で割る）
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, solvedState, statesEqual } from "../../src/cube/model";
import { applySeq as applySeqPieces, buildSights, canonical, canonicalWithIndex, type Sight } from "../../src/track/pieces/decode";
import { piecesOf } from "../../src/track/pieces/model";
import { solvePieces, solveForwardOnly, strongReadings } from "../../src/track/pieces/solve";
import { type PieceTable, buildTable } from "../../src/track/pieces/table";
import { type CenterEq, type Eq, solveExact } from "../../src/track/pieces/tables";
import type { Observation } from "../../src/track/types";
import { type RawObs, type Reading, oldDecode, toSights, truthOf, wrongByState, wrongSure } from "./piecesBench.debug.test";

const MIN_GAP_MS = 300; // これより短い確かな見え方の間は隙間にしない（1 手の回転ほど）
const LONG_GAP_MS = 1000;
const WIN_MS = 150; // 読みと正解の状態を照らす前後の幅（piecesBench の PB_EPS と同じ）

type TMove = { move: number; start: number; end: number };

// 正解（時刻つき）。T-perm 2 本は正解に時刻がないので、原画質の動画全体の精密解析（同じ手順）の時刻を使う
function timedTruth(name: string, rdStart: number[]): { start: CubeState; moves: TMove[]; note: string } | null {
  const t = truthOf(name, rdStart);
  if (!t) return null;
  if (t.moves.every((m) => Number.isFinite(m.end))) return t;
  const bm = process.env.IB_BM;
  if (!bm) return t;
  const rf = readdirSync(bm).find((f) => f.startsWith(name.slice(0, 8)));
  if (!rf) return t;
  const ref = JSON.parse(readFileSync(`${bm}/${rf}`, "utf8")) as { moves: TMove[] };
  if (canonical(ref.moves.map((m) => m.move)).join() !== canonical(t.moves.map((m) => m.move)).join()) return t;
  return { ...t, moves: ref.moves.map((m) => ({ move: m.move, start: m.start, end: m.end })), note: `${t.note}（時刻は原画質の精密解析）` };
}

interface StrongSightInfo {
  i: number;
  t0: number;
  t1: number;
  n: number; // 確かな読みの数（ピース + センターの向き）
  ok: number; // そのうち正解の状態と合う
  to: Int16Array;
  center: Int8Array;
  chain: { face: number; byPhi: { P: number[]; A: number[] }[] }[];
  k: number; // 確かな読みにいちばん合う正解の状態（何手の後か。同じなら時刻の近い方）
}

// 正解の状態の並び（k 手の後）と、時刻 t までに回し終わった手の数
function timeline(start: CubeState, moves: TMove[]) {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m.move));
  const pieces = states.map((s) => piecesOf(s));
  const kAt = (t: number) => {
    let k = 0;
    while (k < moves.length && moves[k].end <= t) k++;
    return k;
  };
  // センターの向き（面を回した量の合計 mod 4）: 最初の向きは分からないので、差だけを見る
  const turnsAt = (f: number, k: number) => {
    let n = 0;
    for (let j = 0; j < k; j++) if (Math.floor(moves[j].move / 3) === f) n += (moves[j].move % 3) + 1;
    return n & 3;
  };
  return { states, pieces, kAt, turnsAt };
}

function strongSights(sights: Sight[], tl: ReturnType<typeof timeline>): StrongSightInfo[] {
  // センターの向きの最初の値（面ごと）: 確かな読みでいちばん多い「読み − 回した量」
  const votes = Array.from({ length: 6 }, () => [0, 0, 0, 0]);
  const info = sights.map((sg, i) => {
    const st = strongReadings(sg);
    const k = tl.kAt((sg.t0 + sg.t1) / 2);
    for (let f = 0; f < 6; f++) if (st.center[f] >= 0) votes[f][(st.center[f] - tl.turnsAt(f, k) + 4) & 3]++;
    return { i, sg, st };
  });
  const off = votes.map((v) => v.indexOf(Math.max(...v)));
  return info.map(({ i, sg, st }) => {
    const k0 = tl.kAt(sg.t0 - WIN_MS);
    const k1 = tl.kAt(sg.t1 + WIN_MS);
    let n = 0;
    let ok = 0;
    for (let p = 0; p < 20; p++) {
      if (st.to[p] < 0) continue;
      n++;
      for (let k = k0; k <= k1; k++)
        if (tl.pieces[k][p] === st.to[p]) {
          ok++;
          break;
        }
    }
    for (let f = 0; f < 6; f++) {
      if (st.center[f] < 0) continue;
      n++;
      for (let k = k0; k <= k1; k++)
        if (((off[f] + tl.turnsAt(f, k)) & 3) === st.center[f]) {
          ok++;
          break;
        }
    }
    // センター 1 つの面の確かな読み: どれかの向きで全部合えば 1 本と数える
    for (const ch of st.chain) {
      if (!ch.byPhi.some((b) => b.P.length)) continue;
      n++;
      let hit = false;
      for (const b of ch.byPhi) {
        if (!b.P.length || hit) continue;
        for (let k = k0; k <= k1 && !hit; k++) if (b.P.every((p, j) => tl.pieces[k][p] === b.A[j])) hit = true;
      }
      if (hit) ok++;
    }
    // 見え方の状態: 前後 400ms の正解の状態のうち、確かな読み（ピース・センターの向き）がいちばん多く合うもの
    const kMid = tl.kAt((sg.t0 + sg.t1) / 2);
    let kBest = kMid;
    let sBest = -1;
    for (let k = tl.kAt(sg.t0 - 400); k <= tl.kAt(sg.t1 + 400); k++) {
      let sc = 0;
      for (let p = 0; p < 20; p++) if (st.to[p] >= 0 && tl.pieces[k][p] === st.to[p]) sc++;
      for (let f = 0; f < 6; f++) if (st.center[f] >= 0 && ((off[f] + tl.turnsAt(f, k)) & 3) === st.center[f]) sc++;
      if (sc > sBest || (sc === sBest && Math.abs(k - kMid) < Math.abs(kBest - kMid))) {
        sBest = sc;
        kBest = k;
      }
    }
    return { i, t0: sg.t0, t1: sg.t1, n, ok, to: st.to, center: st.center, chain: st.chain, k: kBest };
  });
}

interface Island {
  s0: number; // 確かな見え方の番号（strong の中）
  s1: number;
  t0: number;
  t1: number;
}
function islandsOf(strong: StrongSightInfo[], splitMs: number): Island[] {
  const out: Island[] = [];
  for (let j = 0; j < strong.length; j++) {
    const last = out[out.length - 1];
    if (last && strong[j].t0 - strong[last.s1].t1 < splitMs) {
      last.s1 = j;
      last.t1 = strong[j].t1;
    } else out.push({ s0: j, s1: j, t0: strong[j].t0, t1: strong[j].t1 });
  }
  return out;
}

// まとめた形の正解の手ごとの、回し始め・回し終わり
function canonicalTimes(moves: TMove[]): { m: number; start: number; end: number }[] {
  return canonicalWithIndex(moves.map((m) => m.move)).map((c) => ({ m: c.m, start: Math.min(...c.idx.map((k) => moves[k].start)), end: Math.max(...c.idx.map((k) => moves[k].end)) }));
}

const subTable = (table: PieceTable, t0: number, t1: number): PieceTable => ({ ...table, frames: table.frames.filter((f) => f.t >= t0 && f.t <= t1) });

it("島に分けて解く上限", () => {
  const dir = process.env.IB_DIR;
  if (!dir) return;
  // 正解の読み込み（piecesBench の truthOf）は PB_TRUTH・PB_BM を読む
  if (process.env.IB_TRUTH) process.env.PB_TRUTH = process.env.IB_TRUTH;
  if (process.env.IB_BM) process.env.PB_BM = process.env.IB_BM;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".read.json")).sort()) {
    const name = file.replace(".read.json", "");
    if (process.env.IB_ONLY && !new RegExp(process.env.IB_ONLY).test(name)) continue;
    const rd = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { start: number[]; readings: Reading[] };
    const truth = timedTruth(name, rd.start);
    if (!truth) continue;
    const start = Uint8Array.from(rd.start);
    const end = solvedState();
    const want = canonical(truth.moves.map((m) => m.move));
    const N = want.length;
    const table = buildTable(toSights(rd.readings));
    const sights = buildSights(table);
    const lines: string[] = [];
    const row: Record<string, unknown> = { name, n: N, note: truth.note };
    const m = /_(orig|(\d+)k)(?:_s(\d))?$/.exec(name.replace("_full", ""));
    row.q = m ? m[1] : "?";
    row.shift = m?.[3] !== undefined ? Number(m[3]) : 0;

    // 1. 今の流れ（本体と同じ: 表の AND 版 → だめなら今の方式）
    if (!process.env.IB_NOFLOW) {
      const a0 = performance.now();
      const and = solvePieces(table, start, end);
      let moves: { move: number; inferred?: boolean; t?: number }[] = and.moves;
      let method = "and";
      let solved = and.reachedEnd;
      if (!solved) {
        const raw = JSON.parse(readFileSync(`${dir}/${name}.obs.json`, "utf8")) as { lastT: number; obs: RawObs[] };
        const obs: Observation[] = raw.obs.map((o) => ({
          ...o,
          faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
        }));
        const r = oldDecode(obs, start, end, raw.lastT, rd.readings);
        moves = r.moves;
        method = "old";
        solved = r.reachedEnd && !(r.startState && !statesEqual(r.startState, start));
      }
      const ws = solved ? wrongSure(moves, want) : { ok: 0, wrong: 0 };
      const bs = solved ? wrongByState(moves, truth.moves, start) : { wrong: 0, at: [] };
      row.flow = { method, solved, andSolved: and.reachedEnd, ok: ws.ok, wrong: ws.wrong, wrongByState: bs.wrong, inferred: solved ? moves.filter((x) => x.inferred).length : 0, ms: Math.round(performance.now() - a0) };
      lines.push(`今の流れ ${method}${solved ? " 完成" : " 未完"} 確定 ${ws.ok}/${N}（${((100 * ws.ok) / N).toFixed(0)}%）確定の間違い ${ws.wrong}/${bs.wrong} 推定 ${(row.flow as { inferred: number }).inferred}`);
    }

    // 2. 確かな見え方・隙間・島
    const tl = timeline(truth.start, truth.moves);
    if (!truth.moves.every((x) => Number.isFinite(x.end))) {
      lines.push("（正解に時刻がない: 上限は測れない）");
      process.stdout.write(`${name} ${lines.join("\n  ")}\n`);
      if (process.env.IB_OUT) appendFileSync(process.env.IB_OUT, `${JSON.stringify(row)}\n`);
      continue;
    }
    const all = strongSights(sights, tl);
    const strong = all.filter((s) => s.ok > 0);
    const bad = all.filter((s) => s.n > 0 && s.ok === 0).length;
    const T0 = truth.moves[0].start;
    const T1 = truth.moves[truth.moves.length - 1].end;
    // 隙間（ソルブの間に切る）
    const gaps: { g0: number; g1: number }[] = [];
    const pushGap = (g0: number, g1: number) => {
      const a = Math.max(g0, T0);
      const b = Math.min(g1, T1);
      if (b - a > MIN_GAP_MS) gaps.push({ g0: a, g1: b });
    };
    if (strong.length) {
      pushGap(T0, strong[0].t0);
      for (let j = 1; j < strong.length; j++) pushGap(strong[j - 1].t1, strong[j].t0);
      pushGap(strong[strong.length - 1].t1, T1);
    } else pushGap(T0, T1);
    const lens = gaps.map((g) => g.g1 - g.g0).sort((x, y) => x - y);
    const longGaps = lens.filter((x) => x >= LONG_GAP_MS);
    row.gaps = { n: lens.length, short: lens.length - longGaps.length, long: longGaps.length, med: lens.length ? Math.round(lens[Math.floor(lens.length / 2)]) : 0, max: lens.length ? Math.round(lens[lens.length - 1]) : 0, sumLong: Math.round(longGaps.reduce((x, y) => x + y, 0)), sum: Math.round(lens.reduce((x, y) => x + y, 0)), solveMs: Math.round(T1 - T0), strongSights: strong.length, sights: sights.length, badSights: bad, lens: lens.map(Math.round) };
    lines.push(`見え方 ${sights.length}・確かな見え方 ${strong.length}（正解と合わない確かな読みだけの見え方 ${bad}）・隙間 ${lens.length}（1 秒以上 ${longGaps.length}・合計 ${(longGaps.reduce((x, y) => x + y, 0) / 1000).toFixed(1)} 秒）中央 ${((row.gaps as { med: number }).med / 1000).toFixed(2)} 最大 ${((row.gaps as { max: number }).max / 1000).toFixed(2)} 秒 / ソルブ ${((T1 - T0) / 1000).toFixed(1)} 秒`);

    // 上限 A
    const ct = canonicalTimes(truth.moves);
    // 島の中の手: 島の最初の確かな見え方の状態の後〜最後の確かな見え方の状態の前に回した手（状態は確かな読みで決める: 時刻より確か。
    // 見え方の境目は層が止まる前に来ることがある）
    const cIdx = canonicalWithIndex(truth.moves.map((x) => x.move)).map((c) => c.idx);
    const inside = (isl: Island[]) => cIdx.map((idx) => isl.some((I) => idx.every((k) => k >= strong[I.s0].k && k < strong[I.s1].k)));
    const islands = islandsOf(strong, LONG_GAP_MS);
    const islandsStrict = islandsOf(strong, MIN_GAP_MS);
    const inA = inside(islands);
    const inAStrict = inside(islandsStrict);
    row.A = { ok: inA.filter(Boolean).length, strict: inAStrict.filter(Boolean).length, islands: islands.length, islandsStrict: islandsStrict.length };
    lines.push(`上限 A: 島の中の手 ${inA.filter(Boolean).length}/${ct.length}（${((100 * inA.filter(Boolean).length) / ct.length).toFixed(0)}%・島 ${islands.length}）・短い隙間でも切ると ${inAStrict.filter(Boolean).length}（島 ${islandsStrict.length}）`);

    // 上限 B（島の始まりの状態を正解から与える）
    const B1 = { ok: 0, wrong: 0, byState: 0, inferred: 0, want: 0, islands: 0 };
    const B2 = { ok: 0, wrong: 0, byState: 0, inferred: 0, want: 0, islands: 0, failed: 0 };
    for (const I of islands) {
      const k0 = strong[I.s0].k;
      const k1 = strong[I.s1].k;
      if (k1 <= k0) continue;
      const seg = truth.moves.slice(k0, k1);
      const wantSeg = canonical(seg.map((x) => x.move));
      const sA = tl.states[k0];
      const sB = tl.states[k1];
      const sub = subTable(table, I.t0, I.t1);
      const f = solveForwardOnly(sub, sA);
      const w1 = wrongSure(f.moves, wantSeg);
      B1.ok += w1.ok;
      B1.wrong += w1.wrong;
      B1.byState += wrongByState(f.moves, seg, sA).wrong;
      B1.inferred += f.moves.filter((x) => x.inferred).length;
      B1.want += wantSeg.length;
      B1.islands++;
      const r = solvePieces(sub, sA, sB);
      B2.want += wantSeg.length;
      B2.islands++;
      if (!r.reachedEnd) {
        B2.failed++;
        if (process.env.IB_SHOW) lines.push(`  島 ${(I.t0 / 1000).toFixed(2)}〜${(I.t1 / 1000).toFixed(2)} 手 ${wantSeg.length}: 前後から つながらない・前向き 確定 ${w1.ok} 間違い ${w1.wrong}`);
        continue;
      }
      const w2 = wrongSure(r.moves, wantSeg);
      B2.ok += w2.ok;
      B2.wrong += w2.wrong;
      B2.byState += wrongByState(r.moves, seg, sA).wrong;
      B2.inferred += r.moves.filter((x) => x.inferred).length;
      if (process.env.IB_SHOW) lines.push(`  島 ${(I.t0 / 1000).toFixed(2)}〜${(I.t1 / 1000).toFixed(2)} 手 ${wantSeg.length}: 前向き 確定 ${w1.ok} 間違い ${w1.wrong}・前後から 確定 ${w2.ok} 間違い ${w2.wrong} 推定 ${r.moves.filter((x) => x.inferred).length}`);
    }
    row.B1 = B1;
    row.B2 = B2;
    lines.push(`上限 B: 前向き（始まりを与える）確定 ${B1.ok}/${N}（${((100 * B1.ok) / N).toFixed(0)}%）間違い ${B1.wrong}/${B1.byState} 推定 ${B1.inferred}・前後から（両端を与える）確定 ${B2.ok}/${N}（${((100 * B2.ok) / N).toFixed(0)}%）間違い ${B2.wrong}/${B2.byState} 推定 ${B2.inferred}・つながらない島 ${B2.failed}/${B2.islands}`);

    // 上限 B3（始まりの状態を与えない）: 島の始めは何も分からない。確かな見え方ごとに、分かっているピースの位置（前の見え方までに確かに読んで、
    // その後の手で行き先が 1 つに決まったもの）から、この見え方の確かな読みへの式を表の AND で解く（最小の手の数の解）。読めなかったピースは
    // 「分からない」のまま。1 秒以上の隙間（島の境目）で全部「分からない」に戻す
    const B3 = { ok: 0, wrong: 0, byState: 0, inferred: 0, sure: 0 };
    let isl3: { move: number; inferred?: boolean }[] = [];
    let k3 = 0;
    const flush3 = (kEnd: number) => {
      if (kEnd > k3) {
        const seg = truth.moves.slice(k3, kEnd);
        const w = wrongSure(isl3, canonical(seg.map((x) => x.move)));
        B3.ok += w.ok;
        B3.wrong += w.wrong;
        B3.byState += wrongByState(isl3, seg, tl.states[k3]).wrong;
      }
      B3.inferred += isl3.filter((x) => x.inferred).length;
      B3.sure += isl3.filter((x) => !x.inferred).length;
      isl3 = [];
    };
    let known = new Int16Array(20).fill(-1);
    let knownC = new Int8Array(6).fill(-1);
    // 見え方 b の確かな読みの組（センター 1 つの面は、センターの向きの候補ごと: 向きが分かっていれば回した量 d ごとにセンターの式つき）
    type V = { to: Int16Array; c: Int8Array; centers: CenterEq[] };
    const variantsOf = (b: StrongSightInfo, kc: Int8Array): V[] => {
      let out: V[] = [{ to: Int16Array.from(b.to), c: Int8Array.from(b.center), centers: [] }];
      for (const ch of b.chain.filter((x) => b.center[x.face] < 0 && x.byPhi.some((y) => y.P.length)).slice(0, 2)) {
        const nx: V[] = [];
        for (const v of out)
          for (let d = 0; d < 4; d++) {
            const phi = kc[ch.face] >= 0 ? (kc[ch.face] + d) & 3 : d;
            const e = ch.byPhi[phi];
            if (!e.P.length) continue;
            const to = Int16Array.from(v.to);
            e.P.forEach((p, i) => to[p] < 0 && (to[p] = e.A[i]));
            const c = Int8Array.from(v.c);
            c[ch.face] = phi;
            nx.push({ to, c, centers: kc[ch.face] >= 0 ? [...v.centers, { f: ch.face, d, w: 1 }] : v.centers });
          }
        if (nx.length) out = nx;
      }
      return out;
    };
    for (let j = 0; j < strong.length; j++) {
      const b = strong[j];
      const a = j > 0 ? strong[j - 1] : null;
      if (!a || b.t0 - a.t1 >= LONG_GAP_MS) {
        if (a) flush3(a.k);
        k3 = b.k;
        // 島の始め: センター 1 つの面は向きが決まらないので使わない
        known = Int16Array.from(b.to);
        knownC = Int8Array.from(b.center);
        continue;
      }
      const k0 = a.k;
      const k1 = b.k;
      const wantSeg = k1 > k0 ? canonical(truth.moves.slice(k0, k1).map((x) => x.move)) : [];
      const vs = variantsOf(b, knownC);
      // 変わり方ごとの最小の手の数の解（全部の変わり方で最小のものだけ）
      let kMin = 99;
      let anyEq = false;
      const found: { v: V; q: number[] }[] = [];
      for (const v of vs) {
        const eqs: Eq[] = [];
        for (let p = 0; p < 20; p++) if (known[p] >= 0 && v.to[p] >= 0) eqs.push({ from: known[p], to: v.to[p], w: 1 });
        const centers: CenterEq[] = [...v.centers];
        for (let f = 0; f < 6; f++) if (knownC[f] >= 0 && b.center[f] >= 0) centers.push({ f, d: (b.center[f] - knownC[f] + 4) & 3, w: 1 });
        if (!eqs.length && !centers.length) continue;
        anyEq = true;
        for (let k = 0; k <= Math.min(6, kMin); k++) {
          const sols = solveExact(k, eqs, centers, 65);
          if (!sols.length) continue;
          if (k < kMin) {
            kMin = k;
            found.length = 0;
          }
          for (const q of sols) found.push({ v, q });
          break;
        }
      }
      const distinct = new Set(found.map((x) => canonical(x.q).join()));
      // 解が 1 つ（まとめた形で）なら確定、2 つ以上なら 1 つ目を推定として。解がなければ（読み違い）手を入れない
      if (found.length) for (const m of found[0].q) isl3.push(distinct.size === 1 ? { move: m } : { move: m, inferred: true });
      if (process.env.IB_SHOW === "2") lines.push(`  ${(a.t1 / 1000).toFixed(2)}〜${(b.t0 / 1000).toFixed(2)} 正解 [${wantSeg.map((x) => MOVE_NAMES[x]).join(" ")}] 変わり方 ${vs.length} 解 ${[...distinct].slice(0, 3).map((q) => q.split(",").filter(Boolean).map((x) => MOVE_NAMES[Number(x)]).join(" ")).join(" | ")}${distinct.size > 3 ? ` …${distinct.size}` : ""}${anyEq ? "" : "（式なし）"}`);
      // 分かっているピースを進める: 解の組が 64 個までなら、どの解でも同じになるピースだけ残す（なければ・多すぎれば、この見え方の読みだけ）
      const next = new Int16Array(20).fill(-1);
      const nextC = new Int8Array(6).fill(-1);
      const dests = found.length && found.length <= 64
        ? found.map(({ v, q }) => {
            const s = new Uint8Array(26);
            for (let p = 0; p < 20; p++) s[p] = known[p] >= 0 ? known[p] : 0;
            for (let f = 0; f < 6; f++) s[20 + f] = knownC[f] >= 0 ? knownC[f] : 4;
            const d = applySeqPieces(s, q);
            const o = new Int16Array(26).fill(-1);
            for (let p = 0; p < 20; p++) o[p] = v.to[p] >= 0 ? v.to[p] : known[p] >= 0 ? d[p] : -1;
            for (let f = 0; f < 6; f++) o[20 + f] = v.c[f] >= 0 ? v.c[f] : knownC[f] >= 0 ? d[20 + f] : -1;
            return o;
          })
        : [];
      if (dests.length) {
        for (let p = 0; p < 20; p++) if (dests.every((d) => d[p] === dests[0][p])) next[p] = dests[0][p];
        for (let f = 0; f < 6; f++) if (dests.every((d) => d[20 + f] === dests[0][20 + f])) nextC[f] = dests[0][20 + f];
      } else {
        next.set(b.to);
        nextC.set(b.center);
      }
      known = next;
      knownC = nextC;
    }
    if (strong.length) flush3(strong[strong.length - 1].k);
    row.B3 = B3;
    lines.push(`上限 B3（始まりを与えない・読めたピースだけを持つ）: 確定 ${B3.ok}/${N}（${((100 * B3.ok) / N).toFixed(0)}%）間違い ${B3.wrong}/${B3.byState}・確定にした手 ${B3.sure}・推定 ${B3.inferred}`);

    // 隙間の原因（原画質の材料と照らす）
    const origDir = process.env.IB_ORIG;
    const origFile = origDir ? `${origDir}/${name.slice(0, 8)}_orig.read.json` : "";
    if (origFile && existsSync(origFile) && gaps.length) {
      const ord = JSON.parse(readFileSync(origFile, "utf8")) as { readings: Reading[] };
      const otb = buildTable(toSights(ord.readings));
      const ostrong = strongSights(buildSights(otb), tl).filter((s) => s.ok > 0);
      // 原画質の確かな見え方の間（MIN_GAP_MS より長いもの）
      const ogaps: { g0: number; g1: number }[] = [];
      for (let j = 1; j < ostrong.length; j++) if (ostrong[j].t0 - ostrong[j - 1].t1 > MIN_GAP_MS) ogaps.push({ g0: ostrong[j - 1].t1, g1: ostrong[j].t0 });
      if (ostrong.length) {
        ogaps.unshift({ g0: Number.NEGATIVE_INFINITY, g1: ostrong[0].t0 });
        ogaps.push({ g0: ostrong[ostrong.length - 1].t1, g1: Number.POSITIVE_INFINITY });
      }
      const cause = { compress: 0, motion: 0, finger: 0, outside: 0 };
      const causeLong = { compress: 0, motion: 0, finger: 0, outside: 0 };
      for (const g of gaps) {
        const long = g.g1 - g.g0 >= LONG_GAP_MS;
        let covered = 0;
        for (const o of ogaps) {
          const a = Math.max(g.g0, o.g0);
          const b = Math.min(g.g1, o.g1);
          if (b <= a) continue;
          covered += b - a;
          const fr = ord.readings.filter((r) => r.t >= a && r.t <= b);
          const empty = fr.filter((r) => !r.faces.length).length;
          const nMoves = truth.moves.filter((x) => x.end > a && x.start < b).length;
          const key = fr.length && empty * 2 > fr.length ? "outside" : (nMoves * 1000) / Math.max(1, b - a) >= 3 ? "motion" : "finger";
          cause[key] += b - a;
          if (long) causeLong[key] += b - a;
        }
        cause.compress += g.g1 - g.g0 - covered;
        if (long) causeLong.compress += g.g1 - g.g0 - covered;
      }
      const r = (o: typeof cause) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
      row.cause = r(cause);
      row.causeLong = r(causeLong);
      lines.push(`隙間の原因（秒）: 圧縮 ${(cause.compress / 1000).toFixed(1)}・回している ${(cause.motion / 1000).toFixed(1)}・指・角度 ${(cause.finger / 1000).toFixed(1)}・画面の外 ${(cause.outside / 1000).toFixed(1)}`);
    }
    if (process.env.IB_SHOW) lines.push(`隙間 ${gaps.map((g) => `${(g.g0 / 1000).toFixed(2)}〜${(g.g1 / 1000).toFixed(2)}`).join(" ")}`);
    process.stdout.write(`${name} ${truth.note}\n  ${lines.join("\n  ")}\n`);
    if (process.env.IB_OUT) appendFileSync(process.env.IB_OUT, `${JSON.stringify(row)}\n`);
  }
}, 36000000);
