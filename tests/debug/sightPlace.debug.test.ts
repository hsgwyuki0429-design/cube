// 読みの置き方の誤りを、スロットに頼る今の方式と、センターの ID と面の接し方で決める新しい方式（src/track/sight/place.ts）で比べる。
// 正解はその動画の精密解析の手順（REAL_REF）。手の時刻は粗いので、フレームの時刻の前後 SP_NEAR（既定 2）手の状態のうち、その方式の
// 読みといちばん合うものと比べる（どちらの方式にも同じだけ甘い）。
//   SP_DIR=dump npx vitest run -c vitest.debug.config.ts tests/debug/sightPlace.debug.test.ts --silent=false
//   SP_KIND=read（精密解析の読み: *_orig.read.json。既定）・live（ライブの読み: *_orig.live.json）・SP_ONLY=正規表現
// 方式:
//   slot-causal: 認識のスロットのまま。姿勢はセンターの ID が 2 つ以上読めて 1 つに決まるフレームで更新し、それ以外は前のまま
//   slot-oracle: 認識のスロットのまま。姿勢は 24 通りのうち正解にいちばん合うもの（スロットの組み合わせの狂いだけが誤りに残る）
//   sight: 新しい方式の一番の置き方（前のフレームだけを使う）
//   sight-oracle: 新しい方式の候補のうち正解にいちばん合うもの
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { fromCubeState } from "../../src/track/pieces/model";
import { CLS_DIRECT, CLS_DIRECT_FRAG, KIND_BLIND, KIND_CHAINED, KIND_FREE, KIND_SURE, NUM_CLS, type PlaceInput, type PlacedRead, Placer } from "../../src/track/sight/place";

const CLS_NAME = ["直接・面", "直接・欠片", "引き継ぎ・面", "引き継ぎ・欠片"];
const KIND_NAME = ["決まった", "続き", "4 通り", "24 通り"];

type Face = { slot: number; ids: number[]; w?: number[]; weight?: number[]; rot?: number[]; quad?: number[]; held?: boolean };
export function loadReadings(file: string): { start: number[]; readings: PlaceInput[] } {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const readings: PlaceInput[] = j.readings.map((r: { t: number; faces: Face[]; sight?: { faces: Face[] } }) => {
    const sight = new Map((r.sight?.faces ?? []).map((f) => [f.slot, f]));
    return { t: r.t, faces: r.faces.filter((f) => f.ids).map((f) => ({ slot: f.slot, ids: f.ids, w: f.w ?? f.weight, rot: f.rot ?? sight.get(f.slot)?.rot, quad: f.quad ?? sight.get(f.slot)?.quad, held: f.held ?? sight.get(f.slot)?.held })) };
  });
  return { start: j.start, readings };
}

export function truthStates(start: CubeState, moves: { move: number; end: number }[]) {
  const states: CubeState[] = [start];
  let s = start;
  for (const m of moves) states.push((s = applyMove(s, m.move)));
  return { states, ids: states.map((x) => stickerIds(x)), pos: states.map((x) => fromCubeState(x).pos), ends: moves.map((m) => m.end) };
}

// 古い方式の読み（スロットの面）を、直接・欠片の種類つきのマスにする
function slotCells(r: PlaceInput): { q: number; s: number; cls: number }[] {
  const out: { q: number; s: number; cls: number }[] = [];
  for (const f of r.faces) {
    if (f.held) continue;
    const w = f.w ?? f.weight;
    const direct = f.ids.map((id, c) => id >= 0 && (f.rot?.[c] ?? 0) >= 0 && (w?.[c] ?? 1) >= 0.85);
    const big = direct.filter(Boolean).length >= 4;
    for (let c = 0; c < 9; c++) {
      if (f.ids[c] < 0 || f.ids[c] % 9 === 4) continue;
      out.push({ q: f.slot * 9 + c, s: f.ids[c], cls: direct[c] ? (big ? 0 : 1) : big ? 2 : 3 });
    }
  }
  return out;
}

