// 練習の数字（src/cube/solveStats.ts）の正確さ: 精密解析の結果から出した数字と、正解から出した数字を比べる。
//   PS_DIR=$BENCH/practice（scripts/bench/practice.sh の結果: <名前>.ref.json = RefineResult）PS_TRUTH=$BENCH/truth PS_BM=$BENCH/bm PS_START=$BENCH/start
//   PS_OUT=rows.jsonl（1 本 1 行）PS_ONLY=正規表現 npx vitest run -c vitest.debug.config.ts tests/debug/solveStatsBench.debug.test.ts --silent=false
// 正解:
// - 手の時刻・向き = 原画質の動画全体の精密解析（bm）のソルブの部分（手の番号 SOLVE_START から）。buildTruth の正解は時刻が確かな読みの
//   フレームの時刻だけ（回し始め = 回し終わり、続く手が同じ時刻）なので止まった所に使えない。bm の手順が buildTruth の正解とまとめた形で
//   同じかは本ごとに出す（`truthSame`）
// - 同じ面の手がまとめられた所 = buildTruth の正解（まとめる前: 途中の状態を確かな読みで見た）で同じ面の手が続いた所。そこが結果で
//   1 手にまとめられたか・その手の時刻が 2 手目まで届いているか（届いていなければ、後ろの止まりが 2 手目の分だけ長く見える）を数える
// 止めた後の手: 正解・結果とも、最初に揃った手より後を外す（本体の stopCut の「手順の途中の揃いで切る」と同じ）
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, isSolved, moveFace, solvedState, statesEqual } from "../../src/cube/model";
import { type Pause, type Regrip, type SolveStats, type StatsMove, solveStats } from "../../src/cube/solveStats";
import { canonicalMoves } from "./lib/exact";

const SOLVE_START: Record<string, number> = { IMG_4970: 0, IMG_4971: 0, IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };
const MATCH_MS = 300; // 持ち替えを同じとみなす時刻の差

interface Ref {
  moves: (StatsMove & { exact: boolean })[];
  startState?: number[];
  solved: boolean;
  method?: string;
}

// 最初に揃った手まで（揃わなければ全部）
function untilSolved(start: CubeState, moves: StatsMove[]): { moves: StatsMove[]; cut: number } {
  let s = start;
  // 揃った状態から始まる（T-perm 2 回）ときは、1 手以上回した後の最初の揃い
  for (let i = 0; i < moves.length; i++) {
    s = applyMove(s, moves[i].move);
    if (isSolved(s)) return { moves: moves.slice(0, i + 1), cut: moves.length - i - 1 };
  }
  return { moves, cut: 0 };
}

function truthOf(name: string): { start: CubeState; moves: StatsMove[]; raw: { move: number; end: number }[] | null; truthSame: boolean | null } | null {
  const b = name.slice(0, 8);
  const bmDir = process.env.PS_BM!;
  const bm = JSON.parse(readFileSync(`${bmDir}/${b}.ref.json`, "utf8")) as Ref;
  const tf = `${process.env.PS_TRUTH}/${b}.ref.json`;
  // IMG_5047 の buildTruth は推定 50 手で正解に使えない（piecesBench と同じく原画質の精密解析を使う）
  const truth = b !== "IMG_5047" && existsSync(tf) ? (JSON.parse(readFileSync(tf, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState: number[] }) : null;
  let start: CubeState;
  let k = SOLVE_START[b];
  if (truth) start = Uint8Array.from(truth.startState);
  else {
    // IMG_5047: buildTruth が作れない。始まりの状態は startfiles.mjs のもの（原画質の精密解析のいちばん長い間の後）
    const sf = JSON.parse(readFileSync(`${process.env.PS_START}/${b}.json`, "utf8")) as { startState: number[]; k: number };
    start = Uint8Array.from(sf.startState);
    k = sf.k;
  }
  // bm の始まりから k 手回した状態が正解の始まりと同じか
  let s: CubeState = bm.startState ? Uint8Array.from(bm.startState) : solvedState();
  if (!bm.startState && b === "IMG_4972") s = start; // スキャンの始まり（bm の手は始まりの状態から）
  else for (let i = 0; i < k; i++) s = applyMove(s, bm.moves[i].move);
  if (b !== "IMG_4972" && !statesEqual(s, start)) process.stdout.write(`  （${b}: bm の ${k} 手目の後の状態が正解の始まりと違う）\n`);
  const moves = bm.moves.slice(k);
  const truthSame = truth ? canonicalMoves(truth.moves.map((m) => m.move)).join() === canonicalMoves(moves.map((m) => m.move)).join() : null;
  return { start, moves, raw: truth ? truth.moves : null, truthSame };
}

const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : NaN);

