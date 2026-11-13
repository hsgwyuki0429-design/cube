// 「正解」（原画質の精密解析の手順）が、5 枚続けて同じに読めた読み（読み違いはほぼない: T-perm で 0.03〜0.07%）と食い違う区間を探す。
//   RC_DIR=dump RC_REF=bm RC_ONLY=正規表現 npx vitest run -c vitest.debug.config.ts tests/debug/refCheck.debug.test.ts --silent=false
// 読み: 直接読んだマス（4 マス以上の面）で、前後 2 枚とも同じマスに同じステッカー。正解の手順の状態（時刻の前後 RC_NEAR 手、24 姿勢）の
// どれとも 2 マス以上食い違うフレームを「正解と合わない」とし、続いたものを区間にまとめる
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";

it("正解と食い違う区間", () => {
  const dir = process.env.RC_DIR;
  if (!dir) return;
  const NEAR = Number(process.env.RC_NEAR ?? 8);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".read.json") && new RegExp(process.env.RC_ONLY ?? "_orig").test(x)).sort()) {
    const name = f.replace(".read.json", "");
    const b = name.slice(0, 8);
    const refF = readdirSync(process.env.RC_REF!).find((x) => x.startsWith(b));
    if (!refF) continue;
    const ref = JSON.parse(readFileSync(`${process.env.RC_REF}/${refF}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const rd = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { start: number[]; readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[] };
    const states: CubeState[] = [Uint8Array.from(ref.startState ?? rd.start)];
    for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
    const ids = states.map((s) => stickerIds(s));
    const maps = rd.readings.map((r) => {
      const m = new Map<number, number>();
      for (const fc of r.faces) {
        const n = fc.ids.filter((x, c) => x >= 0 && (fc.w?.[c] ?? 1) >= 0.85).length;
        if (n >= 4) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0 && (fc.w?.[c] ?? 1) >= 0.85) m.set(fc.slot * 9 + c, fc.ids[c]);
      }
      return m;
    });
    const t0 = ref.moves[0].start - 300;
    const t1 = ref.moves[ref.moves.length - 1].end + 300;
    let stableFrames = 0;
    const bad: { t: number; miss: number; n: number }[] = [];
    for (let i = 2; i + 2 < maps.length; i++) {
      const t = rd.readings[i].t;
      if (t < t0 || t > t1) continue;
      const cells = [...maps[i]].filter(([p, x]) => [-2, -1, 1, 2].every((d) => maps[i + d].get(p) === x));
      if (cells.length < 5) continue;
      stableFrames++;
      const k0 = ref.moves.filter((m) => m.end <= t).length;
      let miss = Infinity;
      for (let k = Math.max(0, k0 - NEAR); k <= Math.min(states.length - 1, k0 + NEAR); k++)
        for (let o = 0; o < 24; o++) miss = Math.min(miss, cells.filter(([p, x]) => ids[k][VIEW[o * 54 + p]] !== x).length);
      if (miss >= 2) bad.push({ t, miss, n: cells.length });
    }
    // 区間にまとめる（間 200ms まで）
    const spans: { a: number; b: number; frames: number; miss: number }[] = [];
    for (const x of bad) {
      const s = spans[spans.length - 1];
      if (s && x.t - s.b <= 200) Object.assign(s, { b: x.t, frames: s.frames + 1, miss: Math.max(s.miss, x.miss) });
      else spans.push({ a: x.t, b: x.t, frames: 1, miss: x.miss });
    }
    process.stdout.write(`${name}: 5 枚続けて同じ読み（5 枚以上）のフレーム ${stableFrames}・正解と 2 マス以上食い違う ${bad.length}（${((100 * bad.length) / Math.max(1, stableFrames)).toFixed(1)}%）・区間 ${spans.length}\n`);
    for (const s of spans) {
      const ms = ref.moves.map((m, i) => ({ m, i })).filter(({ m }) => m.end >= s.a - 600 && m.start <= s.b + 300);
      process.stdout.write(`    ${(s.a / 1000).toFixed(2)}〜${(s.b / 1000).toFixed(2)}s ${s.frames} 枚・最大 ${s.miss} マス  正解の手: ${ms.map(({ m, i }) => `${i}:${MOVE_NAMES[m.move]}@${(m.start / 1000).toFixed(2)}-${(m.end / 1000).toFixed(2)}`).join(" ")}\n`);
    }
  }
}, 3600000);
