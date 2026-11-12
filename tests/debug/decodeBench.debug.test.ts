// 精密解析の解き直しを、書き出した観測と読み（realVideo.debug.test.ts の REAL_OBS・REAL_RREADINGS、REAL_OBS_ONLY=1 で作る）で比べる。
// 正解は原画質の精密解析の手順（bm/<動画>.ref.json）。手順は rescore.ts の canonical（同じ面をまとめ、反対の面の順番をそろえる）で比べる。
//   DB_DIR=dump DB_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/decodeBench.debug.test.ts --silent=false
//   DB_CASES=IMG_5046_1500k_60,…（省略時は DB_DIR の全部）・DB_MODE=whole|app|both・DB_METHOD=beam,anchors,frames,exact,verify
//   （exact: src/track/exact.ts の decodeExact だけ。verify: 本体と同じ beam + 確認役。DB_EXACT='{"slack":8}'・DB_DEBUG=1|2|why・DB_SHOW=1）
//   DB_OUT=結果.json（行を足していく）・DB_ANCH='{"keep":12}'（anchors.ts の設定）
// app: 本体のタイマーと同じく、ソルブだけ（インスペクションの終わり近くから、正解のその時の状態で始める）。whole: 動画の最初から（速く崩す所も含む）
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, solvedState, statesEqual } from "../../src/cube/model";
import { decodeAnchors } from "../../src/track/anchors";
import { _verifyInternal, decodeExact, verifyMoves } from "../../src/track/exact";
import { DEFAULT_OFFLINE, type OfflineResult, decodeOffline } from "../../src/track/offline";
import { canonical } from "../../src/track/rescore";
import type { Observation } from "../../src/track/types";

type RawObs = Omit<Observation, "faces"> & { faces: { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] }[] };
// ソルブの始まり（正解の手の番号。その前に長い間がある = インスペクション）
const SOLVE_START: Record<string, number> = { IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 30 };

function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

// 本体の精密解析と同じ解き直し（src/vision/refine.ts の result: 1 回目、つながらなければ深い 2 回目）
function beamDecode(obs: Observation[], start: CubeState, end: CubeState, lastT: number): OfflineResult {
  // DB_DEC='{"beamWidth":2048}' など: 1 回目のデコーダの設定を上書き（DB_NODEEP=1 で 2 回目を省く）
  const dec = { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder, ...JSON.parse(process.env.DB_DEC ?? "{}") };
  let off = decodeOffline(obs, start, end, lastT, { decoder: dec, backwardMs: 30000 });
  if (!process.env.DB_NODEEP && off.method !== "meet" && off.method !== "backward") {
    const deep = decodeOffline(obs, start, end, lastT, { decoder: { ...dec, beamWidth: 256, maxMovesPerStep: 4 }, backwardMs: 60000 });
    const guessed = (r: OfflineResult) => r.moves.filter((m) => m.inferred).length;
    if (deep.reachedEnd && (!off.reachedEnd || guessed(deep) < guessed(off) || (guessed(deep) === guessed(off) && deep.method === "meet"))) off = deep;
  }
  return off;
}

// フレームごとの観測: はっきり読めた（確からしさ minW 以上）ID が 1 つでもあるフレームを、そのまま 1 つの観測にする
// （観測器は 2 枚続いて同じ読みのときだけ観測にするので、1 枚だけ読めたフレームは使われていなかった）。
// 色の矛盾 mis・別のステッカーの矛盾 idc（マスごと）。読みが前のフレームと同じなら観測にしない（同じ証拠を数え直さない）
function frameObservations(reads: { t: number; faces: { slot: number; ids: number[]; w?: number[] }[] }[], t0: number, minW: number, mis: number, idc: number): Observation[] {
  const out: Observation[] = [];
  let lastKey = "";
  let lastT = t0;
  for (const r of reads) {
    if (r.t < t0) continue;
    const faces = r.faces
      .map((f) => {
        const ids = Int16Array.from(f.ids, (x, c) => (x >= 0 && (f.w?.[c] ?? 1) >= minW ? x : -1));
        if (!ids.some((x) => x >= 0)) return null;
        const labels = Int8Array.from(ids, (x) => (x >= 0 ? Math.floor(x / 9) : -1));
        const cost = new Float32Array(54);
        for (let c = 0; c < 9; c++) if (labels[c] >= 0) for (let k = 0; k < 6; k++) cost[c * 6 + k] = k === labels[c] ? 0 : mis;
        const idCost = Float32Array.from(ids, (x) => (x >= 0 ? idc : 0));
        return { slot: f.slot, cost, labels, ids, idCost };
      })
      .filter((f): f is NonNullable<typeof f> => !!f);
    if (!faces.length) continue;
    const key = faces.map((f) => `${f.slot}:${Array.from(f.ids).join(",")}`).join("|");
    if (key === lastKey) {
      lastT = r.t;
      continue;
    }
    lastKey = key;
    out.push({ t: r.t, tPrevEnd: lastT, faces });
    lastT = r.t;
  }
  return out;
}

