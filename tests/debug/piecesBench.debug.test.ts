// ピースの時刻表による解き直し（src/track/pieces）を、書き出した読み（realVideo.debug.test.ts の REAL_RREADINGS）で測る。
// 正解は PB_REF の <動画>.ref.json（原画質の精密解析の手順か、buildTruth の正解）。手順はまとめた形（rescore.ts の canonical）で比べる。
//   PB_DIR=dump PB_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false
//   PB_ONLY=正規表現・PB_OPT='{"beam":64}'（solve.ts）・PB_TABLE='{"frameWeight":0.4}'（table.ts）・PB_SHOW=1（違う所）・PB_FROM=秒（そこから。正解のその時の状態で始める）
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, solvedState } from "../../src/cube/model";
import type { SightFrame } from "../../src/track/pieces/frame";
import { fromCubeState } from "../../src/track/pieces/model";
import { decodePieces } from "../../src/track/pieces/decode";
import { solveBoth } from "../../src/track/pieces/meet";
import { solvePieces } from "../../src/track/pieces/solve";
import { buildTable } from "../../src/track/pieces/table";
import { canonical } from "../../src/track/rescore";

export function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

it("ピースの時刻表で解き直す", () => {
  const dir = process.env.PB_DIR;
  if (!dir) return;
  const refDir = process.env.PB_REF!;
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".read.json")).sort()) {
    const name = file.replace(".read.json", "");
    if (process.env.PB_ONLY && !new RegExp(process.env.PB_ONLY).test(name)) continue;
    const refName = readdirSync(refDir).find((f) => f.startsWith(name.slice(0, 8)) && f.endsWith(".ref.json"));
    if (!refName) continue;
    const ref = JSON.parse(readFileSync(`${refDir}/${refName}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const rd = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { start: number[]; readings: SightFrame[] };
    let start: CubeState = Uint8Array.from(ref.startState ?? rd.start);
    let want = ref.moves.map((m) => m.move);
    let readings = rd.readings;
    // PB_APP=1: 本体のタイマーと同じく、ソルブの部分だけ（正解の手の間がいちばん長く空く所 = インスペクションの後から。その時の正解の状態で始める）
    if (process.env.PB_APP) {
      let k = 0;
      let gap = 0;
      for (let i = 1; i < ref.moves.length * 0.7; i++) if (ref.moves[i].start - ref.moves[i - 1].end > gap) { gap = ref.moves[i].start - ref.moves[i - 1].end; k = i; }
      if (gap < 2000) k = 0;
      for (let i = 0; i < k; i++) start = applyMove(start, want[i]);
      want = want.slice(k);
      const t0 = ref.moves[k].start - 1500;
      readings = readings.filter((r) => r.t >= t0);
    }
    if (process.env.PB_FROM) {
      const t0 = Number(process.env.PB_FROM) * 1000;
      const k = ref.moves.findIndex((m) => m.start >= t0);
      for (let i = 0; i < k; i++) start = applyMove(start, want[i]);
      want = want.slice(k);
      readings = readings.filter((r) => r.t >= t0);
    }
    const a = performance.now();
    const table = buildTable(readings, JSON.parse(process.env.PB_TABLE ?? "{}"));
    const b = performance.now();
    if (process.env.PB_DIAG) {
      // 時刻表の読みを正解の状態（その時刻の前後 1 手）と照らす
      const states = [fromCubeState(start).pos];
      let st = start;
      for (const m of want) states.push(fromCubeState((st = applyMove(st, m))).pos);
      const mv = ref.moves.slice(ref.moves.length - want.length);
      // 連なりの長さ（1・2・3〜5・6 以上）ごとの誤り
      const runLen = new Int32Array(table.piece.length);
      for (const L of table.byPiece) for (let a = 0; a < L.length; ) {
        let b = a + 1;
        while (b < L.length && !table.fresh[L[b]]) b++;
        for (let i = a; i < b; i++) runLen[L[i]] = b - a;
        a = b;
      }
      const bucket = (n: number) => (n === 1 ? 0 : n === 2 ? 1 : n <= 5 ? 2 : 3);
      const tot = [0, 0, 0, 0];
      const bad = [0, 0, 0, 0];
      const how = [0, 0, 0, 0, 0, 0];
      for (let f = 0; f < table.n; f++) {
        const k0 = mv.filter((m) => m.end <= table.t[f]).length;
        for (let j = table.first[f]; j < table.first[f + 1]; j++) {
          if (table.piece[j] >= 20) continue;
          let ok = false;
          for (let k = Math.max(0, k0 - 3); k <= Math.min(states.length - 1, k0 + 3) && !ok; k++) ok = states[k][table.piece[j]] === table.at[j];
          const b = bucket(runLen[j]);
          tot[b]++;
          how[table.kind[f] * 2]++;
          if (!ok) { bad[b]++; how[table.kind[f] * 2 + 1]++; }
        }
      }
      if (process.env.PB_DIAG === "2") {
        // フレームごと: 表の置き方と、ほかの置き方（1〜3）の誤りの数
        for (let f = 0; f < table.n; f++) {
          const k0 = mv.filter((m) => m.end <= table.t[f]).length;
          const errs = [0, 1, 2, 3].map((d) => {
            let best = 99;
            for (let k = Math.max(0, k0 - 3); k <= Math.min(states.length - 1, k0 + 3); k++) {
              let e = 0;
              if (d === 0) { for (let j = table.first[f]; j < table.first[f + 1]; j++) if (table.piece[j] < 20 && states[k][table.piece[j]] !== table.at[j]) e++; }
              else { if (table.altFirst[f * 3 + d] === table.altFirst[f * 3 + d - 1]) e = 99; for (let j = table.altFirst[f * 3 + d - 1]; j < table.altFirst[f * 3 + d]; j++) if (table.altPiece[j] < 20 && states[k][table.altPiece[j]] !== table.altAt[j]) e++; }
              best = Math.min(best, e);
            }
            return best;
          });
          out.push(`    f${f} t=${(table.t[f] / 1000).toFixed(3)} ${["確か", "続き", "不明"][table.kind[f]]} 基準 ${"URFDLB"[table.root[f]]} 読み ${table.first[f + 1] - table.first[f]} 誤り ${errs.join("/")}`);
        }
      }
      out.push(`  読みの誤り（連なり 1 / 2 / 3〜5 / 6〜）: ${tot.map((n, i) => `${bad[i]}/${n}`).join(" ・ ")}  決まった置き方 ${how[1]}/${how[0]}・続き ${how[3]}/${how[2]}・不明 ${how[5]}/${how[4]}・${JSON.stringify(table.stats)}`);
    }
    const popt = JSON.parse(process.env.PB_OPT ?? "{}");
    const counts = new Array(10).fill(0);
    let countSum = 0;
    if (process.env.PB_TRACE || process.env.PB_COUNT) {
      // 正解の状態（その時刻の前後 2 手）が仮説に残っているか。なくなったフレームを出す
      const states = [fromCubeState(start).pos];
      let st = start;
      for (const m of want) states.push(fromCubeState((st = applyMove(st, m))).pos);
      const mv = ref.moves.slice(ref.moves.length - want.length);
      let had = true;
      popt.trace = (f: number, hyps: { s: Uint8Array; cost: number; rank: number; path: number }[], movesOf: (p: number) => number[]) => {
        if (f >= table.n) return;
        if (process.env.PB_COUNT) (counts[Math.min(9, Math.floor(Math.log2(hyps.length)))]++, (countSum += hyps.length));
        // PB_AT=195-201: そのフレームの上位の仮説
        if (process.env.PB_AT) {
          const [a0, a1] = process.env.PB_AT.split("-").map(Number);
          if (f >= a0 && f <= a1) {
            out.push(`  f${f} t=${(table.t[f] / 1000).toFixed(3)} 仮説 ${hyps.length}`);
            for (const h of [...hyps].sort((x, y) => x.rank - y.rank).slice(0, Number(process.env.PB_TOP ?? 12))) out.push(`     rank ${h.rank.toFixed(2)} cost ${h.cost.toFixed(2)} ${movesOf(h.path).map((m) => MOVE_NAMES[m]).join(" ")}`);
          }
        }
        const k0 = mv.filter((m) => m.end <= table.t[f]).length;
        let hit: { k: number; cost: number; rank: number } | null = null;
        for (let k = Math.max(0, k0 - 3); k <= Math.min(states.length - 1, k0 + 3); k++) for (const h of hyps) if (states[k].every((x, i) => h.s[i] === x) && (!hit || h.cost < hit.cost)) hit = { k, cost: h.cost, rank: h.rank };
        const best = hyps.reduce((a, b) => (a.rank < b.rank ? a : b));
        if (process.env.PB_TRACE && (!!hit !== had || process.env.PB_TRACE === "2")) {
          const row: string[] = [];
          for (let j = table.first[f]; j < table.first[f + 1]; j++) row.push(`${table.piece[j]}@${table.at[j]}${table.piece[j] < 20 && states[k0][table.piece[j]] !== table.at[j] ? "!" : ""}`);
          out.push(`  ${hit ? "＋" : "－"} f${f} t=${(table.t[f] / 1000).toFixed(3)} 正解 ${k0} 手目 ${hit ? `あり（${hit.k} 手目 cost ${hit.cost.toFixed(2)} rank ${hit.rank.toFixed(2)}）` : "なし"}・仮説 ${hyps.length}・一番 rank ${best.rank.toFixed(2)} cost ${best.cost.toFixed(2)}・読み ${row.join(" ")}`);
        }
        had = !!hit;
      };
    }
    if (process.env.PB_WHY) {
      // 正解の経路だけに絞って、どのフレームでコストを払うかを出す（PB_WHY=しきい値）
      const keys = new Set<string>();
      let st = start;
      keys.add(Array.from(fromCubeState(st).pos).join());
      for (const m of want) keys.add(Array.from(fromCubeState((st = applyMove(st, m))).pos).join());
      popt.allow = (x: Uint8Array) => keys.has(Array.from(x.subarray(0, 20)).join());
      let prev = 0;
      const th = Number(process.env.PB_WHY);
      popt.trace = (f: number, hyps: { s: Uint8Array; cost: number }[]) => {
        if (!hyps.length || f >= table.n) return;
        const b = hyps.reduce((a, c) => (a.cost < c.cost ? a : c));
        if (b.cost - prev >= th) {
          const row: string[] = [];
          for (let j = table.first[f]; j < table.first[f + 1]; j++) row.push(`${table.piece[j]}@${table.at[j]}${table.piece[j] < 20 ? (b.s[table.piece[j]] !== table.at[j] ? "!" : "") : `(c${(b.s[20 + table.piece[j] - 20] + b.s[26 + table.piece[j] - 20]) & 3})`}:${table.w[j].toFixed(2)}`);
          out.push(`  f${f} t=${(table.t[f] / 1000).toFixed(3)} +${(b.cost - prev).toFixed(2)} = ${b.cost.toFixed(2)} 置き方 ${["確か", "続き", "不明"][table.kind[f]]} 基準 ${table.root[f]} 仮説 ${b.s[58]}・${row.join(" ")}`);
        }
        prev = b.cost;
      };
    }
    // PB_OLD=1: フレーム単位の探索（solve.ts）。既定は見え方ごとの探索（decode.ts。PB_DEC='{"beam":64}'）
    if (!process.env.PB_OLD) {
      const dopt = JSON.parse(process.env.PB_DEC ?? "{}");
      // PB_STEPS=1: 見え方ごとの様子
      if (process.env.PB_STEPS) dopt.onStep = (x: { back: boolean; step: number; t: number; pieces: number; depth: number; hyps: number; best: number; expanded: number; moves: number[] }) => out.push(`   ${x.back ? "←" : "→"} ${x.step} t=${(x.t / 1000).toFixed(2)} ピース ${x.pieces} 深さ ${x.depth} 仮説 ${x.hyps} 一番 ${x.best.toFixed(1)} 候補 ${x.expanded} ${x.moves.slice(-8).map((m) => MOVE_NAMES[x.back ? m : m]).join(" ")}`);
      const d = decodePieces(table, start, solvedState(), dopt);
      const gotD = canonical(d.moves.map((m) => m.move));
      const wantD = canonical(want);
      const distD = editDistance(gotD, wantD);
      out.push(`${name.padEnd(22)} ${d.reachedEnd ? `完成まで（${d.method}）` : "届かない"}・${d.moves.length} 手（正解 ${want.length}）・正解との距離 ${distD}・推定 ${d.moves.filter((m) => m.inferred).length}・コスト ${d.cost.toFixed(1)}・表 ${(b - a).toFixed(0)}ms（${table.n} 枚）・見え方 ${d.sights}・探索 ${d.ms.toFixed(0)}ms（候補 ${d.expanded}）`);
      if (process.env.PB_SHOW && distD) {
        out.push(`  出力 ${d.moves.map((m) => `${MOVE_NAMES[m.move]}@${(m.t / 1000).toFixed(2)}`).join(" ")}`);
        out.push(`  正解 ${ref.moves.slice(ref.moves.length - want.length).map((m) => `${MOVE_NAMES[m.move]}@${(m.end / 1000).toFixed(2)}`).join(" ")}`);
      }
      continue;
    }
    // PB_ONE=1: 前向きだけ
    const r = process.env.PB_ONE ? { ...solvePieces(table, start, solvedState(), popt), method: "forward", forwardMs: 0, backwardMs: 0, meetAt: Number.NaN } : solveBoth(table, start, solvedState(), popt);
    const got = canonical(r.moves.map((m) => m.move));
    const wantC = canonical(want);
    const dist = editDistance(got, wantC);
    out.push(`${name.padEnd(22)} ${r.reachedEnd ? `完成まで（${r.method}${Number.isNaN(r.meetAt) ? "" : ` ${(r.meetAt / 1000).toFixed(1)}s`}）` : "届かない"}・${r.moves.length} 手（正解 ${want.length}）・正解との距離 ${dist}・推定 ${r.moves.filter((m) => m.inferred).length}・食い違い ${r.mismatch.toFixed(1)}・表 ${(b - a).toFixed(0)}ms（${table.n} 枚・読み ${table.stats.sightings}）・探索 ${r.ms.toFixed(0)}ms（候補 ${r.expanded}）`);
    if (process.env.PB_COUNT) out.push(`  仮説の数（1・2〜3・4〜7・…）ごとのフレーム: ${counts.join(" ")}・合計 ${countSum}`);
    if (process.env.PB_SHOW && dist) {
      let i = 0;
      while (i < got.length && i < wantC.length && got[i] === wantC[i]) i++;
      let j = 0;
      while (j < got.length - i && j < wantC.length - i && got[got.length - 1 - j] === wantC[wantC.length - 1 - j]) j++;
      const nm = (xs: number[]) => xs.map((m) => MOVE_NAMES[m]).join(" ");
      out.push(`  ${i} 手目から違う: 出力 [${nm(got.slice(Math.max(0, i - 3), got.length - j + 2))}] 正解 [${nm(wantC.slice(Math.max(0, i - 3), wantC.length - j + 2))}]`);
      out.push(`  出力 ${r.moves.map((m) => `${MOVE_NAMES[m.move]}@${(m.t / 1000).toFixed(2)}`).join(" ")}`);
      out.push(`  正解 ${ref.moves.map((m) => `${MOVE_NAMES[m.move]}@${(m.end / 1000).toFixed(2)}`).join(" ")}`);
    }
  }
  console.log(out.join("\n"));
});
