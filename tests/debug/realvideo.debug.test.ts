// 実際の動画（揃った状態から回して、揃った状態に戻る）を、アプリと同じ処理（リアルタイムの追跡 + ソルブ後の精密解析）に通す。
// 始まりと終わりが揃った状態と分かっているので、再構成が完成に戻るか・手順の正味が恒等になるかで正しさを確かめられる。
//   VIDEO=/path/to/clip.mov [FPS=60] [FRONT=R] [TOP=W] npx vitest run -c vitest.debug.config.ts tests/debug/realvideo.debug.test.ts
// FRONT / TOP: 最初のフレームで正面・上に見えている色（標準配色を仮定して残りの面の色を決める）
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { it } from "vitest";
import { MOVE_NAMES, applyMoves, moveIndex, solvedState, statesEqual } from "../../src/cube/model";
import { observationCost } from "../../src/track/decoder";
import { type TrackUpdate, TrackerEngine } from "../../src/track/engine";
import { type Lab, NAMED_COLORS } from "../../src/vision/color";
import { DEFAULT_PIPELINE, type PipelineMemory, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";
import { processTracked } from "../../src/vision/roi";
import { simplifyMoves } from "../../src/track/merge";
import { Refiner } from "../../src/vision/refine";

const VIDEO = process.env.VIDEO ?? "";
const FPS = Number(process.env.FPS ?? 60);
const W = Number(process.env.WORK ?? 800);

// ffmpeg で 1 フレームずつ RGBA にして渡す（回転のメタデータは ffmpeg が適用する）
async function frames(onFrame: (data: Uint8ClampedArray, w: number, h: number, t: number) => void): Promise<void> {
  const probe = await new Promise<string>((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "json", VIDEO]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out));
  });
  const s = JSON.parse(probe).streams[0];
  const rot = Math.abs(Number(s.side_data_list?.[0]?.rotation ?? 0)) % 180 === 90;
  const sw = rot ? s.height : s.width;
  const sh = rot ? s.width : s.height;
  // アプリと同じく長辺を W に
  const sc = W / Math.max(sw, sh);
  const w = Math.round((sw * sc) / 2) * 2;
  const h = Math.round((sh * sc) / 2) * 2;
  const size = w * h * 4;
  await new Promise<void>((resolve) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", VIDEO, "-vf", `fps=${FPS},scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    let buf = Buffer.alloc(0);
    let i = 0;
    p.stdout.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= size) {
        onFrame(new Uint8ClampedArray(buf.subarray(0, size)), w, h, (i * 1000) / FPS);
        buf = buf.subarray(size);
        i++;
      }
    });
    p.on("close", () => resolve());
  });
}

// 標準配色: 白の反対は黄、赤の反対は橙、青の反対は緑。上 = 白・正面 = 赤なら右 = 青
const OPP: Record<string, string> = { W: "Y", Y: "W", R: "O", O: "R", B: "G", G: "B" };
const RIGHT_OF: Record<string, string> = { "W,R": "B", "W,G": "R", "W,O": "G", "W,B": "O" };