it("精密解析の解き直しを比べる", () => {
  const dir = process.env.DB_DIR;
  if (!dir) return;
  const refDir = process.env.DB_REF!;
  const cases = process.env.DB_CASES ? process.env.DB_CASES.split(",") : readdirSync(dir).filter((f) => f.endsWith(".obs.json")).map((f) => f.replace(".obs.json", ""));
  const modes = (process.env.DB_MODE ?? "both") === "both" ? ["app", "whole"] : [process.env.DB_MODE!];
  const methods = (process.env.DB_METHOD ?? "beam,anchors").split(",");
  const anch = JSON.parse(process.env.DB_ANCH ?? "{}");
  const out: string[] = [];
  for (const name of cases) {
    const b = name.slice(0, 8);
    const refName = readdirSync(refDir).find((f) => f === `${b}.MOV.ref.json` || f === `${b}.mov.ref.json`);
    if (!refName || !existsSync(`${dir}/${name}.obs.json`)) continue;
    const ref = JSON.parse(readFileSync(`${refDir}/${refName}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
    const rawObs = JSON.parse(readFileSync(`${dir}/${name}.obs.json`, "utf8")) as { start: number[]; lastT: number; obs: RawObs[] };
    const reads = JSON.parse(readFileSync(`${dir}/${name}.read.json`, "utf8")) as { readings: { t: number; faces: { slot: number; ids: number[] }[] }[] };
    const allObs: Observation[] = rawObs.obs.map((o) => ({
      ...o,
      faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
    }));
    const refStart = Uint8Array.from(ref.startState ?? rawObs.start);
    for (const mode of modes) {
      if (mode === "app" && SOLVE_START[b] === undefined) continue;
      let start: CubeState = Uint8Array.from(rawObs.start);
      let want = ref.moves.map((m) => m.move);
      let t0 = -Infinity;
      if (mode === "app") {
        const k = SOLVE_START[b];
        let s: CubeState = refStart;
        for (let i = 0; i < k; i++) s = applyMove(s, ref.moves[i].move);
        start = s;
        want = want.slice(k);
        t0 = ref.moves[k].start - 1500;
      } else if (!statesEqual(start, refStart)) out.push(`  （${name}: 始まりの状態が正解と違う）`);
      const obs = allObs.filter((o) => o.t >= t0);
      const sights = reads.readings.filter((r) => r.t >= t0);
      const end = solvedState();
      const wantC = canonical(want);
      for (const method of methods) {
        const a = performance.now();
        let moves: number[];
        let solved: boolean;
        let inferred = 0;
        let info = "";
        if (method === "frames") {
          // DB_FRAMES='{"minW":0.85,"mis":2,"idc":2}'
          const fo = { minW: 0.85, mis: 2, idc: 2, ...JSON.parse(process.env.DB_FRAMES ?? "{}") };
          const fobs = frameObservations(reads.readings as never, t0, fo.minW, fo.mis, fo.idc);
          const r = beamDecode(fobs, start, end, rawObs.lastT);
          const wrongStart = r.startState && !statesEqual(r.startState, start);
          moves = r.moves.map((m) => m.move);
          solved = r.reachedEnd && !wrongStart;
          inferred = r.moves.filter((m) => m.inferred).length;
          info = `${r.method}${wrongStart ? "・始まりが違う" : ""}・観測 ${fobs.length}（元 ${obs.length}）`;
        } else if (method === "beam") {
          const r = beamDecode(obs, start, end, rawObs.lastT);
          const wrongStart = r.startState && !statesEqual(r.startState, start);
          moves = r.moves.map((m) => m.move);
          solved = r.reachedEnd && !wrongStart;
          inferred = r.moves.filter((m) => m.inferred).length;
          info = `${r.method}${wrongStart ? "・始まりが違う" : ""}`;
        } else if (method === "verify") {
          // 今の解き直し + 確認役（exact.ts の verifyMoves）。確定のまま間違った手（正解と合わない手で推定でないもの）を数える
          const r = beamDecode(obs, start, end, rawObs.lastT);
          const wrongStart = r.startState && !statesEqual(r.startState, start);
          const ex = decodeExact(sights, start, end, JSON.parse(process.env.DB_EXACT ?? "{}"));
          const v = verifyMoves(r.moves, ex);
          moves = v.moves.map((m) => m.move);
          solved = r.reachedEnd && !wrongStart;
          inferred = v.moves.filter((m) => m.inferred).length;
          const sure = (ms: { move: number; inferred?: boolean }[]) => {
            const c = _verifyInternal.canonicalWithIndex(ms.map((m) => m.move));
            const map = _verifyInternal.alignment(c.map((x) => x.m), wantC);
            let wrong = 0;
            let ok = 0;
            c.forEach((x, i) => {
              const confirmed = x.idx.every((k) => !ms[k].inferred);
              if (!confirmed) return;
              if (map[i] < 0) wrong++;
              else ok++;
            });
            return { wrong, ok };
          };
          const b0 = sure(r.moves);
          const b1 = sure(v.moves);
          info = `${r.method}${wrongStart ? "・始まりが違う" : ""}・確認 ${ex.method}${v.agreed === null ? "（確かめられない）" : v.agreed ? "・同じ" : "・違う"}・確定で間違い ${b0.wrong} → ${b1.wrong}・確定で正しい ${b0.ok} → ${b1.ok}・確認 ${(ex.ms / 1000).toFixed(1)}秒`;
        } else if (method === "exact") {
          // DB_EXACT='{"extra":0}'（exact.ts の設定）・DB_DEBUG=1（アンカーごとの様子）
          // 正解の状態（手の番号ごと）と照らす: アンカーごとに、残った仮説の中に正解の状態があるか
          const truthStates: CubeState[] = [start];
          for (const m of want) truthStates.push(applyMove(truthStates[truthStates.length - 1], m));
          const kOf = (s: CubeState) => truthStates.findIndex((x) => statesEqual(x, s));
          const onAnchor = (a: { backward: boolean; index: number; t: number; stickers: number; hyps: { state: CubeState; moves: number[]; viol: number }[] }) => {
            const ks = a.hyps.map((h) => kOf(h.state));
            const hit = ks.findIndex((k) => k >= 0);
            process.stdout.write(`${a.backward ? "←" : "→"} ${a.index} t=${(Math.abs(a.t) / 1000).toFixed(2)} ステッカー ${a.stickers} 仮説 ${a.hyps.length} 正解 ${hit < 0 ? "なし" : `${hit} 番目（${ks[hit]} 手目）`} 一番 ${a.hyps[0].moves.length} 手 食い違い ${a.hyps[0].viol.toFixed(1)} ${a.hyps[0].moves.slice(-6).map((m) => MOVE_NAMES[m]).join(" ")}\n`);
          };
          const r = decodeExact(sights, start, end, { ...JSON.parse(process.env.DB_EXACT ?? "{}"), ...(process.env.DB_DEBUG === "2" ? { debug: (m: string) => process.stdout.write(`${m}\n`) } : process.env.DB_DEBUG === "why" ? { truth: want, debug: (m: string) => m.includes("正解") && process.stdout.write(`${m}\n`) } : process.env.DB_DEBUG ? { onAnchor } : {}) });
          moves = r.moves.map((m) => m.move);
          solved = r.reachedEnd;
          inferred = r.moves.filter((m) => m.inferred).length;
          if (process.env.DB_SHOW) process.stdout.write(`  出力 ${r.moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ")}\n  正解 ${want.map((m) => MOVE_NAMES[m]).join(" ")}\n`);
          info = `${r.method}・アンカー ${r.anchors}・前向き〜${r.forwardTo === null ? "-" : (r.forwardTo / 1000).toFixed(1)}s・後ろ向き ${r.backwardTo === null ? "-" : (r.backwardTo / 1000).toFixed(1)}s〜 ${r.reason}`;
        } else {
          const r = decodeAnchors(sights, start, end, anch);
          moves = r.moves.map((m) => m.move);
          solved = r.reachedEnd;
          inferred = r.moves.filter((m) => m.inferred).length;
          info = `${r.method}${r.uncertain ? "・決まらない所あり" : ""}・アンカー ${r.anchors}・前向き〜${r.forwardTo === null || r.forwardTo === undefined ? "-" : (r.forwardTo / 1000).toFixed(1)}s ${r.reason ?? ""}`;
        }
        const ms = performance.now() - a;
        const dist = editDistance(canonical(moves), wantC);
        const line = `${name.padEnd(20)} ${mode.padEnd(5)} ${method.padEnd(7)} ${solved ? "完成" : "未完"} 推定 ${String(inferred).padStart(2)} 距離 ${String(dist).padStart(3)}/${wantC.length} ${(ms / 1000).toFixed(1).padStart(5)}秒 ${info}`;
        out.push(line);
        process.stdout.write(`${line}\n`);
        if (process.env.DB_OUT) appendFileSync(process.env.DB_OUT, `${JSON.stringify({ name, mode, method, solved, inferred, dist, n: wantC.length, ms, info })}\n`);
      }
    }
  }
  console.log(out.join("\n"));
}, 36000000);
