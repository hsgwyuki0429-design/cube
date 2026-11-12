// ステッカーの読み違いの割合: 精密解析が処理したフレームで読めたステッカー（ID）を、正解（原画質の精密解析の手順）の状態と照らす。
// 正解の手の時刻は粗いので、フレームの時刻の前後 MR_NEAR（既定 3）手の正解の状態のうち一番合うもの（24 通りの姿勢）と比べ、
// 食い違ったマスを読み違いとみなす（回している途中のフレームの、前後の状態が混ざった読みも、どちらかの状態に合えば正しいとする）。
//   MR_DIR=dump MR_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/misread.debug.test.ts --silent=false
// 読みは realVideo.debug.test.ts の REAL_RREADINGS（w: 読みの確からしさ。0.85 以上はマーカーを直接読んだマス、それ未満は前のフレームから引き継いだ ID など）
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";

const fullMovesStart = (m: { start?: number; end: number } | undefined) => (m ? (m.start ?? m.end) : undefined);

it("ステッカーの読み違いの割合", () => {
  const dir = process.env.MR_DIR;
  if (!dir) return;
  const refDir = process.env.MR_REF!;
  const NEAR = Number(process.env.MR_NEAR ?? 3);
  let exN = 0;
  type Agg = { direct: number; directBad: number; carried: number; carriedBad: number; frames: number; badFrames: number; still: number; stillBad: number; stillFrames: number; stillBadFrames: number; faceBad: number };
  const agg = new Map<string, Agg>();
  const out0: string[] = [];
  const prevStill = new Map<string, number>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".read.json"))) {
    const name = f.replace(".read.json", "");
    const b = name.slice(0, 8);
    const refF = readdirSync(refDir).find((x) => x === `${b}.MOV.ref.json` || x === `${b}.mov.ref.json`);
    if (!refF) continue;
    const ref = JSON.parse(readFileSync(`${refDir}/${refF}`, "utf8")) as { moves: { move: number; end: number }[]; startState?: number[] };
    const rd = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { start: number[]; readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[] };
    const states: CubeState[] = [Uint8Array.from(ref.startState ?? rd.start)];
    for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
    const idsOf = states.map((s) => stickerIds(s));
    const cond = name.replace(/^IMG_\d+_/, "");
    const g = agg.get(cond) ?? { direct: 0, directBad: 0, carried: 0, carriedBad: 0, frames: 0, badFrames: 0, still: 0, stillBad: 0, stillFrames: 0, stillBadFrames: 0, faceBad: 0 };
    // 止まっている: どの正解の手の回している間（前後 150ms の余裕つき）にも入らない
    const fullMoves = ref.moves as { move: number; start?: number; end: number }[];
    // MR_APP=1: ソルブの間だけ（正解の手の番号でソルブの始まり。decodeBench と同じ）
    const SOLVE_START: Record<string, number> = { IMG_4970: 0, IMG_4971: 0, IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 29 };
    const tFrom = process.env.MR_APP ? (fullMovesStart(ref.moves[SOLVE_START[b] ?? 0]) ?? 0) - 300 : -Infinity;
    const tTo = process.env.MR_APP ? ref.moves[ref.moves.length - 1].end + 300 : Infinity;
    for (const r of rd.readings) {
      if (r.t < tFrom || r.t > tTo) continue;
      const cells: { pos: number; id: number; w: number }[] = [];
      for (const fc of r.faces) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0) cells.push({ pos: fc.slot * 9 + c, id: fc.ids[c], w: fc.w?.[c] ?? 1 });
      if (!cells.length) continue;
      const k0 = ref.moves.filter((m) => m.end <= r.t).length;
      let best = { bad: Infinity, k: 0, o: 0 };
      for (let k = Math.max(0, k0 - NEAR); k <= Math.min(states.length - 1, k0 + NEAR); k++)
        for (let o = 0; o < 24; o++) {
          let bad = 0;
          for (const x of cells) if (idsOf[k][VIEW[o * 54 + x.pos]] !== x.id) bad++;
          if (bad < best.bad) best = { bad, k, o };
        }
      const still = !fullMoves.some((m) => r.t >= (m.start ?? m.end) - 150 && r.t <= m.end + 150);
      // 1 つの面の読めたマスが全部食い違う（面ごと別のスロットに割り当てた）
      for (const fc of r.faces) {
        const cs = cells.filter((x) => Math.floor(x.pos / 9) === fc.slot);
        if (cs.length >= 3 && cs.every((x) => idsOf[best.k][VIEW[best.o * 54 + x.pos]] !== x.id)) g.faceBad += cs.length;
      }
      if (still && best.bad && process.env.MR_EX && name === process.env.MR_EX && exN++ < 25) {
        const bad = cells.filter((x) => idsOf[best.k][VIEW[best.o * 54 + x.pos]] !== x.id).map((x) => {
          const fl = VIEW[best.o * 54 + x.pos];
          const where = idsOf[best.k].indexOf(x.id);
          return `${"URFDLB"[Math.floor(x.pos / 9)]}${x.pos % 9} 読み ${x.id} 正解 ${idsOf[best.k][fl]}（読んだ ID は今 facelet ${where}・${x.w.toFixed(2)}）`;
        });
        out0.push(`  ${(r.t / 1000).toFixed(3)}s 手 ${best.k}（時刻から ${k0}）読めた ${cells.length}・誤り ${best.bad}: ${bad.join(" / ")}`);
      }
      if (still) {
        g.stillFrames++;
        if (best.bad) g.stillBadFrames++;
      }
      for (const x of cells) {
        const wrong = idsOf[best.k][VIEW[best.o * 54 + x.pos]] !== x.id;
        if (still) {
          g.still++;
          if (wrong) g.stillBad++;
        }
        if (x.w >= 0.85) {
          g.direct++;
          if (wrong) g.directBad++;
        } else {
          g.carried++;
          if (wrong) g.carriedBad++;
        }
      }
      g.frames++;
      if (best.bad) g.badFrames++;
    }
    agg.set(cond, g);
    if (process.env.MR_PER) out0.push(`${name.padEnd(20)} 止まっている間の誤り ${g.stillBad - (prevStill.get(cond) ?? 0)}`);
    prevStill.set(cond, g.stillBad);
  }
  const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;
  const out: string[] = [];
  for (const c of ["orig", "5000k_60", "2500k_60", "2500k_30", "1500k_60", "1000k_60"]) {
    const g = agg.get(c);
    if (!g) continue;
    out.push(
      `${c.padEnd(9)} 読めたマス ${g.direct + g.carried}・誤り ${pct(g.directBad + g.carriedBad, g.direct + g.carried)}（直接読んだ ${pct(g.directBad, g.direct)}・引き継いだ ID ${pct(g.carriedBad, g.carried)}）・` +
        `誤りのあるフレーム ${pct(g.badFrames, g.frames)}・止まっている間 ${pct(g.stillBad, g.still)}（フレーム ${pct(g.stillBadFrames, g.stillFrames)}・${g.stillFrames} 枚）・面ごと食い違い ${pct(g.faceBad, g.directBad + g.carriedBad)}`,
    );
  }
  console.log([...out0, ...out].join("\n"));
}, 3600000);
