// 精密解析の終わりを止めた時刻で打ち切る前と後を、正解と比べる（src/track/stopCut.ts）。realVideo.debug.test.ts の REAL_STOP・REAL_STOP_OUT で
// 書き出した行（同じ読みで、打ち切らない結果と打ち切った結果）を読む。正解は piecesBench と同じ（PB_TRUTH・PB_BM）。打ち切った結果は、
// 正解も同じ止めた時刻で打ち切って比べる（正解の途中の揃いで切れるときだけ。切れなければ正解のまま）
//   SC_ROWS=rows.jsonl PB_TRUTH=truth PB_BM=bm npx vitest run -c vitest.debug.config.ts tests/debug/stopCompare.debug.test.ts --silent=false
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, applyMoves, invertMoves, solvedState, statesEqual } from "../../src/cube/model";
import { canonical } from "../../src/track/pieces/decode";
import { stopCut } from "../../src/track/stopCut";
import { editDistance, truthOf, wrongByState, wrongSure } from "./piecesBench.debug.test";

type Side = { solved: boolean; moves: string; inferred: number; start: number | null; end: number | null; endUncertain: boolean; startUncertain: boolean; startState: number[] | null; stopCut: { how: string; dropped: number } | null };
type Row = { name: string; stop: string; before: Side; after: Side; ms: number };

const parse = (s: string) => (s ? s.split(" ").map((x) => ({ move: MOVE_NAMES.indexOf(x.replace("?", "")), inferred: x.endsWith("?") })) : []);

it("止めた時刻で打ち切る前と後", () => {
  const file = process.env.SC_ROWS;
  if (!file) return;
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
  const out: string[] = [];
  const sum = { before: { solved: 0, same: 0, wrong: 0, byState: 0, inferred: 0, sure: 0 }, after: { solved: 0, same: 0, wrong: 0, byState: 0, inferred: 0, sure: 0 } };
  for (const r of rows) {
    const [a, b] = r.stop.split(",").map((x) => Number(x) * 1000);
    const cols: string[] = [];
    for (const side of ["before", "after"] as const) {
      const x = r[side];
      const ms = parse(x.moves);
      // 始まりの状態: 正解の始まり（後ろ向きだけの答えは自分の始まり）
      const truth = truthOf(r.name, x.startState ?? Array.from(applyMoves(solvedState(), invertMoves(ms.map((m) => m.move)))));
      if (!truth) throw new Error(`${r.name}: 正解がない`);
      let tm = truth.moves;
      if (side === "after" && x.stopCut && tm.every((m) => Number.isFinite(m.end))) {
        const c = stopCut(truth.start, tm, a, (i) => ({ start: tm[i].start, end: tm[i].end }));
        if (c) tm = tm.slice(0, c.keep);
      }
      const want = canonical(tm.map((m) => m.move));
      const solved = x.solved && !(x.startState && !statesEqual(Uint8Array.from(x.startState), truth.start));
      const dist = editDistance(canonical(ms.map((m) => m.move)), want);
      const ws = solved ? wrongSure(ms, want) : { wrong: 0 };
      const bs = solved ? wrongByState(ms, tm, truth.start) : { wrong: 0 };
      const s = sum[side];
      s.solved += solved ? 1 : 0;
      s.same += solved && dist === 0 ? 1 : 0;
      s.wrong += ws.wrong;
      s.byState += bs.wrong;
      s.inferred += x.inferred;
      s.sure += solved && !x.startUncertain && !x.endUncertain ? 1 : 0;
      cols.push(`${solved ? "○" : "×"} ${solved ? (dist ? `×(${dist})` : "○") : "-"} ${ws.wrong}/${bs.wrong} 推定 ${x.inferred} 終了 ${x.end === null ? "-" : (x.end / 1000).toFixed(3)}${x.endUncertain ? "?" : ""}${x.stopCut ? ` ${x.stopCut.how}:${x.stopCut.dropped}` : ""}${side === "after" && tm !== truth.moves ? `（正解も ${truth.moves.length - tm.length} 手外す）` : ""}`);
    }
    out.push(`| ${r.name} | ${r.stop} | ${cols.join(" | ")} |`);
    void b;
  }
  out.push(`前: ${JSON.stringify(sum.before)}`);
  out.push(`後: ${JSON.stringify(sum.after)}`);
  console.log(out.join("\n"));
});
