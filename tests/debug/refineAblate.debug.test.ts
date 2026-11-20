// 精密解析の認識の設定を変えた結果（realVideo.debug.test.ts の REAL_REF を、名前.設定.ref.json で書き出したもの）を、正解
// （buildTruth.debug.test.ts の BT_OUT）と比べる: ソルブの部分の手順の違い（まとめた形の編集距離）・推定した手・タイムの両端の誤差
// （正解の時刻は粗いので、設定 RA_BASE の結果との差も出す）・1 フレームの時間と解き直しの時間（ログから）。
//   RA_DIR=abl RA_TRUTH=truth npx vitest run -c vitest.debug.config.ts tests/debug/refineAblate.debug.test.ts --silent=false
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { canonicalMoves } from "../../src/track/exact";

type M = { move: number; start: number; end: number; inferred?: boolean };

function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

it("精密解析の設定の比較", () => {
  const dir = process.env.RA_DIR;
  const tdir = process.env.RA_TRUTH;
  if (!dir || !tdir) return;
  const files = readdirSync(dir).filter((x) => x.endsWith(".ref.json"));
  const tags = [...new Set(files.map((f) => f.split(".")[1]))].sort();
  const base = process.env.RA_BASE ?? "base";
  const rows: string[] = [];
  const agg = new Map<string, { n: number; wrong: number; dist: number; inferred: number; frameMs: number; decodeMs: number; dS: number; dE: number; nD: number }>();
  for (const tag of tags) {
    for (const tf of readdirSync(tdir).filter((x) => x.endsWith(".ref.json")).sort()) {
      const name = tf.replace(".ref.json", "");
      const file = `${dir}/${name}.${tag}.ref.json`;
      if (!existsSync(file)) continue;
      const truth = JSON.parse(readFileSync(`${tdir}/${tf}`, "utf8")) as { moves: M[]; solveStart: number };
      const res = JSON.parse(readFileSync(file, "utf8")) as { moves: M[]; method?: string; solved?: boolean };
      const solve = res.moves.filter((m) => m.start >= truth.solveStart - 300);
      const d = editDistance(canonicalMoves(solve.map((m) => m.move)), canonicalMoves(truth.moves.map((m) => m.move)));
      const log = existsSync(file.replace(".ref.json", ".log")) ? readFileSync(file.replace(".ref.json", ".log"), "utf8") : "";
      const frameMs = Number(/精密解析 ([\d.]+)ms\/フレーム/.exec(log)?.[1] ?? Number.NaN);
      const decodeMs = Number(/解き直し (\d+)ms/.exec(log)?.[1] ?? Number.NaN);
      const quality = tag.split("-")[0];
      const bfile = `${dir}/${name}.${quality}-${base.replace(/^.*-/, "")}.ref.json`;
      let ds = Number.NaN;
      let de = Number.NaN;
      if (existsSync(bfile) && solve.length) {
        const b = (JSON.parse(readFileSync(bfile, "utf8")) as { moves: M[] }).moves.filter((m) => m.start >= truth.solveStart - 300);
        if (b.length) {
          ds = solve[0].start - b[0].start;
          de = solve[solve.length - 1].end - b[b.length - 1].end;
        }
      }
      const inferred = solve.filter((m) => m.inferred).length;
      rows.push(`${tag.padEnd(12)} ${name} 違い ${d}・推定 ${inferred}・${res.method ?? "?"} | 1 フレーム ${frameMs}ms・解き直し ${decodeMs}ms | ${base} との差 開始 ${ds.toFixed(0)}ms・終了 ${de.toFixed(0)}ms`);
      const a = agg.get(tag) ?? { n: 0, wrong: 0, dist: 0, inferred: 0, frameMs: 0, decodeMs: 0, dS: 0, dE: 0, nD: 0 };
      a.n++;
      if (d) a.wrong++;
      a.dist += d;
      a.inferred += inferred;
      a.frameMs += frameMs;
      a.decodeMs += decodeMs;
      if (Number.isFinite(ds)) {
        a.dS += Math.abs(ds);
        a.dE += Math.abs(de);
        a.nD++;
      }
      agg.set(tag, a);
    }
  }
  rows.push("まとめ（設定ごと）");
  for (const [tag, a] of agg)
    rows.push(
      `${tag.padEnd(12)} ${a.n} 本・正解と違う ${a.wrong} 本（距離の和 ${a.dist}）・推定 ${a.inferred} 手 | 1 フレーム 平均 ${(a.frameMs / a.n).toFixed(1)}ms・解き直し 平均 ${(a.decodeMs / a.n / 1000).toFixed(1)} 秒 | 基準との時刻の差 平均 開始 ${(a.dS / Math.max(1, a.nD)).toFixed(0)}ms・終了 ${(a.dE / Math.max(1, a.nD)).toFixed(0)}ms`,
    );
  console.log(rows.join("\n"));
});