function orientOfCenters(r: PlaceInput): number {
  const cs = r.faces.filter((f) => !f.held && f.ids[4] >= 0 && f.ids[4] % 9 === 4 && (f.rot?.[4] ?? 0) >= 0);
  if (cs.length < 2) return -1;
  const ok: number[] = [];
  for (let o = 0; o < 24; o++) if (cs.every((f) => VIEW[(o * 6 + f.slot) * 9 + 4] === f.ids[4])) ok.push(o);
  return ok.length === 1 ? ok[0] : -1;
}

it("読みの置き方の誤り", () => {
  const dir = process.env.SP_DIR;
  if (!dir) return;
  const kind = process.env.SP_KIND ?? "read";
  const NEAR = Number(process.env.SP_NEAR ?? 2);
  const methods = ["slot-causal", "slot-oracle", "sight", "sight-oracle"];
  const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%（${b}）`;
  const totKind = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
  const tot = methods.map(() => ({ n: new Array(NUM_CLS).fill(0), bad: new Array(NUM_CLS).fill(0), frames: 0, badFrames: 0 }));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(`_orig.${kind}.json`) && new RegExp(process.env.SP_ONLY ?? ".").test(x)).sort()) {
    const name = f.replace(`_orig.${kind}.json`, "");
    let ref: { moves: { move: number; end: number }[] };
    try {
      ref = JSON.parse(readFileSync(`${dir}/${name}_orig.ref.json`, "utf8"));
    } catch {
      continue;
    }
    const { start, readings } = loadReadings(`${dir}/${f}`);
    const T = truthStates(Uint8Array.from(start), ref.moves);
    const placer = new Placer();
    const per = methods.map(() => ({ n: new Array(NUM_CLS).fill(0), bad: new Array(NUM_CLS).fill(0), frames: 0, badFrames: 0 }));
    const kinds = new Array(4).fill(0);
    const kindBad = new Array(4).fill(0);
    // 置き方の種類ごと: [読み, 新しい方式の誤り, 新しい方式（候補から正解に合うもの）の誤り, 古い方式（姿勢は正解に合うもの）の誤り]（直接・面だけ）
    const byKind = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
    let lastOracleSlot: { cls: number[]; bad: number[] } | null = null;
    let o = -1;
    let k0 = 0;
    let dropped = 0;
    const add = (m: number, cls: number[], bad: number[]) => {
      const p = per[m];
      let nb = 0;
      for (let i = 0; i < cls.length; i++) {
        p.n[cls[i]]++;
        p.bad[cls[i]] += bad[i];
        nb += bad[i];
      }
      if (cls.length) p.frames++;
      if (nb >= 2) p.badFrames++;
    };
    for (const r of readings) {
      while (k0 < T.ends.length && T.ends[k0] <= r.t) k0++;
      const ks: number[] = [];
      for (let k = Math.max(0, k0 - NEAR); k <= Math.min(T.states.length - 1, k0 + NEAR); k++) ks.push(k);
      // 古い方式
      const cells = slotCells(r);
      const oc = orientOfCenters(r);
      if (oc >= 0) o = oc;
      const evalSlot = (oo: number, k: number) => cells.map((c) => (T.ids[k][VIEW[oo * 54 + c.q]] === c.s ? 0 : 1));
      const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
      if (cells.length) {
        if (o >= 0) {
          let best: number[] | null = null;
          for (const k of ks) {
            const b = evalSlot(o, k);
            if (!best || sum(b) < sum(best)) best = b;
          }
          add(0, cells.map((c) => c.cls), best!);
        } else add(0, cells.map((c) => c.cls), cells.map(() => 1));
        let best: number[] | null = null;
        for (let oo = 0; oo < 24; oo++)
          for (const k of ks) {
            const b = evalSlot(oo, k);
            if (!best || sum(b) < sum(best)) best = b;
          }
        add(1, cells.map((c) => c.cls), best!);
        lastOracleSlot = { cls: cells.map((c) => c.cls), bad: best! };
      } else lastOracleSlot = null;
      // 新しい方式
      const pf = placer.push(r);
      if (!pf) continue;
      dropped += pf.dropped;
      const evalReads = (reads: PlacedRead[], k: number) => reads.map((x) => (T.pos[k][x.piece] === x.at ? 0 : 1));
      let best: number[] | null = null;
      for (const k of ks) {
        const b = evalReads(pf.cands[0].reads, k);
        if (!best || sum(b) < sum(best)) best = b;
      }
      add(2, pf.cands[0].reads.map((x) => x.cls), best!);
      kinds[pf.kind]++;
      if (sum(best!) >= 2) kindBad[pf.kind]++;
      let bestO: { b: number[]; reads: PlacedRead[] } | null = null;
      for (const c of pf.cands)
        for (const k of ks) {
          const b = evalReads(c.reads, k);
          if (!bestO || sum(b) < sum(bestO.b)) bestO = { b, reads: c.reads };
        }
      add(3, bestO!.reads.map((x) => x.cls), bestO!.b);
      const bk = byKind[pf.kind];
      pf.cands[0].reads.forEach((x, i) => {
        if (x.cls !== 0) return;
        bk[0]++;
        bk[1] += best![i];
      });
      bestO!.reads.forEach((x, i) => x.cls === 0 && (bk[2] += bestO!.b[i]));
      if (lastOracleSlot)
        lastOracleSlot.cls.forEach((c, i) => {
          if (c !== 0) return;
          bk[3]++;
          bk[4] += lastOracleSlot!.bad[i];
        });
    }
    const line = (m: number) => {
      const p = per[m];
      const t = tot[m];
      for (let c = 0; c < NUM_CLS; c++) {
        t.n[c] += p.n[c];
        t.bad[c] += p.bad[c];
      }
      t.frames += p.frames;
      t.badFrames += p.badFrames;
      return `  ${methods[m].padEnd(13)} ${CLS_NAME.map((nm, c) => `${nm} ${p.n[c]} 誤り ${((100 * p.bad[c]) / Math.max(1, p.n[c])).toFixed(2)}%`).join("・")}・2 マス以上合わないフレーム ${p.badFrames}/${p.frames}`;
    };
    process.stdout.write(`${name}（${kind}・${readings.length} 枚）\n${methods.map((_, m) => line(m)).join("\n")}\n  置き方: ${KIND_NAME.map((nm, i) => `${nm} ${kinds[i]}（2 マス以上合わない ${kindBad[i]}）`).join("・")}・向きが合わず捨てた読み ${dropped}\n  直接・面の誤り（置き方の種類ごと。新しい方式 / 候補から正解に合うもの / 古い方式で姿勢は正解に合うもの）: ${KIND_NAME.map((nm, i) => `${nm} ${pct(byKind[i][1], byKind[i][0])} / ${pct(byKind[i][2], byKind[i][0])} / ${pct(byKind[i][4], byKind[i][3])}`).join("・")}\n`);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) totKind[i][j] += byKind[i][j];
  }
  process.stdout.write(
    `合計\n${tot.map((p, m) => `  ${methods[m].padEnd(13)} ${CLS_NAME.map((nm, c) => `${nm} ${p.n[c]} 誤り ${((100 * p.bad[c]) / Math.max(1, p.n[c])).toFixed(2)}%`).join("・")}・2 マス以上合わないフレーム ${p.badFrames}/${p.frames}`).join("\n")}\n`,
  );
  process.stdout.write(`  直接・面の誤り（置き方の種類ごと）: ${KIND_NAME.map((nm, i) => `${nm} ${pct(totKind[i][1], totKind[i][0])} / ${pct(totKind[i][2], totKind[i][0])} / ${pct(totKind[i][4], totKind[i][3])}`).join("・")}\n`);
  void KIND_SURE;
  void KIND_CHAINED;
  void KIND_FREE;
  void KIND_BLIND;
  void CLS_DIRECT;
  void CLS_DIRECT_FRAG;
});
