// アンカー方式（src/track/anchors.ts）をアンカーごとにたどり、仮説に正解の状態（時刻の前後）があるかを出す
//   AT_READ=read.json AT_REF=ref.json AT_FROM=秒 AT_K=正解の何手目から npx vitest run -c vitest.debug.config.ts tests/debug/anchorTrace.debug.test.ts --silent=false
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, solvedState, statesEqual } from "../../src/cube/model";
import { decodeAnchors } from "../../src/track/anchors";

it("アンカー方式をたどる", () => {
  if (!process.env.AT_READ) return;
  const reads = JSON.parse(readFileSync(process.env.AT_READ, "utf8")) as { start: number[]; readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[] };
  const ref = JSON.parse(readFileSync(process.env.AT_REF!, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
  const from = Number(process.env.AT_FROM ?? 0) * 1000;
  const k0 = Number(process.env.AT_K ?? 0);
  const states: CubeState[] = [Uint8Array.from(ref.startState ?? reads.start)];
  for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
  const lines: string[] = [];
  const W = 8;
  const r = decodeAnchors(
    reads.readings.filter((x) => x.t >= from),
    states[k0],
    solvedState(),
    {
      ...JSON.parse(process.env.AT_OPT ?? "{}"),
      onAnchor: (a) => {
        const kt = ref.moves.filter((m) => m.end <= a.t1).length;
        const near = (s: CubeState) => {
          for (let k = Math.max(0, kt - W); k <= Math.min(states.length - 1, kt + W); k++) if (statesEqual(s, states[k])) return k - kt;
          return null;
        };
        const rank = a.hyps.findIndex((h) => near(h.state) !== null);
        const b = a.hyps[0];
        lines.push(
          `${(a.t0 / 1000).toFixed(3)}〜${(a.t1 / 1000).toFixed(3)} ステッカー ${a.stickers} 姿勢 ${a.orients ? a.orients.length : "-"} ${a.connected ? "つないだ" : "飛ばした"}・` +
            `一番の仮説 ${near(b.state) === null ? "×" : `○(${near(b.state)})`} コスト ${b.cost.toFixed(1)} 手 ${b.moves.length}・正解は ${rank < 0 ? "なし" : `${rank + 1} 位`}・最後の手 ${b.moves.slice(-4).map((m) => MOVE_NAMES[m]).join(" ")}`,
        );
      },
    },
  );
  console.log([...lines, `完成 ${r.reachedEnd}・手 ${r.moves.length}`].join("\n"));
}, 3600000);