// 止まった所の対応: 正解の止まりごとに、いちばん重なる結果の止まり（1 つずつ）
function matchPauses(T: Pause[], R: Pause[]) {
  const used = new Set<number>();
  const pairs: { t: Pause; r: Pause }[] = [];
  for (const t of T) {
    let best = -1;
    let bestOv = 0;
    R.forEach((r, i) => {
      if (used.has(i)) return;
      const ov = Math.min(t.at + t.ms, r.at + r.ms) - Math.max(t.at, r.at);
      if (ov > bestOv) {
        bestOv = ov;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      pairs.push({ t, r: R[best] });
    }
  }
  return pairs;
}

function matchRegrips(T: Regrip[], R: Regrip[]) {
  const used = new Set<number>();
  const pairs: { t: Regrip; r: Regrip }[] = [];
  for (const t of T) {
    let best = -1;
    let bestD = MATCH_MS;
    R.forEach((r, i) => {
      if (used.has(i)) return;
      const d = Math.abs(r.at - t.at);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      pairs.push({ t, r: R[best] });
    }
  }
  return pairs;
}

// buildTruth の正解で同じ面の手が続いた所が、結果ではどうなったか
function merges(raw: { move: number; end: number }[], res: StatsMove[]) {
  const out: { kind: "merged" | "separate" | "canceled" | "other"; inner: number | null; endGap: number | null; early: boolean; at: number }[] = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i];
    const b = raw[i + 1];
    const f = moveFace(a.move);
    if (moveFace(b.move) !== f) continue;
    const sum = ((a.move % 3) + 1 + (b.move % 3) + 1) % 4;
    const near = res.filter((m) => moveFace(m.move) === f && m.end >= a.end - 500 && m.start <= b.end + 200);
    const inner = b.end > a.end ? b.end - a.end : null; // 1 手目・2 手目の後の状態を初めて読めた時刻の差（2 手目の回す時間を含む）
    if (near.length === 1 && sum && near[0].move === f * 3 + sum - 1) {
      const r = near[0];
      // 2 手目の後の状態を読めた時刻より前に回し終わっている = まとめた手の時刻が 1 手目に寄った（後ろの止まりが長く見える）
      out.push({ kind: "merged", inner, endGap: b.end - r.end, early: b.end > a.end && r.end <= a.end + 20, at: a.end });
    } else if (near.length >= 2) out.push({ kind: "separate", inner, endGap: null, early: false, at: a.end });
    else if (!near.length && !sum) out.push({ kind: "canceled", inner, endGap: null, early: false, at: a.end });
    else out.push({ kind: "other", inner, endGap: null, early: false, at: a.end });
    i++;
  }
  return out;
}

type Row = ReturnType<typeof compare>;
interface Extra {
  truthSame: boolean | null;
  method?: string;
  resSolved: boolean;
  startDiff: boolean;
  cutT: number;
  cutR: number;
  sameMoves: boolean;
}
function compare(name: string, T: SolveStats, R: SolveStats, extra: Extra) {
  const pp = matchPauses(T.pauses, R.pauses);
  const rp = matchRegrips(T.regrips, R.regrips);
  const phaseD = T.phases && R.phases ? T.phases.map((p, j) => ({ name: p.name, dms: R.phases![j].ms - p.ms, dmoves: R.phases![j].moves - p.moves })) : null;
  const gapD = T.phases && R.phases ? T.gaps.map((g, j) => (g.ms !== null && R.gaps[j].ms !== null ? R.gaps[j].ms! - g.ms : null)) : null;
  return {
    name,
    q: name.includes("_orig") ? "orig" : "5000k",
    ...extra,
    solvedT: T.solved,
    solvedR: R.solved,
    htm: [T.htm, R.htm],
    qtm: [T.qtm, R.qtm],
    inferredR: R.inferred,
    notExactR: R.notExact,
    ms: [T.ms, R.ms],
    phaseD,
    firstPair: [T.firstPairMs, R.firstPairMs],
    gapD,
    pausesT: T.pauses.length,
    pausesR: R.pauses.length,
    pausesRUncertain: R.pauses.filter((p) => p.uncertain).length,
    pauseMatched: pp.length,
    pauseAtD: pp.map((x) => x.r.at - x.t.at),
    pauseMsD: pp.map((x) => x.r.ms - x.t.ms),
    pauseTotal: [T.pauseTotalMs, R.pauseTotalMs],
    // しきい値の近くの取りこぼしを除いて: 正解で 400ms 以上の止まりが、結果で 200ms 以上の間として出たか
    bigPauses: T.pauses.filter((p) => p.ms >= 400).length,
    bigFound: T.pauses.filter((p) => p.ms >= 400).filter((p) => R.pauses.some((r) => Math.min(p.at + p.ms, r.at + r.ms) - Math.max(p.at, r.at) > 0)).length,
    regripsT: T.regrips.length,
    regripsR: R.regrips.length,
    regripsRUncertain: R.regrips.filter((r) => r.uncertain).length,
    regripMatched: rp.length,
    netT: T.regripsNet,
    netR: R.regripsNet,
    netMatched: matchRegrips(T.regrips.filter((r) => !r.peek), R.regrips.filter((r) => !r.peek)).length,
    peeksT: T.regrips.filter((r) => r.peek).length / 2,
    peeksR: R.regrips.filter((r) => r.peek).length / 2,
    regripSameRot: rp.filter((x) => x.t.rotation === x.r.rotation).length,
    crossRegrips: [T.regripsInCross, R.regripsInCross],
    within8: [T.cross?.within8 ?? null, R.cross?.within8 ?? null],
    crossMoves: [T.cross?.moves ?? null, R.cross?.moves ?? null],
    xcross: [T.xcross?.done ?? null, R.xcross?.done ?? null],
    xcrossLast: [T.xcross?.withLastCrossMove ?? null, R.xcross?.withLastCrossMove ?? null],
    waste: [T.wasteMoves, R.wasteMoves],
    wasteItems: [T.waste.length, R.waste.length],
  };
}

it("練習の数字の正確さ", () => {
  const dir = process.env.PS_DIR;
  if (!dir) return;
  const rows: Row[] = [];
  const mergeRows: { name: string; q: string; src: string; kind: string; inner: number | null; endGap: number | null; early: boolean; fakePause: boolean }[] = [];
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".ref.json") && new RegExp(process.env.PS_ONLY ?? ".").test(f))
    .map((f) => f.replace(".ref.json", ""))
    .sort();
  const truthStats = new Map<string, SolveStats>();
  for (const name of names) {
    const b = name.slice(0, 8);
    const truth = truthOf(name);
    if (!truth) continue;
    const tcut = untilSolved(truth.start, truth.moves);
    const T = truthStats.get(b) ?? solveStats({ startState: truth.start, moves: tcut.moves, cutBefore: tcut.cut });
    if (!truthStats.has(b)) {
      truthStats.set(b, T);
      // 正解（bm）でまとめられた所: bm も精密解析の結果
      if (truth.raw)
        for (const m of merges(truth.raw, tcut.moves)) mergeRows.push({ name: b, q: "bm", src: "bm", ...m, fakePause: false });
    }
    const res = JSON.parse(readFileSync(`${dir}/${name}.ref.json`, "utf8")) as Ref;
    const rstart = res.startState ? Uint8Array.from(res.startState) : truth.start;
    const rcut = untilSolved(rstart, res.moves);
    const R = solveStats({ startState: rstart, moves: rcut.moves, cutBefore: rcut.cut });
    const row = compare(name, T, R, { truthSame: truth.truthSame, method: res.method, resSolved: res.solved, startDiff: !!res.startState, cutT: tcut.cut, cutR: rcut.cut, sameMoves: canonicalMoves(rcut.moves.map((m) => m.move)).join() === canonicalMoves(tcut.moves.map((m) => m.move)).join() });
    rows.push(row);
    if (truth.raw)
      for (const m of merges(truth.raw, rcut.moves)) {
        // まとめた手の時刻が 1 手目に寄ったとき、その後ろの間が止まりに見えたか
        let fake = false;
        if (m.early) {
          const i = rcut.moves.findIndex((x) => x.end >= m.at - 500 && moveFace(x.move) === moveFace(truth.raw!.find((r) => r.end === m.at)!.move));
          fake = i >= 0 && R.pauses.some((p) => p.after === i);
        }
        mergeRows.push({ name, q: row.q, src: "res", ...m, fakePause: fake });
      }
    if (process.env.PS_OUT) appendFileSync(process.env.PS_OUT, `${JSON.stringify(row)}\n`);
    process.stdout.write(
      `${name}: 手数 ${T.htm}→${R.htm}（推定 ${R.inferred}）・止まり 正解 ${T.pauses.length}・結果 ${R.pauses.length}・対応 ${row.pauseMatched}・持ち替え 正解 ${T.regrips.length}・結果 ${R.regrips.length}・対応 ${row.regripMatched}（回転も同じ ${row.regripSameRot}）・クロス ${T.cross?.moves}→${R.cross?.moves}・X クロス ${T.xcross?.done}→${R.xcross?.done}${truth.truthSame === false ? "・（bm は buildTruth の正解と違う）" : ""}\n`,
    );
    if (process.env.PS_SHOW) {
      process.stdout.write(`  正解の止まり ${T.pauses.map((p) => `${(p.at / 1000).toFixed(2)}+${p.ms.toFixed(0)}`).join(" ")}\n  結果の止まり ${R.pauses.map((p) => `${(p.at / 1000).toFixed(2)}+${p.ms.toFixed(0)}${p.uncertain ? "?" : ""}`).join(" ")}\n`);
      process.stdout.write(`  正解の持ち替え ${T.regrips.map((p) => `${(p.at / 1000).toFixed(2)}:${p.rotation}`).join(" ")}\n  結果の持ち替え ${R.regrips.map((p) => `${(p.at / 1000).toFixed(2)}:${p.rotation}${p.uncertain ? "?" : ""}`).join(" ")}\n`);
      process.stdout.write(`  正解 ${T.phases?.map((p) => `${p.name} ${p.moves}手 ${p.ms.toFixed(0)}`).join("・")}\n  結果 ${R.phases?.map((p) => `${p.name} ${p.moves}手 ${p.ms.toFixed(0)}`).join("・")}\n`);
      process.stdout.write(`  手順 ${rcut.moves.map((m) => MOVE_NAMES[m.move]).join(" ")}\n`);
    }
  }

  // まとめ（画質ごと）
  const out: string[] = [];
  for (const q of ["orig", "5000k"]) {
    const rs = rows.filter((r) => r.q === q);
    if (!rs.length) continue;
    const flat = <T,>(f: (r: Row) => T[]) => rs.flatMap(f);
    const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
    const agree = (f: (r: Row) => unknown[]) => rs.filter((r) => f(r)[0] !== null && f(r)[0] === f(r)[1]).length;
    const abs = (xs: number[]) => xs.map(Math.abs);
    const phaseAbs = flat((r) => (r.phaseD ?? []).map((p) => Math.abs(p.dms)));
    const phaseMovesSame = flat((r) => (r.phaseD ?? []).map((p) => p.dmoves === 0)).filter(Boolean).length;
    const phaseN = flat((r) => r.phaseD ?? []).length;
    const gapAbs = flat((r) => (r.gapD ?? []).filter((x): x is number => x !== null).map(Math.abs));
    const fp = rs.filter((r) => r.firstPair[0] !== null && r.firstPair[1] !== null).map((r) => Math.abs(r.firstPair[1]! - r.firstPair[0]!));
    out.push(`## ${q}（${rs.length} 本。正解と同じ手順 ${rs.filter((r) => r.sameMoves).length}・bm と buildTruth が同じ ${rs.filter((r) => r.truthSame !== false).length}）`);
    out.push(`手数: HTM の差 中央 ${med(rs.map((r) => Math.abs(r.htm[1] - r.htm[0])))}・最大 ${Math.max(...rs.map((r) => Math.abs(r.htm[1] - r.htm[0])))}・同じ ${rs.filter((r) => r.htm[0] === r.htm[1]).length}/${rs.length}・QTM 同じ ${rs.filter((r) => r.qtm[0] === r.qtm[1]).length}・推定の手 ${sum((r) => r.inferredR)}・exact でない手 ${sum((r) => r.notExactR)}`);
    out.push(`フェーズ: 手数が同じ ${phaseMovesSame}/${phaseN}・時間の差 中央 ${med(phaseAbs).toFixed(0)}・90% ${p90(phaseAbs).toFixed(0)}・最大 ${Math.max(...phaseAbs).toFixed(0)}ms・初動タイムの差 中央 ${med(fp).toFixed(0)}・最大 ${Math.max(...fp).toFixed(0)}ms`);
    out.push(`つなぎ目の空白: 差 中央 ${med(gapAbs).toFixed(0)}・90% ${p90(gapAbs).toFixed(0)}・最大 ${Math.max(...gapAbs).toFixed(0)}ms（${gapAbs.length} 所）`);
    const at = abs(flat((r) => r.pauseAtD));
    const ms = abs(flat((r) => r.pauseMsD));
    out.push(
      `止まり（0.3 秒以上）: 正解 ${sum((r) => r.pausesT)}・結果 ${sum((r) => r.pausesR)}（不確か ${sum((r) => r.pausesRUncertain)}）・対応 ${sum((r) => r.pauseMatched)}（正解の ${((100 * sum((r) => r.pauseMatched)) / Math.max(1, sum((r) => r.pausesT))).toFixed(0)}%・結果の ${((100 * sum((r) => r.pauseMatched)) / Math.max(1, sum((r) => r.pausesR))).toFixed(0)}%）・位置の差 中央 ${med(at).toFixed(0)}・90% ${p90(at).toFixed(0)}ms・長さの差 中央 ${med(ms).toFixed(0)}・90% ${p90(ms).toFixed(0)}ms・0.4 秒以上の止まりを見つけた ${sum((r) => r.bigFound)}/${sum((r) => r.bigPauses)}・合計の差 中央 ${med(rs.map((r) => Math.abs(r.pauseTotal[1] - r.pauseTotal[0]))).toFixed(0)}ms`,
    );
    out.push(
      `持ち替え: 正解 ${sum((r) => r.regripsT)}・結果 ${sum((r) => r.regripsR)}（不確か ${sum((r) => r.regripsRUncertain)}）・時刻で対応 ${sum((r) => r.regripMatched)}（回転も同じ ${sum((r) => r.regripSameRot)}）・回数が同じ本 ${rs.filter((r) => r.regripsT === r.regripsR).length}/${rs.length}・回数の差 中央 ${med(rs.map((r) => Math.abs(r.regripsR - r.regripsT)))}・最大 ${Math.max(...rs.map((r) => Math.abs(r.regripsR - r.regripsT)))}・クロス中の回数が同じ ${agree((r) => r.crossRegrips)}/${rs.length}`,
    );
    out.push(
      `持ち替え（傾けて戻したものを除く）: 正解 ${sum((r) => r.netT)}・結果 ${sum((r) => r.netR)}・時刻で対応 ${sum((r) => r.netMatched)}・回数が同じ本 ${rs.filter((r) => r.netT === r.netR).length}/${rs.length}・回数の差 中央 ${med(rs.map((r) => Math.abs(r.netR - r.netT)))}・最大 ${Math.max(...rs.map((r) => Math.abs(r.netR - r.netT)))}・傾けて戻した 正解 ${sum((r) => r.peeksT)}・結果 ${sum((r) => r.peeksR)}`,
    );
    out.push(`クロス: 手数が同じ ${agree((r) => r.crossMoves)}/${rs.length}・8 手以内の判定が同じ ${agree((r) => r.within8)}・X クロスの判定が同じ ${agree((r) => r.xcross)}（正解で X クロス ${rs.filter((r) => r.xcross[0]).length}）・最後の手でペアも ${agree((r) => r.xcrossLast)}`);
    out.push(`無駄な回転: 正解 ${sum((r) => r.wasteItems[0])} 所 ${sum((r) => r.waste[0])} 手・結果 ${sum((r) => r.wasteItems[1])} 所 ${sum((r) => r.waste[1])} 手・同じ数の本 ${agree((r) => r.waste)}/${rs.length}`);
  }
  for (const src of ["bm", "orig", "5000k"]) {
    const ms = mergeRows.filter((m) => (src === "bm" ? m.src === "bm" : m.src === "res" && m.q === src));
    if (!ms.length) continue;
    const merged = ms.filter((m) => m.kind === "merged");
    const inner = ms.map((m) => m.inner).filter((x): x is number => x !== null);
    const endGap = merged.map((m) => m.endGap).filter((x): x is number => x !== null);
    out.push(
      `同じ面の手が続いた所（buildTruth の正解）→ ${src}: ${ms.length} 所・1 手にまとめた ${merged.length}・2 手のまま ${ms.filter((m) => m.kind === "separate").length}・打ち消して消えた ${ms.filter((m) => m.kind === "canceled").length}・ほか ${ms.filter((m) => m.kind === "other").length}・` +
        `1 手目と 2 手目の後を読めた時刻の差 中央 ${med(inner).toFixed(0)}・90% ${p90(inner).toFixed(0)}ms（400ms 以上 ${inner.filter((x) => x >= 400).length}）・まとめた手の回し終わり → 2 手目の後を読めた時刻 中央 ${med(endGap).toFixed(0)}・90% ${p90(endGap).toFixed(0)}ms・1 手目に寄った ${merged.filter((m) => m.early).length}（そのうち後ろが止まりに見えた ${merged.filter((m) => m.fakePause).length}）`,
    );
  }
  console.log(out.join("\n"));
}, 600000);
