// 精密解析の解き直しを、書き出した観測と読み（realVideo.debug.test.ts の REAL_OBS・REAL_RREADINGS、REAL_OBS_ONLY=1 で作る）で比べる。
// 正解は原画質の精密解析の手順（bm/<動画>.ref.json）。手順は rescore.ts の canonical（同じ面をまとめ、反対の面の順番をそろえる）で比べる。
//   DB_DIR=dump DB_REF=bm npx vitest run -c vitest.debug.config.ts tests/debug/decodeBench.debug.test.ts --silent=false
//   DB_CASES=IMG_5046_1500k_60,…（省略時は DB_DIR の全部）・DB_MODE=whole|app|both・DB_METHOD=beam,anchors
//   DB_OUT=結果.json（行を足していく）・DB_ANCH='{"keep":12}'（anchors.ts の設定）
// app: 本体のタイマーと同じく、ソルブだけ（インスペクションの終わり近くから、正解のその時の状態で始める）。whole: 動画の最初から（速く崩す所も含む）
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, applyMove, solvedState, statesEqual } from "../../src/cube/model";
import { decodeAnchors } from "../../src/track/anchors";
import { DEFAULT_OFFLINE, type OfflineResult, decodeOffline } from "../../src/track/offline";
import { canonical } from "../../src/track/rescore";
import type { Observation } from "../../src/track/types";

type RawObs = Omit<Observation, "faces"> & { faces: { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] }[] };
// ソルブの始まり（正解の手の番号。その前に長い間がある = インスペクション）
const SOLVE_START: Record<string, number> = { IMG_4972: 0, IMG_5046: 32, IMG_5047: 35, IMG_5048: 79, IMG_5049: 29 };

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
  const dec = { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder };
  let off = decodeOffline(obs, start, end, lastT, { decoder: dec, backwardMs: 30000 });
  if (off.method !== "meet" && off.method !== "backward") {
    const deep = decodeOffline(obs, start, end, lastT, { decoder: { ...dec, beamWidth: 256, maxMovesPerStep: 4 }, backwardMs: 60000 });
    const guessed = (r: OfflineResult) => r.moves.filter((m) => m.inferred).length;
    if (deep.reachedEnd && (!off.reachedEnd || guessed(deep) < guessed(off) || (guessed(deep) === guessed(off) && deep.method === "meet"))) off = deep;
  }
  return off;
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
        if (method === "beam") {
          const r = beamDecode(obs, start, end, rawObs.lastT);
          const wrongStart = r.startState && !statesEqual(r.startState, start);
          moves = r.moves.map((m) => m.move);
          solved = r.reachedEnd && !wrongStart;
          inferred = r.moves.filter((m) => m.inferred).length;
          info = `${r.method}${wrongStart ? "・始まりが違う" : ""}`;
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
