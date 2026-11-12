// 暗い区間の長さ: 信用できる読み（マーカーを直接読んだ・4 マス以上読めた面）だけを使い、フレームごとに「正解のどの手の後の状態か」を
// 決めて、はっきり分かるフレームの間に本当は何手あったかを数える（確かな所から埋める解き直しが、間を探し切れるかの見積もり）。
//   SP_DIR=dump SP_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/spans.debug.test.ts --silent=false
//   SP_CASES=IMG_5046_1500k_60,…・SP_MIN=5（はっきり分かるフレームに要るステッカーの数）・SP_LIST=4（この手数以上の間を出す）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";

const SOLVE_START: Record<string, number> = { IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };

it("暗い区間の長さ", () => {
  const dir = process.env.SP_DIR;
  if (!dir) return;
  const refDir = process.env.SP_REF!;
  const MIN = Number(process.env.SP_MIN ?? 5);
  const LIST = Number(process.env.SP_LIST ?? 5);
  const cases = process.env.SP_CASES ? process.env.SP_CASES.split(",") : readdirSync(dir).filter((f) => f.endsWith(".read.json")).map((f) => f.replace(".read.json", "")).sort();
  const out: string[] = [];
  for (const name of cases) {
    const b = name.slice(0, 8);
    const refName = readdirSync(refDir).find((f) => f.startsWith(b));
    if (!refName || !existsSync(`${dir}/${name}.read.json`) || !existsSync(`${dir}/${b}_orig.obs.json`)) continue;
    const ref = JSON.parse(readFileSync(`${refDir}/${refName}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const start0 = JSON.parse(readFileSync(`${dir}/${b}_orig.obs.json`, "utf8")).start as number[];
    const reads = JSON.parse(readFileSync(`${dir}/${name}.read.json`, "utf8")) as { readings: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[] };
    const states: CubeState[] = [Uint8Array.from(ref.startState ?? start0)];
    for (const m of ref.moves) states.push(applyMove(states[states.length - 1], m.move));
    const ids = states.map((s) => stickerIds(s));
    const K = SOLVE_START[b] ?? 0;
    const t0 = ref.moves[K].start - 1500;
    // フレームごと: 信用できる読み（位置 → ID）
    type Fr = { t: number; pos: number[]; id: number[] };
    const frames: Fr[] = [];
    let total = 0;
    for (const r of reads.readings) {
      if (r.t < t0) continue;
      total++;
      const pos: number[] = [];
      const id: number[] = [];
      for (const f of r.faces) {
        const good = f.ids.map((x, c) => x >= 0 && (f.w?.[c] ?? 1) >= 0.85);
        if (good.filter(Boolean).length < 4) continue;
        for (let c = 0; c < 9; c++) if (good[c]) (pos.push(f.slot * 9 + c), id.push(f.ids[c]));
      }
      if (pos.length) frames.push({ t: r.t, pos, id });
    }
    // フレームに食い違いなく合う正解の状態（手の番号の範囲）。時刻の近く（±6 手）だけ
    let at = K;
    const marks: { t: number; lo: number; hi: number; n: number }[] = [];
    let bad = 0;
    let weak = 0;
    for (const fr of frames) {
      while (at < ref.moves.length && ref.moves[at].end <= fr.t) at++;
      const n = fr.id.filter((x) => x % 9 !== 4).length;
      let lo = -1;
      let hi = -1;
      for (let k = Math.max(K, at - 6); k <= Math.min(ref.moves.length, at + 6); k++) {
        let ok = false;
        for (let o = 0; o < 24 && !ok; o++) {
          ok = true;
          for (let i = 0; i < fr.pos.length && ok; i++) if (ids[k][VIEW[o * 54 + fr.pos[i]]] !== fr.id[i]) ok = false;
        }
        if (ok) {
          if (lo < 0) lo = k;
          hi = k;
        }
      }
      if (lo < 0) bad++;
      else if (n < MIN) weak++;
      else marks.push({ t: fr.t, lo, hi, n });
    }
    // はっきり分かるフレームの間の手の数（前のフレームで一番進んだ解釈 hi から、次のフレームの一番手前の解釈 lo まで）
    const hist = new Map<number, number>();
    const big: string[] = [];
    let maxJump = 0;
    let maxDark = 0;
    for (let i = 1; i < marks.length; i++) {
      const jump = Math.max(0, marks[i].lo - marks[i - 1].hi);
      const dt = marks[i].t - marks[i - 1].t;
      hist.set(jump, (hist.get(jump) ?? 0) + 1);
      maxJump = Math.max(maxJump, jump);
      if (jump > 0) maxDark = Math.max(maxDark, dt);
      if (jump >= LIST) big.push(`${(marks[i - 1].t / 1000).toFixed(2)}〜${(marks[i].t / 1000).toFixed(2)}s ${jump} 手（${ref.moves.slice(marks[i - 1].hi, marks[i].lo).map((m) => MOVE_NAMES[m.move]).join(" ")}）`);
    }
    const h = [...hist].sort((a, b) => a[0] - b[0]).filter(([k]) => k > 0).map(([k, v]) => `${k}手×${v}`).join(" ");
    const line = `${name.padEnd(20)} フレーム ${total}・読めた ${frames.length}・正解のどれとも合わない ${bad}・弱い ${weak}・はっきり ${marks.length} / 間の手数 ${h} / 最大 ${maxJump} 手・${maxDark.toFixed(0)}ms${big.length ? `\n    ${big.join("\n    ")}` : ""}`;
    out.push(line);
    process.stdout.write(`${line}\n`);
  }
  console.log(out.join("\n"));
}, 3600000);
