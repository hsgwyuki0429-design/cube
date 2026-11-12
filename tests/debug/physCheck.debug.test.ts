// キューブの状態によらない決まり（物理）で、1 フレームの読みの誤りをどれだけ見つけられるか。正解（原画質の精密解析・T-perm）と照らす。
//   PC_DIR=dump PC_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/physCheck.debug.test.ts --silent=false
//   PC_ONLY=正規表現（動画名）・PC_EX=動画名（見逃した誤りの例）
// 決まり:
//   型: マスの位置（角・辺・真ん中）と、ステッカーの種類が同じ
//   重複: 同じステッカーは 1 か所だけ
//   センター: 読めたセンターの組がありえる姿勢になる
//   境目: 隣り合う 2 面の境目で接するマスは同じピースで、ピースの中の並び（コーナーの向き）も合う
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { PARTNERS, stickerIds } from "../../src/cube/stickers";

const NEAR = Number(process.env.PC_NEAR ?? 3);
const SOLVE_START: Record<string, number> = { IMG_4970: 0, IMG_4971: 0, IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };
const typeOf = (f: number) => PARTNERS[f].length; // 0 センター・1 辺・2 角

// カメラのマス p と同じピースに乗るほかのマス（カメラの座標で）と、PARTNERS の並びでの番号
const MATES: { q: number; j: number }[][] = Array.from({ length: 54 }, (_, p) => PARTNERS[p].map((q, j) => ({ q, j })));

export interface Cell {
  pos: number; // slot * 9 + cell
  id: number;
  w: number;
}

// 決まりに反する読みの番号と、反した決まり
export function physFlags(cells: Cell[]): Map<number, string> {
  const flags = new Map<number, string>();
  const at = new Map<number, number>();
  cells.forEach((x, i) => at.set(x.pos, i));
  // 型
  cells.forEach((x, i) => {
    if (typeOf(x.pos % 9 === 4 ? 4 : x.pos) !== typeOf(x.id)) flags.set(i, "型");
  });
  // 重複
  const byId = new Map<number, number[]>();
  cells.forEach((x, i) => byId.set(x.id, [...(byId.get(x.id) ?? []), i]));
  for (const is of byId.values()) if (is.length > 1) for (const i of is) if (!flags.has(i)) flags.set(i, "重複");
  // センター
  const centers = cells.map((x, i) => ({ x, i })).filter(({ x }) => x.pos % 9 === 4 && x.id % 9 === 4);
  if (centers.length >= 2) {
    let ok = false;
    for (let o = 0; o < 24 && !ok; o++) ok = centers.every(({ x }) => VIEW[o * 54 + x.pos] === x.id);
    if (!ok) for (const { i } of centers) if (!flags.has(i)) flags.set(i, "センター");
  }
  // 境目
  cells.forEach((x, i) => {
    if (flags.has(i) || typeOf(x.pos) === 0) return;
    for (const { q, j } of MATES[x.pos]) {
      const k = at.get(q);
      if (k === undefined || flags.has(k)) continue;
      const y = cells[k];
      if (PARTNERS[x.id]?.[j] !== y.id) {
        flags.set(i, "境目");
        flags.set(k, "境目");
      }
    }
  });
  return flags;
}

