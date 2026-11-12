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
  type Agg = { direct: number; directBad: number; carried: number; carriedBad: number; frames: number; badFrames: number; still: number; stillBad: number; stable: number; stableBad: number; stillFrames: number; stillBadFrames: number; faceBad: number };
  const agg = new Map<string, Agg>();
  const out0: string[] = [];
  const kinds = new Map<string, number>();
  const sizes = new Map<string, number>();
  const sizeTot = new Map<string, number>();
  let exK = 0;
  let exC = 0;
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
    const g = agg.get(cond) ?? { direct: 0, directBad: 0, carried: 0, carriedBad: 0, frames: 0, badFrames: 0, still: 0, stillBad: 0, stable: 0, stableBad: 0, stillFrames: 0, stillBadFrames: 0, faceBad: 0 };
    // 止まっている: どの正解の手の回している間（前後 150ms の余裕つき）にも入らない
    const fullMoves = ref.moves as { move: number; start?: number; end: number }[];
    // MR_APP=1: ソルブの間だけ（正解の手の番号でソルブの始まり。decodeBench と同じ）
    const SOLVE_START: Record<string, number> = { IMG_4970: 0, IMG_4971: 0, IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 29 };
    const tFrom = process.env.MR_APP ? (fullMovesStart(ref.moves[SOLVE_START[b] ?? 0]) ?? 0) - 300 : -Infinity;
    const tTo = process.env.MR_APP ? ref.moves[ref.moves.length - 1].end + 300 : Infinity;
    // 5 フレーム続けて同じマスに同じステッカーが読めたか（前後 2 枚）。回している途中の層は動くので、5 枚同じにはならない
    const keyOf = (r: { faces: { slot: number; ids: number[] }[] }) => {
      const m = new Map<number, number>();
      for (const fc of r.faces) for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0) m.set(fc.slot * 9 + c, fc.ids[c]);
      return m;
    };
    const maps = rd.readings.map(keyOf);
    const stable = (i: number, pos: number, id: number) => {
      for (let d = -2; d <= 2; d++) if (maps[i + d]?.get(pos) !== id) return false;
      return true;
    };
    for (let ri = 0; ri < rd.readings.length; ri++) {
      const r = rd.readings[ri];
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
      // 食い違いのある面を種類に分ける: 面の読みを 90°・180°・270° 回すと合う / 別のスロットの面とみなすと合う / それ以外
      for (const fc of r.faces) {
        const cs = cells.filter((x) => Math.floor(x.pos / 9) === fc.slot);
        const wrongCs = cs.filter((x) => idsOf[best.k][VIEW[best.o * 54 + x.pos]] !== x.id);
        {
          const sz = cs.length <= 3 ? "読めたマス 1〜3 の面" : cs.length <= 6 ? "4〜6 の面" : "7〜9 の面";
          sizeTot.set(`${cond}|${sz}`, (sizeTot.get(`${cond}|${sz}`) ?? 0) + cs.length);
        }
        if (!wrongCs.length) continue;
        const rotCell = (c: number, q: number) => {
          let r0 = Math.floor(c / 3), c0 = c % 3;
          for (let i = 0; i < q; i++) [r0, c0] = [c0, 2 - r0];
          return r0 * 3 + c0;
        };
        const fits = (map: (x: { pos: number; id: number }) => number) => cs.filter((x) => idsOf[best.k][VIEW[best.o * 54 + map(x)]] === x.id).length;
        let kind = "その他";
        let bestFit = cs.length - wrongCs.length;
        for (let q = 1; q < 4; q++) {
          const f = fits((x) => fc.slot * 9 + rotCell(x.pos % 9, q));
          if (f > bestFit && f >= cs.length - 1) { bestFit = f; kind = `面が${q * 90}°回っている`; }
        }
        for (let sl = 0; sl < 6; sl++) {
          if (sl === fc.slot) continue;
          for (let q = 0; q < 4; q++) {
            const f = fits((x) => sl * 9 + rotCell(x.pos % 9, q));
            if (f > bestFit && f >= cs.length - 1) { bestFit = f; kind = "別の面の場所"; }
          }
        }
        if (kind === "その他" && wrongCs.length <= 3) {
          const rows = new Set(wrongCs.map((x) => Math.floor((x.pos % 9) / 3)));
          const cols = new Set(wrongCs.map((x) => x.pos % 3));
          if (rows.size === 1 || cols.size === 1) kind = "1 列だけ";
          else if (wrongCs.length === 1) kind = "1 マスだけ";
        }
        kinds.set(`${cond}|${kind}`, (kinds.get(`${cond}|${kind}`) ?? 0) + wrongCs.length);
        const sz = cs.length <= 3 ? "読めたマス 1〜3 の面" : cs.length <= 6 ? "4〜6 の面" : "7〜9 の面";
        sizes.set(`${cond}|${sz}`, (sizes.get(`${cond}|${sz}`) ?? 0) + wrongCs.length);
        // MR_EXK=別の面の場所: その種類の例（MR_EX の動画）
        if (process.env.MR_EXK === kind && name === process.env.MR_EX && exK++ < 20) {
          const others = r.faces.map((x) => `${"URFDLB"[x.slot]}`).join("");
          out0.push(`  ${(r.t / 1000).toFixed(3)}s ${"URFDLB"[fc.slot]} の面（見えた面 ${others}）: 読み ${cs.map((x) => `${x.pos % 9}:${x.id}`).join(" ")} → 正解では ${cs.map((x) => idsOf[best.k].indexOf(x.id)).map((f) => `${"URFDLB"[Math.floor(f / 9)]}${f % 9}`).join(" ")} にあるステッカー`);
        }
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
        if (stable(ri, x.pos, x.id)) {
          g.stable++;
          if (wrong) g.stableBad++;
          // MR_COLOR=動画: 5 枚続けて同じで、正解と色まで違う読みの例（画像で確かめるため）
          const want = idsOf[best.k][VIEW[best.o * 54 + x.pos]];
          if (wrong && process.env.MR_COLOR === name && Math.floor(want / 9) !== Math.floor(x.id / 9) && exC++ < 15)
            out0.push(`  色違い ${(r.t / 1000).toFixed(3)}s ${"URFDLB"[Math.floor(x.pos / 9)]}${x.pos % 9}（読めたマス ${cells.filter((y) => Math.floor(y.pos / 9) === Math.floor(x.pos / 9)).length}）: 読み ${"白赤緑黄橙青"[Math.floor(x.id / 9)]}(${x.id}) 正解 ${"白赤緑黄橙青"[Math.floor(want / 9)]}(${want})・姿勢 ${best.o}・手 ${best.k}`);
        }
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
        `5 枚続けて同じ読み ${pct(g.stableBad, g.stable)}（${pct(g.stable, g.direct + g.carried)} のマス）・誤りのあるフレーム ${pct(g.badFrames, g.frames)}・止まっている間 ${pct(g.stillBad, g.still)}（フレーム ${pct(g.stillBadFrames, g.stillFrames)}・${g.stillFrames} 枚）・面ごと食い違い ${pct(g.faceBad, g.directBad + g.carriedBad)}`,
    );
  }
  for (const c of ["orig", "5000k_60", "2500k_60", "1000k_60"]) {
    const ks = [...kinds].filter(([k]) => k.startsWith(`${c}|`));
    const tot = ks.reduce((a, [, v]) => a + v, 0);
    if (tot) out.push(`${c.padEnd(9)} 食い違いの内訳: ${ks.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.split("|")[1]} ${pct(v, tot)}`).join("・")}`);
  }
  for (const c of ["orig", "2500k_60", "1000k_60"])
    out.push(`${c.padEnd(9)} 面の大きさ別の誤り: ${["読めたマス 1〜3 の面", "4〜6 の面", "7〜9 の面"].map((z) => `${z} ${pct(sizes.get(`${c}|${z}`) ?? 0, sizeTot.get(`${c}|${z}`) ?? 0)}（マスの ${pct(sizeTot.get(`${c}|${z}`) ?? 0, [...sizeTot].filter(([k]) => k.startsWith(`${c}|`)).reduce((a, [, v]) => a + v, 0))}）`).join("・")}`);
  console.log([...out0, ...out].join("\n"));
}, 3600000);
