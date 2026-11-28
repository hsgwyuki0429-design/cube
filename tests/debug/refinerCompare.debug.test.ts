// 本体の流れ（Refiner.result: 解き直し・端の時刻・stopCut）を方法ごとに並べる（精密解析 4: 既定の切り替えの判断）。
// 材料は realVideo.debug.test.ts の REAL_PIECES=1 REAL_METHODS=old,and REAL_METHODS_OUT=rows.jsonl（REAL_NAME=名前、止めた時刻は
// REAL_METHODS_STOP）の行。正解は piecesBench と同じ（truthOf: PB_TRUTH・PB_BM。T-perm 2 本の時刻は PB_BM の原画質の精密解析から）。
//   RC_ROWS=rows.jsonl PB_TRUTH=$BENCH/truth PB_BM=$BENCH/bm npx vitest run -c vitest.debug.config.ts tests/debug/refinerCompare.debug.test.ts --silent=false
//   RC_OUT=ファイル: 1 行ごとのまとめ（JSON）を足す
// 記録の状態は timer.ts の analyzeRecordingInner と同じ決め方（止め方は見え方・追跡: 手動・GAN タイマーではない）:
//   完成までつながった → 両端の時刻が確か = done、どちらかが不確か = partial（一部推定）
//   つながらない → フレームから決められた端（最初の手の回し始め・後ろ向きに追えた最後の手の回し終わり）があれば partial、なければ failed（速報値）
// 完成 = つながった かつ 始まりの状態が渡したものと同じ（piecesBench と同じ）。確定 = まとめた形で正解と対応する確定の手 / 正解の手（まとめた形。
// 届かない本は 0）。タイムの誤差 = (end − start) − 正解の (最後の手の回し終わり − 最初の手の回し始め)。止めた時刻があれば正解も
// 止めた時刻の後の手を除く（stopCut と同じ: 止めた時刻 + 250ms までに揃った所）。done の本だけ
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, applyMove, isSolved, solvedState, statesEqual } from "../../src/cube/model";
import { canonical } from "../../src/track/pieces/decode";
import { STOP_AFTER_MS } from "../../src/track/stopCut";
import { editDistance, truthOf, wrongByState, wrongSure } from "./piecesBench.debug.test";

type Row = {
  name: string;
  method: string;
  used?: string;
  solved: boolean;
  inferred: number;
  start: number | null;
  end: number | null;
  startUncertain: boolean;
  endUncertain: boolean;
  ms: number;
  piecesMs: number;
  timed: { move: number; start: number; end: number; inferred?: boolean }[];
  startState: number[] | null;
  forced: number;
  gapped: boolean;
  stopCut: { how: string; dropped: number } | null;
  stop: number[] | null;
};

it("本体の流れを方法ごとに並べる", () => {
  const file = process.env.RC_ROWS;
  if (!file) return;
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
  const bmDir = process.env.PB_BM;
  for (const r of rows) {
    const base = r.name.slice(0, 8);
    // 4970・4971 は揃った状態から（REAL_START なし）。ほかは正解の始まりの状態
    const t = truthOf(r.name, Array.from(solvedState()));
    if (!t) throw new Error(`正解がない: ${r.name}`);
    let tm = t.moves;
    if (tm.some((m) => Number.isNaN(m.start)) && bmDir) {
      const rf = readdirSync(bmDir).find((f) => f.startsWith(base));
      const ref = JSON.parse(readFileSync(`${bmDir}/${rf}`, "utf8")) as { moves: { move: number; start: number; end: number }[] };
      if (ref.moves.length === tm.length) tm = tm.map((m, i) => ({ ...m, start: ref.moves[i].start, end: ref.moves[i].end }));
    }
    // 止めた時刻の後の正解の手を除く（タイムの誤差だけに使う）
    let tEnd = tm.length;
    if (r.stop) {
      let s: CubeState = t.start;
      let last = -1;
      tm.forEach((m, i) => {
        s = applyMove(s, m.move);
        if (isSolved(s) && m.end <= r.stop![0] + STOP_AFTER_MS) last = i + 1;
      });
      if (last > 0) tEnd = last;
    }
    const truthTime = tm[tEnd - 1].end - tm[0].start;
    const want = canonical(t.moves.map((m) => m.move));
    const startDiff = !!r.startState && !statesEqual(Uint8Array.from(r.startState), t.start);
    const solved = r.solved && !startDiff;
    const ms = r.timed.map((m) => ({ move: m.move, inferred: m.inferred, t: m.start }));
    const got = canonical(ms.map((m) => m.move));
    const dist = editDistance(got, want);
    const ws = solved ? wrongSure(ms, want) : { wrong: 0, ok: 0 };
    const bs = solved ? wrongByState(ms, t.moves, t.start) : { wrong: 0, at: [] };
    // 記録の状態（timer.ts）
    let analysis: "done" | "partial" | "failed";
    if (!r.solved || !r.timed.length || r.start === null || r.end === null) {
      const begin = r.timed.length && r.start !== null && !r.startUncertain;
      const finish = r.gapped && r.end !== null && !r.endUncertain;
      analysis = begin || finish ? "partial" : "failed";
    } else analysis = !r.startUncertain && !r.endUncertain ? "done" : "partial";
    const timeErr = analysis === "done" && r.start !== null && r.end !== null ? Math.round(r.end - r.start - truthTime) : null;
    const out = {
      name: r.name,
      method: r.method,
      used: r.used ?? "",
      quality: /orig/.test(r.name) ? "orig" : (r.name.match(/_(\d+k)/)?.[1] ?? "?"),
      solved,
      startDiff,
      same: solved && dist === 0,
      dist,
      n: want.length,
      okSure: ws.ok,
      wrongSure: ws.wrong,
      wrongByState: bs.wrong,
      wrongByStateAt: bs.at,
      inferred: r.inferred,
      analysis,
      liveEdges: [...(r.startUncertain ? ["start"] : []), ...(r.endUncertain ? ["end"] : [])],
      timeErr,
      stopCut: r.stopCut,
      ms: r.ms,
      piecesMs: r.piecesMs,
      forced: r.forced,
    };
    process.stdout.write(
      `${r.name.padEnd(26)} ${r.method.padEnd(4)} ${(r.used ?? "").padEnd(14)} ${solved ? "完成" : startDiff ? "始まり違い" : "未完"} ${out.same ? "同じ" : `距離 ${dist}`} 確定 ${ws.ok}/${want.length} 間違い ${ws.wrong}/${bs.wrong} 推定 ${r.inferred} ${analysis}${out.liveEdges.length ? `(${out.liveEdges.join(",")})` : ""} 誤差 ${timeErr ?? "-"}ms ${(r.ms / 1000).toFixed(1)}秒${r.stopCut ? ` 打ち切り ${r.stopCut.how}:${r.stopCut.dropped}` : ""}\n`,
    );
    if (process.env.RC_OUT) appendFileSync(process.env.RC_OUT, `${JSON.stringify(out)}\n`);
  }
});