it("物理の決まりで誤読を見つける", () => {
  const dir = process.env.PC_DIR;
  if (!dir) return;
  const refDir = process.env.PC_REF!;
  const files = readdirSync(dir).filter((f) => f.endsWith(".read.json") && (!process.env.PC_ONLY || new RegExp(process.env.PC_ONLY).test(f))).sort();
  let exN = 0;
  for (const f of files) {
    const name = f.replace(".read.json", "");
    const b = name.slice(0, 8);
    const refF = readdirSync(refDir).find((x) => x.startsWith(b));
    if (!refF) continue;
    const ref = JSON.parse(readFileSync(`${refDir}/${refF}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const rd = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { start: number[]; readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[] };
    const states: CubeState[] = [Uint8Array.from(ref.startState ?? rd.start)];
    for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
    const ids = states.map((s) => stickerIds(s));
    const t0 = ref.moves[SOLVE_START[b] ?? 0].start - 300;
    const t1 = ref.moves[ref.moves.length - 1].end + 300;
    // 種類（直接・引き継ぎ × 面の大きさ）ごとに: 読み・誤り・誤りのうち見つけた・正しいのに捨てた
    const agg = new Map<string, { n: number; bad: number; caught: number; lost: number }>();
    const by = new Map<string, number>(); // 見つけた決まり
    const add = (k: string, bad: boolean, flagged: boolean) => {
      const g = agg.get(k) ?? { n: 0, bad: 0, caught: 0, lost: 0 };
      g.n++;
      if (bad) g.bad++;
      if (bad && flagged) g.caught++;
      if (!bad && flagged) g.lost++;
      agg.set(k, g);
    };
    for (const r of rd.readings) {
      if (r.t < t0 || r.t > t1) continue;
      const cells: (Cell & { size: number })[] = [];
      for (const fc of r.faces) {
        const n = fc.ids.filter((x) => x >= 0).length;
        for (let c = 0; c < 9; c++) if (fc.ids[c] >= 0) cells.push({ pos: fc.slot * 9 + c, id: fc.ids[c], w: fc.w?.[c] ?? 1, size: n });
      }
      if (!cells.length) continue;
      // 正解: 時刻の近く（回している途中は前後どちらでもよい）で一番合う状態と姿勢
      const k0 = ref.moves.filter((m) => m.end <= r.t).length;
      let best = { bad: Infinity, k: 0, o: 0 };
      for (let k = Math.max(0, k0 - NEAR); k <= Math.min(states.length - 1, k0 + NEAR); k++)
        for (let o = 0; o < 24; o++) {
          let bad = 0;
          for (const x of cells) if (ids[k][VIEW[o * 54 + x.pos]] !== x.id) bad++;
          if (bad < best.bad) best = { bad, k, o };
        }
      const flags = physFlags(cells);
      cells.forEach((x, i) => {
        const bad = ids[best.k][VIEW[best.o * 54 + x.pos]] !== x.id;
        const kind = `${x.w >= 0.85 ? "直接" : "引き継ぎ"}・${x.size <= 3 ? "1〜3 マスの面" : "4 マス以上の面"}`;
        add(kind, bad, flags.has(i));
        add("全部", bad, flags.has(i));
        if (bad && flags.has(i)) by.set(flags.get(i)!, (by.get(flags.get(i)!) ?? 0) + 1);
        if (bad && !flags.has(i) && name === process.env.PC_EX && x.w >= 0.85 && exN++ < 15)
          process.stdout.write(`  見逃し ${(r.t / 1000).toFixed(3)}s ${"URFDLB"[Math.floor(x.pos / 9)]}${x.pos % 9} 読み ${x.id} 正解 ${ids[best.k][VIEW[best.o * 54 + x.pos]]}（面のマス ${x.size}）: ${r.faces.map((fc) => `${"URFDLB"[fc.slot]}:${fc.ids.map((y, c) => (y < 0 ? "." : (fc.w?.[c] ?? 1) < 0.85 ? `~${y}` : y)).join(",")}`).join(" ")}\n`);
      });
    }
    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
    const lines = [...agg].map(([k, g]) => `    ${k.padEnd(18)} 読み ${String(g.n).padStart(6)}・誤り ${String(g.bad).padStart(4)}（${pct(g.bad, g.n)}）・見つけた ${pct(g.caught, g.bad)}・正しいのに捨てる ${pct(g.lost, g.n - g.bad)}`);
    process.stdout.write(`${name}  見つけた決まり: ${[...by].map(([k, v]) => `${k} ${v}`).join("・")}\n${lines.join("\n")}\n`);
  }
}, 3600000);
