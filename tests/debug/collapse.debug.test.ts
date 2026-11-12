// 精密解析が途中から崩れる所を調べる: 書き出した観測（realVideo.debug.test.ts の REAL_OBS）を前向き・後ろ向きに解きながら、
// 一番合う仮説・候補の中に、正解（原画質の精密解析の手順）の状態があるかを観測ごとに見る。
//   CL_OBS=obs.json CL_TRUTH=ref.json npx vitest run -c vitest.debug.config.ts tests/debug/collapse.debug.test.ts --silent=false
//   CL_AROUND=3（外れた所の前後に出す観測の数）
// 正解の手の時刻は粗いので、観測の時刻の前後 CL_NEAR（既定 8）手の正解の状態のどれかなら「正解の上」とみなす
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, applyMove, inverseMove, solvedState, statesEqual } from "../../src/cube/model";
import { type Hypothesis, MoveDecoder, observationCost } from "../../src/track/decoder";
import { DEFAULT_OFFLINE, reversedObservations } from "../../src/track/offline";
import type { Observation } from "../../src/track/types";

type RawObs = Omit<Observation, "faces"> & { faces: { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] }[] };

it("精密解析が崩れる所", () => {
  const file = process.env.CL_OBS;
  if (!file) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { start: number[]; end: number[] | null; lastT: number; obs: RawObs[] };
  const truth = JSON.parse(readFileSync(process.env.CL_TRUTH!, "utf8")) as { moves: { move: number; start: number; end: number }[]; startState?: number[] };
  const obs: Observation[] = raw.obs.map((o) => ({
    ...o,
    faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
  }));
  const NEAR = Number(process.env.CL_NEAR ?? 8);
  const AROUND = Number(process.env.CL_AROUND ?? 3);
  const ref: CubeState[] = [Uint8Array.from(truth.startState ?? raw.start)];
  for (const m of truth.moves) ref.push(applyMove(ref[ref.length - 1], m.move));
  // CL_K=29: アプリと同じくソルブだけ（正解の k 手目の 1.5 秒前の観測から、正解のその時の状態で始める）
  const K = process.env.CL_K ? Number(process.env.CL_K) : null;
  const start = K === null ? Uint8Array.from(raw.start) : ref[K];
  if (K !== null) {
    const from = truth.moves[K].start - 1500;
    const kept = obs.filter((o) => o.t >= from);
    obs.length = 0;
    obs.push(...kept);
  }
  const refAt = (t: number) => truth.moves.filter((m) => m.end <= t).length; // t までに回し終えた正解の手の数（粗い）
  const options = { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder, ...JSON.parse(process.env.CL_DEC ?? "{}") };
  const out: string[] = [`観測 ${obs.length}・正解 ${truth.moves.length} 手・始まりの状態が正解と${statesEqual(start, ref[0]) ? "同じ" : "違う"}`];

  // 観測が正解の状態とどれだけ合うか（時刻の近い正解の状態のうち一番合うもの）
  const refFit = (o: Observation) => {
    const k0 = refAt(o.t);
    let best = { cost: Infinity, k: -1 };
    for (let k = Math.max(0, k0 - NEAR); k <= Math.min(ref.length - 1, k0 + NEAR); k++)
      for (let ori = 0; ori < 24; ori++) {
        const c = observationCost(ref[k], ori, o);
        if (c < best.cost) best = { cost: c, k };
      }
    return best;
  };
  const onRef = (h: Hypothesis, t: number, reverse: boolean) => {
    const k0 = refAt(t);
    for (let k = Math.max(0, k0 - NEAR); k <= Math.min(ref.length - 1, k0 + NEAR); k++) if (statesEqual(h.state, ref[k])) return k;
    return reverse ? -1 : -1;
  };
  const ids = (o: Observation) => o.faces.reduce((n, f) => n + (f.ids ? Array.from(f.ids).filter((x) => x >= 0).length : 0), 0);

  const run = (name: string, list: Observation[], init: CubeState, reverse: boolean) => {
    const dec = new MoveDecoder(init, options);
    const rows: { i: number; t: number; best: number; inBeam: number; cost: number; status: string }[] = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      dec.observe(o);
      const t = reverse ? obs[list.length - 1 - i].t : o.t; // 後ろ向きの観測は時刻を反転している（-t）ので、元の観測の時刻
      const beam = (dec as unknown as { beam: Hypothesis[] }).beam;
      const best = onRef(beam[0], t, reverse);
      let inBeam = -1;
      beam.forEach((h, r) => {
        if (inBeam < 0 && onRef(h, t, reverse) >= 0) inBeam = r;
      });
      rows.push({ i, t, best, inBeam, cost: dec.lastObservationCost, status: dec.status });
    }
    // 正解が候補から消えた最初の観測と、その前後
    // CL_AT=8.3: その時刻（秒）に一番近い観測の前後を出す（省略時は正解が候補から最初に消えた所）
    const at = process.env.CL_AT ? Number(process.env.CL_AT) * 1000 : null;
    const lost =
      at === null ? rows.findIndex((r) => r.inBeam < 0) : rows.reduce((b, r, i) => (Math.abs(r.t - at) < Math.abs(rows[b].t - at) ? i : b), 0);
    const firstOff = rows.findIndex((r) => r.best < 0);
    out.push(`\n== ${name}: 一番合う仮説が正解から外れた最初 ${firstOff < 0 ? "なし" : `${(rows[firstOff].t / 1000).toFixed(3)}s（観測 ${firstOff}）`}・正解が候補から消えた最初 ${lost < 0 ? "なし" : `${(rows[lost].t / 1000).toFixed(3)}s（観測 ${lost}）`}`);
    // 正解が候補になかった区間（続けて外れた観測のまとまり）
    const runs: string[] = [];
    for (let i = 0; i < rows.length; ) {
      if (rows[i].inBeam >= 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].inBeam < 0) j++;
      const ta = Math.min(rows[i].t, rows[j].t) / 1000;
      const tb = Math.max(rows[i].t, rows[j].t) / 1000;
      runs.push(`${ta.toFixed(2)}〜${tb.toFixed(2)}s（${j - i + 1}）`);
      i = j + 1;
    }
    out.push(`  正解が候補になかった区間: ${runs.join("・") || "なし"}`);
    const offCount = rows.filter((r) => r.inBeam < 0).length;
    out.push(`  正解が候補にない観測 ${offCount}/${rows.length}・戻ってきたか ${lost >= 0 && rows.slice(lost).some((r) => r.inBeam >= 0) ? "戻った" : "戻らない"}`);
    if (lost >= 0)
      for (let i = Math.max(0, lost - AROUND - 3); i <= Math.min(rows.length - 1, lost + AROUND); i++) {
        const r = rows[i];
        const o = list[i];
        const fit = refFit(reverse ? obs[list.length - 1 - i] : o);
        const prevT = i > 0 ? rows[i - 1].t : r.t;
        const between = Math.abs(refAt(r.t) - refAt(prevT));
        out.push(
          `  ${i === lost ? ">" : " "} ${(r.t / 1000).toFixed(3)}s 前の観測から ${Math.abs(r.t - prevT).toFixed(0)}ms・正解の手 ${between}・読めた ID ${ids(o)}・面 ${o.faces.map((f) => f.slot).join("")}・` +
            `正解の状態との矛盾 ${fit.cost.toFixed(1)}・一番合う仮説の矛盾 ${r.cost.toFixed(1)}・正解は候補の ${r.inBeam < 0 ? "外" : `${r.inBeam + 1} 位`}・${r.status}`,
        );
      }
  };
  run("前向き", obs, start, false);
  if (raw.end) run("後ろ向き", reversedObservations(obs, raw.lastT), Uint8Array.from(raw.end), true);
  // 正解の手順の、外れた辺りの手（参考）
  const near = (t: number) => truth.moves.filter((m) => Math.abs(m.end - t) < 600).map((m) => `${MOVE_NAMES[m.move]}@${(m.end / 1000).toFixed(2)}`);
  void near;
  void inverseMove;
  void solvedState;
  console.log(out.join("\n"));
}, 3600000);
