// E2E の 1 秒ごとの処理の様子（scripts/e2e.mjs の E2E_PERF=rows.jsonl）を、ソルブ中の重さの配り方（E2E_QUERY の solveload）ごとに表にする。
//   node scripts/perf-table.mjs rows.jsonl
// 列: カメラの fps（インスペクション・ソルブ）・ライブが認識した枚数/秒（ソルブ）・録画の fps（ソルブ）・精密解析の忙しさと遅れ（止めた時）・
// 止めた後の待ち・精密解析の結果（完成・推定）
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const key = (r.query.match(/solveload=([^&]*)/)?.[1] ?? "") || "既定";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
console.log("| solveload | 回数 | カメラ fps インスペクション | カメラ fps ソルブ | ライブの認識/秒 ソルブ（主+補助） | 録画 fps ソルブ | 精密解析の忙しさ ソルブ | 止めた時の遅れ | 止めた後の待ち | 完成 | 推定 |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, rs] of groups) {
  const per = rs.map((r) => {
    const end = r.startT + (r.live ?? 0);
    const ins = r.rows.filter((x) => x.phase === "inspection");
    const sol = r.rows.filter((x) => x.phase === "solving");
    const atStop = r.rows.filter((x) => x.t <= end + 1000 && x.t >= end - 1000);
    return {
      camI: mean(ins.map((x) => x.cam)),
      camS: mean(sol.map((x) => x.cam)),
      live: mean(sol.map((x) => x.live + x.helper)),
      liveMain: mean(sol.map((x) => x.live)),
      liveHelp: mean(sol.map((x) => x.helper)),
      rec: mean(sol.map((x) => x.rec + x.recDropped)),
      busy: mean(sol.map((x) => x.refineBusy)),
      behind: Math.max(0, ...atStop.map((x) => x.behind)),
      wait: r.waitMs,
      done: r.analysis === "done" ? 1 : 0,
      inferred: r.inferred ?? 0,
    };
  });
  const m = (k) => mean(per.map((p) => p[k]));
  console.log(
    `| ${key} | ${rs.length} | ${f(m("camI"))} | ${f(m("camS"))} | ${f(m("live"))}（${f(m("liveMain"))}+${f(m("liveHelp"))}） | ${f(m("rec"))} | ${f(m("busy") * 100, 0)}% | ${f(m("behind") / 1000, 1)} 秒 | ${f(m("wait") / 1000, 1)} 秒 | ${per.filter((p) => p.done).length}/${per.length} | ${per.map((p) => p.inferred).join("・")} |`,
  );
}
