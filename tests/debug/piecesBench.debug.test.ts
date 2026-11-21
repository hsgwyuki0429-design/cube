// ステッカーの動きの方程式による解き直し（src/track/pieces）を、今の解き直し（decodeOffline）と比べる。
// 材料は realVideo.debug.test.ts の書き出し（本体の条件: ソルブだけ・止まったフレームを飛ばす・インスペクションを間引く・ライブなし）:
//   REAL_RREADINGS → <名前>.read.json（精密に処理したフレームの読み）・REAL_OBS → <名前>.obs.json（今の解き直しの観測）
//   PB_DIR=フォルダ PB_TRUTH=buildTruth の BT_OUT PB_BM=原画質の動画全体の精密解析（REAL_REF）npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false
//   PB_ONLY=正規表現・PB_METHOD=new|old|both（既定 both）・PB_DEC='{"beam":64}'（decode.ts）・PB_TABLE='{"touch":0.4}'（table.ts）・
//   PB_OUT=ファイル（1 行 1 つの JSON を足す）・PB_SHOW=1（違うときに手順を並べる）・PB_STEPS=1（見え方ごとの様子）
//   PB_EPS=1: 読み違いの割合 ε を、種類（直接・欠片・引き継いだ ID）× 続いた長さごとに正解の状態と照らして測る（table.ts の MEASURED_EPS）。
//     面の置き方の誤り（既定の置き方では合わず、ほかの候補では合う面）の割合も
// 正解: 新しい正解（buildTruth の BT_OUT。ソルブの部分だけ）。手順の分かっている T-perm 2 本（IMG_4970・4971）はその手順。IMG_5047 は
// 新しい正解が作れない（推定 50 手）ので、原画質の動画全体の精密解析（PB_BM）のソルブの部分を使い、注記する。
// 手順はまとめた形（decode.ts の canonical: 同じ面をまとめ、反対の面の順番をそろえる）で比べる。「確定のまま間違えた手」は、まとめた形で
// 正解と対応しない（最長共通部分列）手のうち、元の手がどれも inferred でないもの（decodeBench の verify と同じ数え方）。
// メモリは 1 回の解き直しの間に増えた最大の RSS（process.resourceUsage().maxRSS − 解き直しの前の RSS）。1 本ずつ別のプロセスで回すこと
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { PROFILE, alignment, buildSights, canonical, canonicalWithIndex, decodePieces, scoreMoves } from "../../src/track/pieces/decode";
import { PIECE_OF, piecesOf } from "../../src/track/pieces/model";
import { KIND_CARRIED, KIND_DIRECT, KIND_FRAGMENT, LEN_BUCKETS, buildTable, lenBucket } from "../../src/track/pieces/table";
import { SOLVE_PROFILE, solvePieces } from "../../src/track/pieces/solve";
import { DEFAULT_OFFLINE, type OfflineResult, decodeOffline } from "../../src/track/offline";
import type { SightFrame } from "../../src/track/sight";
import type { Observation } from "../../src/track/types";

type RawObs = Omit<Observation, "faces"> & { faces: { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] }[] };
type Reading = { t: number; faces: { slot: number; ids: number[]; w?: number[]; rot?: number[]; quad?: number[]; held?: boolean; c?: number[] }[] };
const KNOWN: Record<string, string> = { IMG_4970: "R U R' U' R' F R2 U' R' U' R U R' F' R U R' U' R' F R2 U' R' U' R U R' F'", IMG_4971: "R U R' U' R' F R2 U' R' U' R U R' F' R U R' U' R' F R2 U' R' U' R U R' F'" };

export function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

export const toSights = (rd: Reading[]): SightFrame[] => rd.map((r) => ({ t: r.t, faces: r.faces.map((f) => ({ slot: f.slot, ids: f.ids, rot: f.rot ?? new Array(9).fill(-1), quad: f.quad ?? [], ...(f.held ? { held: true } : {}) })) }));

