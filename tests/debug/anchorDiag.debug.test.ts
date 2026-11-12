// アンカー（src/track/anchors.ts）が正解の状態と合っているかを調べる: アンカーの時刻の前後の正解の状態のどれかと、
// どれかの姿勢で、見えたステッカーがすべて合うか
//   AD_READ=read.json AD_REF=ref.json AD_FROM=秒 npx vitest run -c vitest.debug.config.ts tests/debug/anchorDiag.debug.test.ts --silent=false
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { DEFAULT_ANCHORS, _internal } from "../../src/track/anchors";

it("アンカーの正しさ", () => {
  if (!process.env.AD_READ) return;
  const reads = JSON.parse(readFileSync(process.env.AD_READ, "utf8")) as { start: number[]; readings: { t: number; faces: { slot: number; ids: number[] }[] }[] };
  const ref = JSON.parse(readFileSync(process.env.AD_REF!, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
  const from = Number(process.env.AD_FROM ?? 0) * 1000;
  const frames = _internal.toFrames(reads.readings.filter((r) => r.t >= from));
  const anchors = process.env.AD_SINGLE
    ? frames.flatMap((f, i) => {
        const pos: number[] = [];
        const id: number[] = [];
        f.pos.forEach((p, k) => {
          if (f.id[k] % 9 !== 4) (pos.push(p), id.push(f.id[k]));
        });
        return pos.length >= Number(process.env.AD_MIN ?? DEFAULT_ANCHORS.minIds) ? [{ first: i, last: i, t0: f.t, t1: f.t, pos, id, orients: f.centers }] : [];
      })
    : _internal.anchorsOf(frames, Number(process.env.AD_MIN ?? DEFAULT_ANCHORS.minIds));
  const states: CubeState[] = [Uint8Array.from(ref.startState ?? reads.start)];
  for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
  const ids = states.map((s) => stickerIds(s));
  const W = Number(process.env.AD_W ?? 4);
  let good = 0;
  let bad = 0;
  const lines: string[] = [];
  for (const a of anchors) {
    const k0 = ref.moves.filter((m) => m.end <= a.t1).length;
    let best = Infinity;
    for (let k = Math.max(0, k0 - W); k <= Math.min(states.length - 1, k0 + W); k++)
      for (let o = 0; o < 24; o++) {
        if (a.orients && !a.orients.includes(o)) continue;
        let n = 0;
        for (let i = 0; i < a.pos.length; i++) if (ids[k][VIEW[o * 54 + a.pos[i]]] !== a.id[i]) n++;
        best = Math.min(best, n);
      }
    if (best === 0) good++;
    else {
      bad++;
      if (lines.length < 15) lines.push(`  ${(a.t0 / 1000).toFixed(3)}〜${(a.t1 / 1000).toFixed(3)} フレーム ${a.last - a.first + 1}・ステッカー ${a.pos.length}・センター ${a.orients ? a.orients.length : "なし"}・食い違い ${best}`);
    }
  }
  console.log([`フレーム ${frames.length}・アンカー ${anchors.length}: 正解と合う ${good}・合わない ${bad}`, ...lines].join("\n"));
});
