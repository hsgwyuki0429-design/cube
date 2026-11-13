// 正解（新旧）を、直接読んだすべてのマス（4 マス以上の面）と照らす。フレームごとに時刻の前後 TC_NEAR 手の状態・24 姿勢で一番合うものとの
// 食い違いを数える（少ない方が読みをよく説明している）。確かな読み（5 枚続けて同じ）と合わないフレームの数も。
//   TC_DIR=dump TC_OLD=bm TC_NEW=truth npx vitest run -c vitest.debug.config.ts tests/debug/truthCompare.debug.test.ts --silent=false
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { contradictions, stableFrames } from "./buildTruth.debug.test";

type Ref = { moves: { move: number; start: number; end: number; inferred?: boolean }[]; startState?: number[]; solveStart?: number };

it("正解を読みと照らす", () => {
  const dir = process.env.TC_DIR;
  if (!dir) return;
  const NEAR = Number(process.env.TC_NEAR ?? 2);
  for (const f of readdirSync(process.env.TC_NEW!).sort()) {
    const name = f.slice(0, 8);
    const nw = JSON.parse(readFileSync(`${process.env.TC_NEW}/${f}`, "utf8")) as Ref;
    const oldAll = JSON.parse(readFileSync(`${process.env.TC_OLD}/${f}`, "utf8")) as Ref;
    const rd = JSON.parse(readFileSync(`${dir}/${name}_orig.read.json`, "utf8"));
    const t0 = nw.solveStart! - 1500;
    const start = Uint8Array.from(nw.startState!);
    const old = oldAll.moves.filter((m) => m.start >= nw.solveStart! - 1);
    const reads = rd.readings.filter((r: { t: number }) => r.t >= t0);
    const score = (moves: Ref["moves"]) => {
      const ids = [stickerIds(start)];
      let s: CubeState = start;
      for (const m of moves) ids.push(stickerIds((s = applyMove(s, m.move))));
      let n = 0;
      let bad = 0;
      for (const r of reads) {
        const cells: [number, number][] = [];
        for (const fc of r.faces) {
          const k = fc.ids.filter((x: number, c: number) => x >= 0 && (fc.w?.[c] ?? 1) >= 0.85).length;
          if (k >= 4) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0 && (fc.w?.[c] ?? 1) >= 0.85) cells.push([fc.slot * 9 + c, fc.ids[c]]);
        }
        if (!cells.length) continue;
        const k0 = moves.filter((m) => m.end <= r.t).length;
        let best = Infinity;
        for (let k = Math.max(0, k0 - NEAR); k <= Math.min(ids.length - 1, k0 + NEAR); k++)
          for (let o = 0; o < 24; o++) best = Math.min(best, cells.filter(([p, x]) => ids[k][VIEW[o * 54 + p]] !== x).length);
        n += cells.length;
        bad += best;
      }
      return { n, bad, stable: contradictions(start, moves, stableFrames(reads)).length };
    };
    const a = score(old);
    const b = score(nw.moves);
    process.stdout.write(`${name}: 直接読んだマス ${a.n}・食い違い これまで ${a.bad}（${((100 * a.bad) / a.n).toFixed(2)}%）→ 新しい ${b.bad}（${((100 * b.bad) / b.n).toFixed(2)}%）・確かな読みと合わないフレーム ${a.stable} → ${b.stable}・手数 ${old.length} → ${nw.moves.length}（推定 ${nw.moves.filter((m) => m.inferred).length}）\n`);
  }
}, 3600000);