// 正解: 手（時刻つき）と始まりの状態
function truthOf(name: string, rdStart: number[]): { start: CubeState; moves: { move: number; start: number; end: number }[]; note: string } | null {
  const b = name.slice(0, 8);
  if (KNOWN[b]) return { start: Uint8Array.from(rdStart), moves: parseMoves(KNOWN[b]).map((move) => ({ move, start: Number.NaN, end: Number.NaN })), note: "" };
  const tdir = process.env.PB_TRUTH;
  if (!tdir) return null;
  const tf = readdirSync(tdir).find((f) => f.startsWith(b));
  if (b !== "IMG_5047" && tf) {
    const t = JSON.parse(readFileSync(`${tdir}/${tf}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState: number[] };
    return { start: Uint8Array.from(t.startState), moves: t.moves, note: "" };
  }
  // IMG_5047: 原画質の動画全体の精密解析のソルブの部分（新しい正解が作れない）
  const bm = process.env.PB_BM;
  if (!bm) return null;
  const rf = readdirSync(bm).find((f) => f.startsWith(b));
  if (!rf) return null;
  const ref = JSON.parse(readFileSync(`${bm}/${rf}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
  let s: CubeState = Uint8Array.from(ref.startState ?? solvedState());
  // ソルブの始まり: いちばん長い間（最初の 7 割の中）
  let k = 0;
  let gap = 0;
  for (let i = 1; i < ref.moves.length * 0.7; i++)
    if (ref.moves[i].start - ref.moves[i - 1].end > gap) {
      gap = ref.moves[i].start - ref.moves[i - 1].end;
      k = i;
    }
  for (let i = 0; i < k; i++) s = applyMove(s, ref.moves[i].move);
  return { start: s, moves: ref.moves.slice(k), note: "（正解は原画質の精密解析）" };
}

// 今の解き直し: 本体の精密解析と同じ（src/vision/refine.ts の result: 1 回目、前後がつながらなければ深い 2 回目）
function oldDecode(obs: Observation[], start: CubeState, end: CubeState, lastT: number): OfflineResult {
  const base = { decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder }, backwardMs: 30000 };
  let off = decodeOffline(obs, start, end, lastT, base);
  if (off.method !== "meet" && off.method !== "backward") {
    const deep = decodeOffline(obs, start, end, lastT, { ...base, decoder: { ...base.decoder, beamWidth: 256, maxMovesPerStep: 4, deepHyps: Infinity }, backwardMs: 60000 });
    const guessed = (r: OfflineResult) => r.moves.filter((m) => m.inferred).length;
    if (deep.reachedEnd && (!off.reachedEnd || guessed(deep) < guessed(off) || (guessed(deep) === guessed(off) && deep.method === "meet"))) off = deep;
  }
  return off;
}

// まとめた形で、確定のまま正解と対応しない手と、確定で正しい手
function wrongSure(ms: { move: number; inferred?: boolean }[], want: number[]): { wrong: number; ok: number } {
  const c = canonicalWithIndex(ms.map((m) => m.move));
  const map = alignment(
    c.map((x) => x.m),
    want,
  );
  let wrong = 0;
  let ok = 0;
  c.forEach((x, i) => {
    if (!x.idx.every((k) => !ms[k].inferred)) return;
    if (map[i] < 0) wrong++;
    else ok++;
  });
  return { wrong, ok };
}

const KIND_NAMES = ["直接（4 マス以上の面）", "直接（1〜3 マスの欠片）", "引き継いだ ID", "センターの向き"];

it("ステッカーの動きの方程式で解き直す", async () => {
  const dir = process.env.PB_DIR;
  if (!dir) return;
  // old = 今の解き直し（decodeOffline）・new = 前回の新しい方式（decode.ts）・and = 表の AND 版（solve.ts）。both = old,new・all = 3 つ
  const methods = (process.env.PB_METHOD ?? "both") === "both" ? ["old", "new"] : process.env.PB_METHOD === "all" ? ["old", "new", "and"] : process.env.PB_METHOD!.split(",");
  const out: string[] = [];
  // ε の集計: [種類][長さ] → { 続いた読み, 間違い }
  const eps = Array.from({ length: 4 }, () => LEN_BUCKETS.map(() => ({ runs: 0, bad: 0, frames: 0, badFrames: 0 })));
  const place = { groups: 0, wrongDefault: 0, fixedByAlt: 0, byMode: new Map<string, { n: number; bad: number }>() };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".read.json")).sort()) {
    const name = file.replace(".read.json", "");
    if (process.env.PB_ONLY && !new RegExp(process.env.PB_ONLY).test(name)) continue;
    const rd = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { start: number[]; readings: Reading[] };
    const truth = truthOf(name, rd.start);
    if (!truth) continue;
    const start = Uint8Array.from(rd.start);
    if (!statesEqual(start, truth.start)) out.push(`  （${name}: 始まりの状態が正解と違う）`);
    const end = solvedState();
    const want = canonical(truth.moves.map((m) => m.move));
    const sights = toSights(rd.readings);
    if (process.env.PB_EPS) {
      if (KNOWN[name.slice(0, 8)] || truth.note) continue; // 時刻の分かる正解だけ
      // 正解の状態（手の終わりの時刻ごと）
      const states = [piecesOf(truth.start)];
      let s: CubeState = truth.start;
      for (const m of truth.moves) states.push(piecesOf((s = applyMove(s, m.move))));
      const kAt = (t: number) => {
        let k = 0;
        while (k < truth.moves.length && truth.moves[k].end <= t) k++;
        return k;
      };
      // 時刻 t の前後 150ms のどこかの正解の状態で、ピース p が x にあるか
      const holds = (p: number, x: number, t: number) => {
        for (let k = kAt(t - 150); k <= kAt(t + 150); k++) if (states[k][p] === x) return true;
        return false;
      };
      const tb = buildTable(sights, { ...JSON.parse(process.env.PB_TABLE ?? "{}"), debug: true });
      // センターの向き: 正解の手で面を回した回数 + 最初の向き（面ごとに、読みでいちばん多いもの）
      const turnsAt = (f: number, t: number) => {
        let n = 0;
        for (const m of truth.moves) if (m.end <= t && Math.floor(m.move / 3) === f) n += (m.move % 3) + 1;
        return n & 3;
      };
      const offset = [0, 1, 2, 3, 4, 5].map((f) => {
        const votes = [0, 0, 0, 0];
        for (const r of tb.runs!) if (r.piece === 20 + f) for (const t of r.times) votes[(r.x - turnsAt(f, t) + 4) & 3]++;
        return votes.indexOf(Math.max(...votes));
      });
      // 置き方: 正解の状態にいちばん合う候補（同じなら既定）。読みはその置き方で照らす（読みの誤りと置き方の誤りを分けて測る）
      const okAt = (p: number, x: number, t: number) => {
        if (x === 255) return false;
        if (p >= 20) {
          const f = p - 20;
          return [turnsAt(f, t - 150), turnsAt(f, t), turnsAt(f, t + 150)].some((k) => ((offset[f] + k) & 3) === x);
        }
        return holds(p, x, t);
      };
      // ステッカーごとの続いた読み（既定の置き方の位置で続きを決める: table.ts と同じ）
      const open = new Map<number, { x: number; t: number; kind: number; frames: boolean[] }>();
      const runs: { kind: number; frames: boolean[] }[] = [];
      for (const fr of tb.frames)
        for (const g of fr.groups) {
          const nc = g.prior.length;
          const free = g.prior.length > 1 && Array.from(g.prior).every((x) => x === 0 || !Number.isFinite(x));
          const mode = `${g.mode === 0 ? "置き方の決まった面" : g.mode === 1 ? "センター 1 つ" : g.mode === 2 ? "センターなし" : "スロットで置いた欠片"}${free ? "（決まらない）" : ""}`;
          let cBest = 0;
          let nBest = -1;
          for (let c = 0; c < nc; c++) {
            let n = 0;
            for (let i = 0; i < g.n; i++) if (okAt(g.P[i], g.A[c * g.n + i], fr.t)) n++;
            if (n > nBest) {
              nBest = n;
              cBest = c;
            }
          }
          if (g.n >= 3) {
            place.groups++;
            const bm = place.byMode.get(mode) ?? { n: 0, bad: 0 };
            bm.n++;
            if (cBest !== 0) {
              let n0 = 0;
              for (let i = 0; i < g.n; i++) if (okAt(g.P[i], g.A[i], fr.t)) n0++;
              if (nBest >= n0 + 2) {
                bm.bad++;
                place.wrongDefault++;
              }
            }
            place.byMode.set(mode, bm);
          }
          for (let i = 0; i < g.n; i++) {
            const s0 = g.S[i];
            const x0 = g.A[i];
            let run = open.get(s0);
            if (!run || run.x !== x0 || fr.t - run.t > 300) {
              run = { x: x0, t: fr.t, kind: g.kind[i], frames: [] };
              open.set(s0, run);
              runs.push(run);
            }
            run.t = fr.t;
            run.kind = Math.min(run.kind, g.kind[i]);
            run.frames.push(okAt(g.P[i], g.A[cBest * g.n + i], fr.t));
          }
        }
      for (const r of runs) {
        const e = eps[r.kind][lenBucket(r.frames.length)];
        e.runs++;
        const bad = r.frames.filter((x) => !x).length;
        e.frames += r.frames.length;
        e.badFrames += bad;
        if (bad * 2 > r.frames.length) e.bad++;
      }
      continue;
    }
    for (const method of methods) {
      const rss0 = process.memoryUsage().rss;
      const a = performance.now();
      let moves: { move: number; inferred?: boolean; t: number }[] = [];
      let solved = false;
      let info = "";
      let reasons: Record<string, number> = {};
      let stats: unknown;
      if (method === "new") {
        const tb = buildTable(sights, JSON.parse(process.env.PB_TABLE ?? "{}"));
        const dopt = JSON.parse(process.env.PB_DEC ?? "{}");
        if (process.env.PB_VERIFY) dopt.debugVerify = (l: string) => process.stdout.write(`  確かめ ${l}\n`);
        if (process.env.PB_STEPS)
          dopt.onStep = (x: { back: boolean; step: number; t: number; readings: number; depth: number; hyps: number; best: number; mis: number; expanded: number; moves: number[] }) =>
            process.stdout.write(`   ${x.back ? "←" : "→"} ${x.step} t=${(x.t / 1000).toFixed(3)} 読み ${x.readings} 深さ ${x.depth} 仮説 ${x.hyps} 一番 ${x.best.toFixed(1)} 食い違い ${x.mis.toFixed(1)} ${x.moves.slice(-8).map((m) => MOVE_NAMES[m]).join(" ")}\n`);
        for (const k of Object.keys(PROFILE)) (PROFILE as Record<string, number>)[k] = 0;
        // PB_CPU=1: 関数ごとの時間
        const r = process.env.PB_CPU
          ? await (async () => {
              const { profile, summarize } = await import("./prof");
              const p = await profile(() => decodePieces(tb, start, end, dopt));
              process.stdout.write(`${summarize(p.nodes, p.interval, 1, 25)}\n`);
              return p.value;
            })()
          : decodePieces(tb, start, end, dopt);
        if (process.env.PB_PROF) process.stdout.write(`  内訳 ${JSON.stringify(Object.fromEntries(Object.entries(PROFILE).map(([k, v]) => [k, Math.round(v)])))}\n`);
        moves = r.moves;
        // PB_SCORE=1: 正解の手順の点数と比べる（正解の方が安ければ探索の取りこぼし）
        if (process.env.PB_SCORE) {
          const sc = scoreMoves(tb, start, end, truth.moves.map((m) => m.move), dopt);
          const mine = scoreMoves(tb, start, end, r.moves.map((m) => m.move), dopt);
          process.stdout.write(`  点数: 答え ${r.cost.toFixed(1)}（割り振り直し ${mine.cost.toFixed(1)}）・正解 ${sc.cost.toFixed(1)}\n`);
          if (process.env.PB_SCORE === "2") {
            const a = new Map(mine.perSight.map((x) => [x.t, x.mis]));
            for (const x of sc.perSight) if (Math.abs(x.mis - (a.get(x.t) ?? 0)) > 0.5) process.stdout.write(`    ${(x.t / 1000).toFixed(3)} 正解 ${x.mis.toFixed(1)}（${x.k} 手目）・答え ${(a.get(x.t) ?? 0).toFixed(1)}\n`);
          }
        }
        solved = r.reachedEnd;
        info = `${r.method}・確かめ ${JSON.stringify(r.verified)}・見え方 ${r.sights}・候補 ${r.expanded}・別の解 ${r.alternatives}${r.reachedEnd ? "" : `・前向き〜${((r.forwardTo ?? 0) / 1000).toFixed(2)}s・後ろ向き ${((r.backwardTo ?? 0) / 1000).toFixed(2)}s〜`}・表 ${tb.stats.used}/${sights.length} 枚（決まった ${tb.stats.sure}・続き ${tb.stats.chained}・決まらない ${tb.stats.free}・センターなし ${tb.stats.blind}・欠片 ${tb.stats.held}）`;
      } else if (method === "and") {
        const tb = buildTable(sights, JSON.parse(process.env.PB_TABLE ?? "{}"));
        const sopt = JSON.parse(process.env.PB_SOLVE ?? "{}");
        if (process.env.PB_VERIFY) sopt.debugVerify = (l: string) => process.stdout.write(`  確かめ ${l}\n`);
        if (process.env.PB_STEPS)
          sopt.onStep = (x: { back: boolean; step: number; t: number; hyps: number; best: number; eqs: number; k: number }) => process.stdout.write(`   ${x.back ? "←" : "→"} ${x.step} t=${(x.t / 1000).toFixed(3)} 式 ${x.eqs} k ${x.k} 仮説 ${x.hyps} 一番 ${x.best.toFixed(1)}\n`);
        // PB_TRACK=1: 見え方ごとに、正解の状態（手の終わりの時刻で、前後 1 手まで）が仮説に残っているか
        if (process.env.PB_TRACK) {
          const states = [piecesOf(truth.start)];
          let s: CubeState = truth.start;
          for (const m of truth.moves) states.push(piecesOf((s = applyMove(s, m.move))));
          const same = (a: Uint8Array, b: Uint8Array) => {
            for (let p = 0; p < 20; p++) if (a[p] !== b[p]) return false;
            return true;
          };
          const sg = buildSights(tb, sopt);
          sopt.onHyps = (back: boolean, step: number, hyps: { s: Uint8Array; cost: number }[]) => {
            const i = back ? sg.length - 1 - step : step;
            if (i < 0 || i >= sg.length) return;
            const t = sg[i].t0;
            let k = 0;
            while (k < truth.moves.length && truth.moves[k].end <= t) k++;
            const sorted = [...hyps].sort((x, y) => x.cost - y.cost);
            // 正解の途中の状態のどれか（時刻のない正解もあるので全部から。いちばん近い番号）
            let found = "";
            let bestD = Number.POSITIVE_INFINITY;
            for (let j = 0; j < states.length; j++) {
              const r = sorted.findIndex((h) => same(h.s, states[j]));
              if (r >= 0 && Math.abs(j - k) < bestD) {
                bestD = Math.abs(j - k);
                found = `${j} 手目の状態 ${r + 1} 番目 +${(sorted[r].cost - sorted[0].cost).toFixed(1)}`;
              }
            }
            process.stdout.write(`   ${back ? "←" : "→"} ${step} t=${(t / 1000).toFixed(3)} 正解 ${k} 手目 ${found || "なし"}（仮説 ${hyps.length}）\n`);
          };
        }
        for (const k of Object.keys(SOLVE_PROFILE)) (SOLVE_PROFILE as Record<string, number>)[k] = 0;
        const r = process.env.PB_CPU
          ? await (async () => {
              const { profile, summarize } = await import("./prof");
              const p = await profile(() => solvePieces(tb, start, end, sopt));
              process.stdout.write(`${summarize(p.nodes, p.interval, 1, 30)}\n`);
              return p.value;
            })()
          : solvePieces(tb, start, end, sopt);
        if (process.env.PB_PROF) process.stdout.write(`  内訳 ${JSON.stringify(Object.fromEntries(Object.entries(SOLVE_PROFILE).map(([k, v]) => [k, Math.round(v)])))}\n`);
        moves = r.moves;
        if (process.env.PB_SCORE) {
          const sc = scoreMoves(tb, start, end, truth.moves.map((m) => m.move), sopt);
          const mine = scoreMoves(tb, start, end, r.moves.map((m) => m.move), sopt);
          process.stdout.write(`  点数: 答え ${r.cost.toFixed(1)}（割り振り直し ${mine.cost.toFixed(1)}）・正解 ${sc.cost.toFixed(1)}\n`);
          if (process.env.PB_SCORE === "2") {
            const a = new Map(mine.perSight.map((x) => [x.t, x.mis]));
            for (const x of sc.perSight) if (Math.abs(x.mis - (a.get(x.t) ?? 0)) > 0.5) process.stdout.write(`    ${(x.t / 1000).toFixed(3)} 正解 ${x.mis.toFixed(1)}（${x.k} 手目）・答え ${(a.get(x.t) ?? 0).toFixed(1)}\n`);
          }
        }
        solved = r.reachedEnd;
        reasons = r.reasons;
        stats = { ...r.stats, ms: Math.round(r.stats.ms) };
        info = `${r.method}・確かめ ${JSON.stringify(r.verified)}・区間 ${JSON.stringify({ ...r.stats, ms: Math.round(r.stats.ms) })}・理由 ${JSON.stringify(r.reasons)}`;
      } else {
        const raw = JSON.parse(readFileSync(`${dir}/${name}.obs.json`, "utf8")) as { lastT: number; obs: RawObs[] };
        const obs: Observation[] = raw.obs.map((o) => ({
          ...o,
          faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
        }));
        const r = oldDecode(obs, start, end, raw.lastT);
        moves = r.moves;
        solved = r.reachedEnd && !(r.startState && !statesEqual(r.startState, start));
        info = `${r.method}・観測 ${obs.length}`;
      }
      const ms = performance.now() - a;
      const mem = (process.resourceUsage().maxRSS * 1024 - rss0) / 1048576;
      const got = canonical(moves.map((m) => m.move));
      const dist = editDistance(got, want);
      const inferred = moves.filter((m) => m.inferred).length;
      const ws = solved ? wrongSure(moves, want) : { wrong: 0, ok: 0 };
      const row = { name, method, solved, same: solved && dist === 0, dist, n: want.length, wrongSure: ws.wrong, inferred, ms: Math.round(ms), memMB: Math.round(mem), note: truth.note, reasons, ...(stats ? { stats } : {}) };
      const line = `${name.padEnd(16)} ${method.padEnd(3)} ${solved ? "完成" : "未完"} ${row.same ? "正解と同じ" : `距離 ${String(dist).padStart(3)}`}/${want.length} 確定で間違い ${ws.wrong} 推定 ${String(inferred).padStart(2)} ${(ms / 1000).toFixed(1).padStart(5)}秒 メモリ +${row.memMB}MB ${info}${truth.note}`;
      out.push(line);
      process.stdout.write(`${line}\n`);
      if (process.env.PB_OUT) appendFileSync(process.env.PB_OUT, `${JSON.stringify(row)}\n`);
      if (process.env.PB_SHOW && (dist || process.env.PB_SHOW === "2")) {
        let i = 0;
        while (i < got.length && i < want.length && got[i] === want[i]) i++;
        let j = 0;
        while (j < got.length - i && j < want.length - i && got[got.length - 1 - j] === want[want.length - 1 - j]) j++;
        const nm = (xs: number[]) => xs.map((m) => MOVE_NAMES[m]).join(" ");
        process.stdout.write(`  まとめた形の違い（${i} 手目から・後ろ ${j} 手は同じ）: 出力 [${nm(got.slice(i, got.length - j))}] 正解 [${nm(want.slice(i, want.length - j))}]\n`);
        process.stdout.write(`  ${i} 手目から違う\n  出力 ${moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}@${(m.t / 1000).toFixed(2)}`).join(" ")}\n  正解 ${truth.moves.map((m) => `${MOVE_NAMES[m.move]}@${(m.end / 1000).toFixed(2)}`).join(" ")}\n`);
      }
    }
  }
  if (process.env.PB_EPS) {
    for (let k = 0; k < 4; k++)
      out.push(
        `${KIND_NAMES[k]}: ${eps[k].map((e, j) => `長さ ${LEN_BUCKETS[j]}${j + 1 < LEN_BUCKETS.length ? `〜${LEN_BUCKETS[j + 1] - 1}` : "〜"} ${e.runs} 本・誤り ${((100 * e.bad) / Math.max(1, e.runs)).toFixed(2)}%（フレーム ${((100 * e.badFrames) / Math.max(1, e.frames)).toFixed(2)}%）`).join(" / ")}`,
      );
    out.push(`面の置き方: ${place.groups} 面のうち既定で半分より多く合わない ${place.wrongDefault}（ほかの候補で 8 割合う ${place.fixedByAlt}）・${[...place.byMode].map(([k, v]) => `${k} ${v.bad}/${v.n}`).join("・")}`);
  }
  console.log(out.join("\n"));
}, 36000000);

export { KIND_CARRIED, KIND_DIRECT, KIND_FRAGMENT, PIECE_OF };
