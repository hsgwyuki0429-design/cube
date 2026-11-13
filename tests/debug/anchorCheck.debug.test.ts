// アンカー（続けて同じに読めたステッカー）が正解の状態と合うかを測る（exact.ts の anchorsOf。AC_FRAMES=2,3,4）
//   AC_DIR=dump AC_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/anchorCheck.debug.test.ts --silent=false
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { DEFAULT_EXACT, _internal } from "../../src/track/exact";

const SOLVE_START: Record<string, number> = { IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };

it("アンカーの正しさ", () => {
  const dir = process.env.AC_DIR;
  if (!dir) return;
  const cases = process.env.AC_CASES ? process.env.AC_CASES.split(",") : readdirSync(dir).filter((f) => f.endsWith(".read.json")).map((f) => f.replace(".read.json", "")).sort();
  for (const name of cases) {
    const b = name.slice(0, 8);
    const ref = JSON.parse(readFileSync(`${process.env.AC_REF}/${readdirSync(process.env.AC_REF!).find((f) => f.startsWith(b))}`, "utf8"));
    const start0 = JSON.parse(readFileSync(`${dir}/${b}_orig.obs.json`, "utf8")).start;
    const reads = JSON.parse(readFileSync(`${dir}/${name}.read.json`, "utf8"));
    const ids = [stickerIds(Uint8Array.from(ref.startState ?? start0))];
    let st: CubeState = Uint8Array.from(ref.startState ?? start0);
    for (const m of ref.moves) ids.push(stickerIds((st = applyMove(st, m.move))));
    const t0 = ref.moves[SOLVE_START[b] ?? 0].start - 1500;
    const sights = reads.readings.filter((r: { t: number }) => r.t >= t0);
    const parts: string[] = [];
    for (const m of (process.env.AC_FRAMES ?? "2,3,4").split(",").map(Number)) {
      const o = { ...DEFAULT_EXACT, anchorFrames: m };
      const frames = _internal.toFrames(sights, o);
      const anchors = _internal.anchorsOf(frames, o);
      let bad = 0;
      for (const a of anchors) {
        const t = frames[a.f0].t;
        let k = 0;
        while (k < ref.moves.length && ref.moves[k].end <= t) k++;
        let ok = false;
        for (let kk = Math.max(0, k - 8); kk <= Math.min(ids.length - 1, k + 8) && !ok; kk++)
          for (const or of a.ors) if (Array.from(a.pos).every((p, i) => ids[kk][VIEW[or * 54 + p]] === a.id[i])) ok = true;
        if (!ok) {
          bad++;
          if (process.env.AC_SHOW) {
            let best = { miss: 99, kk: -1, or: -1 };
            for (let kk = Math.max(0, k - 8); kk <= Math.min(ids.length - 1, k + 8); kk++)
              for (const or of a.ors) {
                const miss = Array.from(a.pos).filter((p, i) => ids[kk][VIEW[or * 54 + p]] !== a.id[i]).length;
                if (miss < best.miss) best = { miss, kk, or };
              }
            process.stdout.write(`  ${(t / 1000).toFixed(3)} 枚 ${a.f1 - a.f0 + 1} ステッカー ${a.n} 姿勢 ${a.ors.length} 一番近い正解 ${best.kk} 手目（いまは ${k}）食い違い ${best.miss}: ${Array.from(a.pos).map((p, i) => `${p}=${a.id[i]}${ids[best.kk][VIEW[best.or * 54 + p]] !== a.id[i] ? `(正解 ${ids[best.kk][VIEW[best.or * 54 + p]]})` : ""}`).join(" ")}\n`);
          }
        }
      }
      parts.push(`${m} 枚: アンカー ${anchors.length}・正解と合わない ${bad}`);
    }
    process.stdout.write(`${name.padEnd(20)} ${parts.join(" / ")}\n`);
  }
}, 3600000);
