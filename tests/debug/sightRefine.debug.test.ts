// 新しい追跡器（src/track/sight/tracker.ts）を精密解析として使う: 精密解析の読み（REAL_RREADINGS: *_orig.read.json）をソルブの部分だけ
// 前向きに通し、最後は揃った状態の仮説を選ぶ（なければ 3 手まで足す）。正解（buildTruth.debug.test.ts の BT_OUT）と、今の精密解析の
// 結果（*_orig.ref.json のソルブの部分）を、まとめた形（canonicalMoves）の手順の違い（編集距離）で比べる。
//   SF_DIR=dump SF_TRUTH=truth npx vitest run -c vitest.debug.config.ts tests/debug/sightRefine.debug.test.ts --silent=false
//   SF_OPT='{"beam":256}'
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, solvedState } from "../../src/cube/model";
import { canonicalMoves } from "../../src/track/exact";
import { decodeSight } from "../../src/track/sight/offline";

function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

type Face = { slot: number; ids: number[]; w?: number[]; rot?: number[]; held?: boolean };

it("新しい追跡器で精密解析", () => {
  const dir = process.env.SF_DIR;
  const tdir = process.env.SF_TRUTH;
  if (!dir || !tdir) return;
  const opt = { beam: 256, expand: 32, depth: 3, deepHyps: 8, deepDepth: 4, snap: false, recover: false, ...JSON.parse(process.env.SF_OPT ?? "{}") };
  for (const f of readdirSync(tdir).filter((x) => x.endsWith(".ref.json")).sort()) {
    const name = f.replace(".ref.json", "");
    if (!existsSync(`${dir}/${name}_orig.read.json`)) continue;
    const truth = JSON.parse(readFileSync(`${tdir}/${f}`, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState: number[]; solveStart: number };
    const ref = JSON.parse(readFileSync(`${dir}/${name}_orig.ref.json`, "utf8")) as { moves: { move: number; start: number; end: number }[] };
    const { readings } = JSON.parse(readFileSync(`${dir}/${name}_orig.read.json`, "utf8")) as { readings: { t: number; faces: Face[] }[] };
    const a = performance.now();
    const frames = readings.filter((r) => r.t >= truth.solveStart - 1500);
    const n = frames.length;
    const dec = decodeSight(frames, Uint8Array.from(truth.startState), solvedState(), opt);
    const fin = dec.method === "none" ? null : dec;
    const ms = performance.now() - a;
    const truthM = canonicalMoves(truth.moves.map((m) => m.move));
    const oldM = canonicalMoves(ref.moves.filter((m) => m.start >= truth.solveStart - 300).map((m) => m.move));
    const got = fin ? canonicalMoves(fin.moves.map((m) => m.move)) : [];
    const inferred = fin ? fin.moves.filter((m) => m.inferred).length : 0;
    process.stdout.write(
      `${name}: 正解 ${truthM.length} 手 | 今の精密解析 違い ${editDistance(oldM, truthM)} | 新 ${fin ? `違い ${editDistance(got, truthM)}（${got.length} 手・${fin.method}・推定 ${inferred}）` : "揃った状態に届かない"}・${n} フレーム ${(ms / 1000).toFixed(1)} 秒\n`,
    );
    if (process.env.SF_SHOW && fin) process.stdout.write(`  新 ${got.map((m) => MOVE_NAMES[m]).join(" ")}\n  正 ${truthM.map((m) => MOVE_NAMES[m]).join(" ")}\n`);
  }
}, 7200000);
