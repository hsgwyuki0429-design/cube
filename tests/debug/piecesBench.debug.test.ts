// ピースの時刻表による解き直し（src/track/pieces）を、書き出した読み（realVideo.debug.test.ts の REAL_RREADINGS）で測る。
//   PB_DIR=dump PB_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false
// 正解は PB_REF の <名前>.ref.json（精密解析の結果）か、<動画>.start.json（ソルブの部分だけの正解: { start, moves }）。
// 手順はまとめた形（rescore.ts の canonical: 同じ面をまとめ、反対の面の順番をそろえる）で比べる。
//   PB_ONLY=正規表現・PB_DEC='{"beam":64}'（decode.ts）・PB_TABLE='{"touch":0.4}'（table.ts）・PB_SHOW=1（違うときに手順を並べる）・
//   PB_APP=1（動画全体の読みから、ソルブの部分だけ: 正解の手の間がいちばん長く空く所から、その時の正解の状態で始める）・
//   PB_FROM=秒（そこから）・PB_STEPS=1（見え方ごとの様子）・PB_READS=1（正解に頼らない物差し: 直接読んだマスとの食い違い）・
//   PB_OLD=フォルダ（同じ名前の .ref.json = 同じ読みのこれまでの精密解析の結果。正解との距離を並べる）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, solvedState } from "../../src/cube/model";
import { decodePieces } from "../../src/track/pieces/decode";
import type { SightFrame } from "../../src/track/pieces/frame";
import { buildTable } from "../../src/track/pieces/table";
import { canonical } from "../../src/track/rescore";
import { readingMismatch } from "./buildTruth.debug.test";

export function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

type RefMove = { move: number; start: number; end: number; inferred?: boolean };

it("ピースの時刻表で解き直す", () => {
  const dir = process.env.PB_DIR;
  if (!dir) return;
  const refDir = process.env.PB_REF!;
  const out: string[] = [];
  const total = { n: 0, same: 0, solved: 0, ms: 0, oldSame: 0, oldSolved: 0 };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".read.json")).sort()) {
    const name = file.replace(".read.json", "");
    if (process.env.PB_ONLY && !new RegExp(process.env.PB_ONLY).test(name)) continue;
    const b = name.slice(0, 8);
    const rd = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { start: number[]; readings: SightFrame[] };
    let start: CubeState;
    let moves: RefMove[];
    // PB_SOLVE=1: ソルブの部分だけの正解（<動画>.start.json）を先に
    if (existsSync(`${refDir}/${name}.ref.json`) && !(process.env.PB_SOLVE && existsSync(`${refDir}/${b}.start.json`))) {
      const ref = JSON.parse(readFileSync(`${refDir}/${name}.ref.json`, "utf8")) as { moves: RefMove[]; startState?: number[] };
      start = Uint8Array.from(ref.startState ?? rd.start);
      moves = ref.moves;
    } else if (existsSync(`${refDir}/${b}.start.json`)) {
      const ref = JSON.parse(readFileSync(`${refDir}/${b}.start.json`, "utf8")) as { start: number[]; moves: RefMove[] };
      start = Uint8Array.from(ref.start);
      moves = ref.moves;
    } else continue;
    let readings = rd.readings;
    const skip = (k: number, t0: number) => {
      for (let i = 0; i < k; i++) start = applyMove(start, moves[i].move);
      moves = moves.slice(k);
      readings = readings.filter((r) => r.t >= t0);
    };
    if (process.env.PB_APP) {
      let k = 0;
      let gap = 0;
      for (let i = 1; i < moves.length * 0.7; i++)
        if (moves[i].start - moves[i - 1].end > gap) {
          gap = moves[i].start - moves[i - 1].end;
          k = i;
        }
      if (gap >= 2000) skip(k, moves[k].start - 1500);
    }
    if (process.env.PB_FROM) {
      const t0 = Number(process.env.PB_FROM) * 1000;
      skip(Math.max(0, moves.findIndex((m) => m.start >= t0)), t0);
    }
    const want = canonical(moves.map((m) => m.move));
    const a = performance.now();
    const table = buildTable(readings, JSON.parse(process.env.PB_TABLE ?? "{}"));
    const tableMs = performance.now() - a;
    const dopt = JSON.parse(process.env.PB_DEC ?? "{}");
    if (process.env.PB_STEPS)
      dopt.onStep = (x: { back: boolean; step: number; t: number; pieces: number; depth: number; hyps: number; best: number; expanded: number; moves: number[] }) =>
        out.push(`   ${x.back ? "←" : "→"} ${x.step} t=${(x.t / 1000).toFixed(2)} ピース ${x.pieces} 深さ ${x.depth} 仮説 ${x.hyps} 一番 ${x.best.toFixed(1)} 候補 ${x.expanded} ${x.moves.slice(-8).map((m) => MOVE_NAMES[m]).join(" ")}`);
    const d = decodePieces(table, start, solvedState(), dopt);
    const dist = editDistance(canonical(d.moves.map((m) => m.move)), want);
    total.n++;
    total.ms += tableMs + d.ms;
    if (d.reachedEnd) total.solved++;
    if (d.reachedEnd && dist === 0) total.same++;
    let old = "";
    if (process.env.PB_OLD && existsSync(`${process.env.PB_OLD}/${name}.ref.json`)) {
      const o = JSON.parse(readFileSync(`${process.env.PB_OLD}/${name}.ref.json`, "utf8")) as { moves: RefMove[]; solved: boolean; method?: string };
      const od = editDistance(canonical(o.moves.map((m) => m.move)), want);
      if (o.solved) total.oldSolved++;
      if (o.solved && od === 0) total.oldSame++;
      old = `・これまで: ${o.solved ? "完成まで" : "届かない"}（${o.method}）距離 ${od} 推定 ${o.moves.filter((m) => m.inferred).length}`;
    }
    out.push(
      `${name.padEnd(16)} ${d.reachedEnd ? `完成まで（${d.method}）` : "届かない"}・${d.moves.length} 手（正解 ${moves.length}）・正解との距離 ${dist}・推定 ${d.moves.filter((m) => m.inferred).length}・表 ${tableMs.toFixed(0)}ms（${table.n}/${readings.length} 枚）・見え方 ${d.sights}・探索 ${d.ms.toFixed(0)}ms（候補 ${d.expanded}）${old}`,
    );
    if (process.env.PB_READS) {
      const mine = readingMismatch(start, d.moves.map((m) => ({ move: m.move, end: m.t })), readings as never);
      const theirs = readingMismatch(start, moves, readings as never);
      out.push(`  読みとの食い違い: 出力 ${((100 * mine.bad) / mine.n).toFixed(2)}%（${mine.bad}/${mine.n}）・正解 ${((100 * theirs.bad) / theirs.n).toFixed(2)}%`);
    }
    if (process.env.PB_SHOW && (dist || process.env.PB_SHOW === "2")) {
      out.push(`  出力 ${d.moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}@${(m.t / 1000).toFixed(2)}`).join(" ")}`);
      out.push(`  正解 ${moves.map((m) => `${MOVE_NAMES[m.move]}@${(m.end / 1000).toFixed(2)}`).join(" ")}`);
    }
  }
  out.push(`計 ${total.n} 本: 完成まで ${total.solved}・正解と同じ ${total.same}・表と探索 平均 ${(total.ms / Math.max(1, total.n)).toFixed(0)}ms${process.env.PB_OLD ? `（これまで: 完成まで ${total.oldSolved}・正解と同じ ${total.oldSame}）` : ""}`);
  console.log(out.join("\n"));
});
