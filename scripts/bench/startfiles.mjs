// Testvideo2 の始まりの状態: 原画質の動画全体の精密解析の、いちばん長い間（最初の 7 割の中）の後の状態（piecesBench の truthOf と同じ）
import { readFileSync, writeFileSync } from "node:fs";
import { applyMove, solvedState } from "../../src/cube/model.ts";
for (const n of process.argv.slice(2)) {
  const ref = JSON.parse(readFileSync(`${process.env.BENCH ?? "/home/user/bench"}/bm/${n}.ref.json`, "utf8"));
  let s = Uint8Array.from(ref.startState ?? solvedState());
  let k = 0, gap = 0;
  for (let i = 1; i < ref.moves.length * 0.7; i++) if (ref.moves[i].start - ref.moves[i - 1].end > gap) { gap = ref.moves[i].start - ref.moves[i - 1].end; k = i; }
  for (let i = 0; i < k; i++) s = applyMove(s, ref.moves[i].move);
  writeFileSync(`${process.env.BENCH ?? "/home/user/bench"}/start/${n}.json`, JSON.stringify({ startState: Array.from(s), k, scrambleEnd: ref.moves[k - 1].end, solveStart: ref.moves[k].start }));
  console.log(n, "k", k, "scramble end", ref.moves[k - 1].end.toFixed(0), "solve start", ref.moves[k].start.toFixed(0));
}
