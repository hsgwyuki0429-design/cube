// 書き出した精密解析の観測（realVideo.debug.test.ts の REAL_OBS）で、解き直し（前向き + 後ろ向き + つなぐ）だけを繰り返し測る。
//   OBS_FILE=obs.json npx vitest run -c vitest.debug.config.ts tests/debug/obsReplay.debug.test.ts --silent=false
//   OBS_DEC='{"idPrune":false}'（デコーダの設定を上書き）・OBS_PROFILE=1（関数ごとの時間）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES } from "../../src/cube/model";
import { simplifyMoves } from "../../src/track/merge";
import { DEFAULT_OFFLINE, OfflineForward, decodeOffline } from "../../src/track/offline";
import type { Observation } from "../../src/track/types";
import { profile, summarize } from "./prof";

it("書き出した観測の解き直し", async () => {
  const file = process.env.OBS_FILE;
  if (!file) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { start: number[]; end: number[] | null; lastT: number; obs: (Omit<Observation, "faces"> & { faces: { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] }[] })[] };
  const obs: Observation[] = raw.obs.map((o) => ({
    ...o,
    faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
  }));
  // 本体の精密解析と同じ（src/vision/refine.ts の offlineOptions: controller.engineOptions の探索の設定 + DEFAULT_OFFLINE）
  const options = { decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder, ...JSON.parse(process.env.OBS_DEC ?? "{}") }, bridge: true, backwardMs: Number(process.env.OBS_BACK ?? Infinity) };
  const start = Uint8Array.from(raw.start);
  const end = raw.end ? Uint8Array.from(raw.end) : null;
  const run = () => {
    const a = performance.now();
    const pre = new OfflineForward(start, options);
    let evals = 0;
    for (const o of obs) {
      pre.feed(o);
      evals += pre.fwd.lastExpanded;
    }
    const b = performance.now();
    // OBS_FWD=1: 前向きだけの結果（一番の仮説が終わりの状態か・次の仮説との差・手順）
    if (process.env.OBS_FWD && end) {
      const hs = pre.fwd.hypotheses();
      const same = (s: Uint8Array) => s.every((x, i) => x === end[i]);
      const hit = hs.findIndex((h) => same(h.state));
      const other = hs.find((h) => !same(h.state));
      console.log(`前向きだけ 終わりの状態の仮説 ${hit}・一番 ${hs[0].cost.toFixed(2)}・合わない一番 ${other ? other.cost.toFixed(2) : "-"}・最後の観測のコスト ${hs[0].obsCost.toFixed(2)}`);
      if (hit >= 0) console.log(`前向きの手順 ${simplifyMoves(pre.fwd.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ")}`);
    }
    const res = decodeOffline(obs, start, end, raw.lastT, options, pre);
    const c = performance.now();
    return { res, fwdMs: b - a, backMs: c - b, evals };
  };
  const r = process.env.OBS_PROFILE ? await profile(run) : { value: run(), nodes: [], interval: 0 };
  const { res, fwdMs, backMs, evals } = r.value;
  const moves = simplifyMoves(res.moves);
  console.log(
    [
      `観測 ${obs.length}・前向き ${fwdMs.toFixed(0)}ms（評価 ${evals}）・後ろ向きとつなぐ ${backMs.toFixed(0)}ms・${res.method}・${res.reachedEnd ? "終わりまで" : "届かない"}・コスト ${res.cost.toFixed(2)}`,
      `手順（${moves.length} 手・推定 ${moves.filter((m) => m.inferred).length}） ${moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ")}`,
    ].join("\n"),
  );
  if (process.env.OBS_PROFILE) console.log(summarize(r.nodes, r.interval, 1, 25));
}, 3600000);