it("real video", async () => {
  if (!VIDEO) return;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  // 1 回目: 読めたセルの色をすべて集め、6 色に k-means で分ける（初期値は名前付きの色）。アプリではスキャンで決まる
  const labs: Lab[] = [];
  const mem1: { last: PipelineMemory | null } = { last: null };
  if (!process.env.REFS) await frames((data, w, h, t) => {
    const r = processFrame(cv, { data, width: w, height: h }, t, DEFAULT_PIPELINE, mem1, null, []);
    for (const f of r.faces) if (!f.held) f.labs.forEach((lab, i) => f.valid[i] && !f.masked[i] && labs.push(lab));
  });
  const dist = (a: Lab, b: Lab) => Math.hypot((a[0] - b[0]) / 2, a[1] - b[1], a[2] - b[2]);
  let centers: Lab[] = NAMED_COLORS.map((c) => [...c.lab] as Lab);
  let counts: number[] = [];
  for (let it = 0; it < 20; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const l of labs) {
      let bi = 0;
      for (let i = 1; i < 6; i++) if (dist(l, centers[i]) < dist(l, centers[bi])) bi = i;
      // どの色からも遠い読み（指・背景）は使わない
      if (dist(l, centers[bi]) > 30) continue;
      acc[bi][0] += l[0];
      acc[bi][1] += l[1];
      acc[bi][2] += l[2];
      acc[bi][3]++;
    }
    centers = centers.map((c, i) => (acc[i][3] ? ([acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] as Lab) : c));
    counts = acc.map((a) => a[3]);
  }
  const named: Record<string, Lab> = {};
  NAMED_COLORS.forEach((c, i) => (named[c.id] = centers[i]));
  const sums = counts.map((n) => ({ n }));
  const top = process.env.TOP ?? "W";
  const front = process.env.FRONT ?? "R";
  const right = RIGHT_OF[`${top},${front}`] ?? "B";
  // 面の順 U R F D L B
  const ids = [top, right, front, OPP[top], OPP[right], OPP[front]];
  // REFS: 同じキューブ・照明の別の動画で求めた色（JSON、面の順 U R F D L B）。アプリではスキャンで決まる
  const refs: Lab[] = process.env.REFS ? JSON.parse(process.env.REFS) : ids.map((id) => named[id]);
  process.stdout.write(`refs ${ids.map((id, i) => `${id}=${refs[i].map(Math.round).join("/")}(${sums[NAMED_COLORS.findIndex((c) => c.id === id)].n})`).join(" ")}\n`);

  // 2 回目: リアルタイム（every 枚に 1 枚）とソルブ後の精密解析（全フレーム）
  const every = Number(process.env.EVERY ?? 2);
  // START: 始まりの状態（54 桁、既定は完成）。TARGET=none なら終わりの状態を仮定しない
  // START_MOVES / TARGET_MOVES: 完成から回した手順で、始まり・終わりの状態を指定（TARGET=none なら終わりを仮定しない）
  const fromMoves = (s?: string) => applyMoves(solvedState(), (s ?? "").split(/\s+/).filter(Boolean).map(moveIndex));
  const start = fromMoves(process.env.START_MOVES);
  const target = process.env.TARGET === "none" ? null : fromMoves(process.env.TARGET_MOVES);
  const truth = process.env.TRUTH;
  const live = new TrackerEngine(start, refs, { keepObservations: true, ...JSON.parse(process.env.ENGINE ?? "{}") } as never);
  const refiner = new Refiner(cv, { state: Array.from(start), refs, from: 0, to: Infinity });
  const mem2: { last: PipelineMemory | null } = { last: null };
  let n = 0;
  let detected = 0;
  const procMs: number[] = [];
  let last: TrackUpdate | null = null;
  const t0 = performance.now();
  await frames((data, w, h, t) => {
    const img = { data, width: w, height: h };
    if (process.env.REFINE !== "0") refiner.push(img, t);
    if (n++ % every || process.env.LIVE === "0") return;
    const pcfg = { ...DEFAULT_PIPELINE, ...JSON.parse(process.env.PIPE ?? "{}") };
    const tp0 = performance.now();
    const r = process.env.ROI === "0" ? processFrame(cv, img, t, pcfg, mem2, refs, []) : processTracked(cv, img, t, pcfg, mem2, refs, []);
    procMs.push(performance.now() - tp0);
    if (r.faces.some((f) => f.slot === 2 && !f.held)) detected++;
    const u = live.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked, alts: f.alts })) });
    if (u) last = u;
  });
  if (truth && process.env.DIAG) {
    // 観測ごとに、正解の途中の状態（と 24 通りの姿勢）のどれに最も合うか
    const seq = truth.split(/\s+/).filter(Boolean).map(moveIndex);
    const states = [start];
    for (const m of seq) states.push(applyMoves(states[states.length - 1], [m]));
    let good = 0;
    const obs = (process.env.REFINE === "0" ? live : refiner.engine).observationLog.filter((o) => o.faces.length);
    for (const o of obs) {
      const scored: { k: number; o: number; c: number }[] = [];
      states.forEach((st, k) => {
        for (let q = 0; q < 24; q++) scored.push({ k, o: q, c: observationCost(st, q, o) });
      });
      scored.sort((a, b) => a.c - b.c);
      const known = o.faces.reduce((n, f) => n + f.labels.filter((l) => l >= 0).length, 0);
      const b = scored[0];
      // 同じ状態で別の姿勢を除いた次点
      const other = scored.find((x) => x.k !== b.k) ?? b;
      if (b.c < 1.5) good++;
      process.stdout.write(`  obs t=${o.t.toFixed(0)} faces=${o.faces.map((f) => f.slot).join("")} known=${known} best k=${b.k} o=${b.o} cost=${b.c.toFixed(2)} next k=${other.k} ${other.c.toFixed(2)}\n`);
    }
    process.stdout.write(`diag: ${good}/${obs.length} observations match a true state (cost < 1.5)\n`);
  }
  const liveMoves = simplifyMoves(live.decoder.bestMoves());
  if (process.env.REFINE === "0") {
    const pm = [...procMs].sort((a, b) => a - b);
    process.stdout.write(`proc ms p50=${pm[Math.floor(pm.length / 2)]?.toFixed(0)} p90=${pm[Math.floor(pm.length * 0.9)]?.toFixed(0)} max=${pm[pm.length - 1]?.toFixed(0)}\n`);
    process.stdout.write(`frames ${n} live: detected ${detected}/${Math.ceil(n / every)} status ${live.decoder.status} reached ${target ? statesEqual(live.decoder.best().state, target) : "-"}\n  live: ${simplifyMoves(live.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move] + (m.inferred ? "?" : "") + (process.env.TIMES ? `@${Math.round(m.t)}` : "")).join(" ")}\n${truth ? `  truth: ${truth}\n` : ""}`);
    return;
  }
  const res = refiner.result(target);
  const endState = applyMoves(start, res.moves.map((m) => m.move));
  const names = (ms: { move: number; inferred?: boolean }[]) => ms.map((m) => MOVE_NAMES[m.move] + (m.inferred ? "?" : "")).join(" ");
  process.stdout.write(
    `frames ${n} live: detected ${detected}/${Math.ceil(n / every)} status ${live.decoder.status} moves ${liveMoves.length} reached ${target ? statesEqual(live.decoder.best().state, target) : "-"}\n  ${names(liveMoves)}\n` +
      `refine: method ${res.method} solved ${res.solved} moves ${res.moves.length} inferred ${res.inferred} forced ${res.forced} start ${res.start?.toFixed(0)} end ${res.end?.toFixed(0)} reached-target ${target ? statesEqual(endState, target) : "-"}\n  ${names(res.moves)}\n` +
      `  timed: ${res.moves.map((m) => `${MOVE_NAMES[m.move]}@${Math.round(m.start)}-${Math.round(m.end)}`).join(" ")}\n  ${((performance.now() - t0) / 1000).toFixed(0)}s (last update ${last ? "yes" : "no"})\n${truth ? `  truth: ${truth}\n` : ""}`,
  );
}, 3600000);
