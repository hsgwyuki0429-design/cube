// 手順の総合評価（ライブと精密解析、機能ごとに外したもの）。ランダムな 10 手を、視点・距離・縦横・持つ指・手ぶれ・回す速さを
// 変えた 30fps の合成映像で回し、どの設定でも同じフレームを処理して比べる（描くのが重いので 1 回だけ描く）。
//   npx vitest run -c vitest.debug.config.ts tests/debug/seqBench.debug.test.ts
//   CACHE=描いた画像を置くディレクトリ（2 回目から描かない）・LIVEK=2（実機のライブのように処理中のフレームを捨てる。処理時間の倍率。LIVE=base@2 のように設定ごとにも）・SEEDS=1-20（範囲）・SPEED=fast（約 6 手/秒）・FPS=60・ROT=1（持ち替え）・LIVE=base,notrack,…・REFINE=base,nogate,…（"" で使わない）・OUT=結果の JSON Lines の書き出し先
// 1 行 = 1 つの手順と 1 つの設定: { seed, kind, cfg, ok, got, truth, dist, start, end, ms }
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { it } from "vitest";
import { STICKERS, designOf } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, type Vec3, applyMoves, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import type { DecoderOptions } from "../../src/track/decoder";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { cellInLayer, layerAtRest } from "../../src/track/timing";
import { StillSkipper } from "../../src/vision/motion";
import { type PipelineConfig, frameReading, processFrame } from "../../src/vision/pipeline";
import { Refiner } from "../../src/vision/refine";
import { loadTestOpenCv } from "../cv";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import type { Finger } from "../render";

const LIVE_BASE: PipelineConfig = { ...STICKERS, arucoRegion: true, arucoTrack: true }; // src/app/controller.ts の pipelineConfig と同じ（精密解析にも使う）
const LIVE_ONLY: Partial<PipelineConfig> = { arucoTurn: false }; // ライブだけ（controller.liveConfig）
// decoder: 追跡のデコーダの設定（認識の設定ではない）
const LIVE: Record<string, Partial<PipelineConfig> & { decoder?: Partial<DecoderOptions> }> = {
  base: {},
  notrack: { arucoTrack: false },
  noshrink: { arucoShrink: false },
  noregion: { arucoRegion: false },
  nofill: { arucoColorFill: false },
  noidtrack: { arucoIdTrack: false },
  turn: { arucoTurn: true }, // 以前のライブ（回転途中の形も使う）
  reread9: { arucoReread: 54 },
  reread2: { arucoReread: 2 },
  reread4: { arucoReread: 4 }, // 以前のライブ（読めなかったマスを 4 つまで読み直す）
};
const REFINE: Record<string, { pipeline?: Partial<PipelineConfig>; gate?: boolean; still?: boolean }> = {
  base: {},
  nogate: { gate: false },
  nostill: { still: false },
  nofill: { pipeline: { arucoColorFill: false } },
  noidtrack: { pipeline: { arucoIdTrack: false } },
  noturn: { pipeline: { arucoTurn: false } },
  noshrink: { pipeline: { arucoShrink: false } },
};

const VIEWS: { name: string; w: number; h: number; eye: Vec3 }[] = [
  { name: "near", w: 1280, h: 960, eye: [2.4, 2.4, 5.5] },
  { name: "far", w: 1280, h: 960, eye: [3, 2.6, 8.5] },
  { name: "tall", w: 720, h: 1280, eye: [1.5, 3, 8] },
  { name: "oblique", w: 1280, h: 720, eye: [4.2, 2, 4.8] },
  { name: "low", w: 1280, h: 720, eye: [1.8, 1.2, 6.5] },
];

function rng(seed: number) {
  let s = seed * 2654435761 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 視点を縦の軸のまわりに回す
const orbit = (e: Vec3, a: number): Vec3 => [e[0] * Math.cos(a) + e[2] * Math.sin(a), e[1], -e[0] * Math.sin(a) + e[2] * Math.cos(a)];

// 編集距離（手の名前の並び）
function dist(a: string[], b: string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function scene(seed: number) {
  const r = rng(seed);
  const view = VIEWS[seed % VIEWS.length];
  const moves: number[] = [];
  while (moves.length < 10) {
    const m = Math.floor(r() * 18);
    const prev = moves[moves.length - 1];
    if (prev !== undefined && Math.floor(prev / 3) === Math.floor(m / 3)) continue;
    moves.push(m);
  }
  // 手ごとの回し始めと回す時間（速い手・ゆっくりの手・間の長さが混ざる）
  const lead = 300;
  const timing: { start: number; dur: number }[] = [];
  let t = lead;
  const fast = process.env.SPEED === "fast"; // 約 6 手/秒（速いソルブ）。既定は約 2.5 手/秒
  // ROT=1: 手の間に時々キューブ全体を縦の軸のまわりに 90° 回す（持ち替え: y・y'）。カメラをキューブのまわりに回して描く
  const rotations: { start: number; dur: number; dir: number }[] = [];
  for (let i = 0; i < moves.length; i++) {
    const dur = fast ? 70 + r() * 70 : 110 + r() * 150;
    timing.push({ start: t, dur });
    t += dur + (fast ? r() * 120 : 60 + r() * 300);
    if (process.env.ROT && i < moves.length - 1 && r() < 0.3) {
      const d = 220 + r() * 200;
      rotations.push({ start: t, dur: d, dir: r() < 0.5 ? 1 : -1 });
      t += d + 80 + r() * 150;
    }
  }
  const endT = t + 400;
  const fingerPhase = r() * 10;
  const wobble = 0.05 + r() * 0.15;
  return { seed, view, moves, timing, rotations, endT, fingerPhase, wobble, alg: moves.map((m) => MOVE_NAMES[m]).join(" ") };
}

it("手順の総合評価", async () => {
  const cv = await loadTestOpenCv();
  const [from, to] = (process.env.SEEDS ?? "1-10").split("-").map(Number);
  const liveNames = (process.env.LIVE ?? Object.keys(LIVE).join(",")).split(",").filter(Boolean);
  const refineNames = (process.env.REFINE ?? Object.keys(REFINE).join(",")).split(",").filter(Boolean);
  const design = designOf(STICKERS.arucoDesign);
  for (let seed = from; seed <= (to ?? from); seed++) {
    const sc = scene(seed);
    const { w, h, eye } = sc.view;
    // 名前@k: 実機のライブのように、Worker が処理している間（処理時間 × k）に来たフレームは捨てる（k はスマホが Node より遅い分）
    const lives = liveNames.map((name) => ({
      name,
      // 名前@fN: 1 秒 N 枚に固定して処理する（処理時間によらない。低い fps での崩れ方を比べる）
      k: name.split("@")[1]?.startsWith("f") ? 0 : Number(name.split("@")[1] ?? process.env.LIVEK ?? 0),
      every: name.split("@")[1]?.startsWith("f") ? 1000 / Number(name.split("@")[1].slice(1)) : 0,
      cfg: { ...LIVE_BASE, ...LIVE_ONLY, ...LIVE[name.split("@")[0]] },
      memory: {},
      engine: new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER, decoder: LIVE[name.split("@")[0]].decoder ?? {} }),
      ms: 0,
      busyUntil: -Infinity,
      processed: 0,
      spent: [] as number[],
    }));
    const refines = refineNames.map((name) => ({
      name,
      still: REFINE[name].still === false ? null : new StillSkipper(),
      refiner: new Refiner(cv as never, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline: { ...LIVE_BASE, ...REFINE[name].pipeline }, gate: REFINE[name].gate !== false }),
      ms: 0,
    }));
    let st = solvedStickers();
    let done = 0;
    const pitch = (75 * Math.min(w, h)) / 960 / (eye[2] / 5.5);
    let renderMs = 0;
    const shiftMemory = {};
    const FPS = Number(process.env.FPS ?? 30);
    for (let t = 0; t <= sc.endT; t += 1000 / FPS) {
      while (done < sc.moves.length && t >= sc.timing[done].start + sc.timing[done].dur) st = applyMoveStickers(st, sc.moves[done++]);
      const cur = sc.timing[done];
      const turning = done < sc.moves.length && t >= cur.start;
      const ph = sc.fingerPhase;
      const fingers: Finger[] = [0.42, 0.58].map((x, i) => {
        const tip: [number, number] = [w * (x + 0.04 * Math.sin(t / 380 + i + ph)), h * 0.5 + pitch * (2.4 + 0.5 * Math.sin(t / 290 + i + ph))];
        return { a: [tip[0], tip[1] + pitch * 3.5], b: tip, width: pitch * 0.85 };
      });
      // 時々、親指が正面の下の段にかかる
      if (Math.sin(t / 700 + ph) > 0.6) {
        const tip: [number, number] = [w * (0.5 + 0.08 * Math.sin(t / 500 + ph)), h * 0.5 + pitch * 1.2];
        fingers.push({ a: [tip[0] - pitch * 3, tip[1] + pitch * 3], b: tip, width: pitch * 0.9 });
      }
      const t0 = performance.now();
      const cacheFile = process.env.CACHE ? `${process.env.CACHE}/${process.env.SPEED ?? "normal"}${process.env.ROT ? "-rot" : ""}-${FPS}-${seed}-${Math.round(t)}.gz` : null;
      const img = cacheFile && existsSync(cacheFile) ? { data: new Uint8ClampedArray(gunzipSync(readFileSync(cacheFile))), width: w, height: h } : renderArucoCube(cv as never, {
        width: w,
        height: h,
        stickers: st,
        orient: 0,
        eye: orbit([eye[0] + sc.wobble * Math.sin(t / 310 + ph), eye[1] + sc.wobble * 0.6 * Math.sin(t / 470 + ph), eye[2]], sc.rotations.reduce((a, q) => a + (q.dir * Math.PI) / 2 * Math.min(1, Math.max(0, (t - q.start) / q.dur)), 0)),
        turn: turning ? { move: sc.moves[done], fraction: (t - cur.start) / cur.dur, spread: Math.min(0.3, 1000 / FPS / 2 / cur.dur) } : undefined,
        noise: 2.5,
        seed: Math.round(t) + seed * 100000,
        scheme: "unique54",
        fingers,
        design,
      });
      if (cacheFile && !existsSync(cacheFile)) writeFileSync(cacheFile, gzipSync(img.data, { level: 1 }));
      renderMs += performance.now() - t0;
      for (const l of lives) {
        if ((l.k || l.every) && t < l.busyUntil) continue;
        const a = performance.now();
        const res = processFrame(cv as never, img, t, l.cfg, l.memory);
        l.engine.push(frameReading(t, res));
        const spent = performance.now() - a;
        l.ms += spent;
        l.processed++;
        l.spent.push(spent);
        l.busyUntil = l.every ? t + l.every - 1 : t + spent * l.k - 1;
        if (process.env.LIVEDUMP && t >= Number(process.env.LIVEDUMP)) process.stdout.write(`# live ${t.toFixed(0)} ${l.engine.decoder.status} ${l.engine.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")} | obs ${l.engine.decoder.observations} cost ${l.engine.decoder.lastObservationCost.toFixed(2)} | ${res.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id) => (id < 0 ? "." : id)).join(",")}`).join(" ")}\n`);
      }
      if (process.env.SHIFTS && t <= Number(process.env.SHIFTS)) {
        const res = processFrame(cv as never, img, t, { ...LIVE_BASE, arucoThorough: true }, shiftMemory);
        process.stdout.write(`# ${t.toFixed(0).padStart(4)} ${turning ? "T" : " "} ${res.faces.map((f) => `${f.slot}:${(f.shift ?? []).map((p) => (p ? String(Math.round(Math.hypot(...p) * 100)).padStart(2) : " .")).join(" ")}`).join(" | ")}\n`);
      }
      for (const rf of refines) {
        const a = performance.now();
        for (const f of rf.still ? rf.still.next(img, t) : [{ img, t }]) rf.refiner.push(f.img, f.t);
        rf.ms += performance.now() - a;
      }
    }
    // 正解は手をまとめた形（L' R' L' = L2 R' など、同じ状態になる並び）
    const truthAlg = simplifyMoves(parseMoves(sc.alg).map((move, i) => ({ move, t: i, orient: 0 }))).map((m) => MOVE_NAMES[m.move]).join(" ");
    const truth = truthAlg.split(" ");
    // 正解: まとめた正解と同じ並び、または同じ手数で同じ状態（反対の面の手の順番が入れ替わっただけ: D' U' = U' D'）
    const correct = (got: string[]) => got.join(" ") === truthAlg || (got.length === truth.length && statesEqual(applyMoves(solvedState(), got.join(" ")), applyMoves(solvedState(), truthAlg)));
    const frames = Math.floor(sc.endT / (1000 / FPS)) + 1;
    const rows: object[] = [];
    for (const l of lives) {
      const got = simplifyMoves(l.engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]);
      rows.push({ seed, view: sc.view.name, kind: "live", cfg: l.name, ok: correct(got), dist: dist(got, truth), got: got.join(" "), truth: truthAlg, ms: l.ms / l.processed, fps: (l.processed * 1000) / sc.endT, p90: [...l.spent].sort((a, b) => a - b)[Math.floor(l.spent.length * 0.9)], max: Math.max(...l.spent) });
    }
    const target = applyMoves(solvedState(), sc.alg);
    const tStart = sc.timing[0].start;
    const tEnd = sc.timing[sc.moves.length - 1].start + sc.timing[sc.moves.length - 1].dur;
    for (const rf of refines) {
      const r0 = performance.now();
      const res = rf.refiner.result(target);
      const resultMs = performance.now() - r0;
      const got = res.moves.map((m) => MOVE_NAMES[m.move]);
      if (process.env.DUMP) {
        process.stdout.write(`# 手順 ${sc.alg}\n# 正解の時刻 ${sc.timing.map((x) => `${x.start.toFixed(0)}-${(x.start + x.dur).toFixed(0)}`).join(" ")}\n`);
        process.stdout.write(`# raw ${JSON.stringify(res.raw?.map((m) => ({ m: MOVE_NAMES[m.move], t0: Math.round(m.t0 ?? -1), t: Math.round(m.t), s: Math.round(m.start), e: Math.round(m.end) })))}\n`);
        for (const ob of rf.refiner.engine.observationLog) if (ob.t >= Number(process.env.OBS_FROM ?? 1e9) && ob.t <= Number(process.env.OBS_TO ?? 0)) process.stdout.write(`# 観測 ${ob.t.toFixed(0)} ${ob.faces.map((f) => `${f.slot}:${Array.from(f.labels).map((l) => (l < 0 ? "." : l)).join("")}${f.ids ? `[${Array.from(f.ids).join(",")}]` : ""}`).join(" ")}\n`);
        const fr = rf.refiner.engine.frames;
        for (const which of [0, (res.raw?.length ?? 1) - 1]) {
          const m = res.raw?.[which];
          if (!m) continue;
          const orient = res.moves[Math.min(which, res.moves.length - 1)].orient;
          const face = Math.floor(m.move / 3);
          const tc = sc.timing[which === 0 ? 0 : sc.moves.length - 1];
          const lines: string[] = [];
          for (let k = 1; k < fr.length; k++) {
            if (fr[k].t < tc.start - 250 || fr[k].t > tc.start + tc.dur + 350) continue;
            // 層の側面のマス: 読み（色・ID の有無・ずれ・指）
            const cells: string[] = [];
            for (const f of fr[k].faces)
              for (let cell = 0; cell < 9; cell++) {
                if (!cellInLayer(orient, f.slot, cell, face)) continue;
                const sh = f.shift?.[cell];
                const prev = fr[k - 1].faces.find((x) => x.slot === f.slot)?.shift?.[cell];
                const d = sh && prev ? Math.round(Math.hypot(sh[0] - prev[0], sh[1] - prev[1]) * 100) : null;
                cells.push(`${f.slot}${cell}${f.masked?.[cell] ? "m" : f.valid[cell] ? "" : "x"}${sh ? (d === null ? "+" : d) : "."}`);
              }
            const at = layerAtRest(fr[k], orient, face, undefined, fr[k - 1]);
            lines.push(`${fr[k].t.toFixed(0).padStart(5)} ${fr[k].t >= tc.start && fr[k].t <= tc.start + tc.dur ? "T" : " "} ${at === null ? "?" : at ? "止" : "動"} ${cells.join(" ")}`);
          }
          process.stdout.write(`# ${which === 0 ? "最初" : "最後"}の手 ${MOVE_NAMES[m.move]}:\n${lines.map((l) => `#   ${l}`).join("\n")}\n`);
        }
      }
      rows.push({
        seed,
        view: sc.view.name,
        kind: "refine",
        cfg: rf.name,
        ok: correct(got),
        dist: dist(got, truth),
        got: got.join(" "),
        truth: truthAlg,
        startErr: res.start === null ? null : res.start - tStart,
        endErr: res.end === null ? null : res.end - tEnd,
        startUncertain: res.startUncertain,
        endUncertain: res.endUncertain,
        method: res.method,
        ms: rf.ms / frames,
        resultMs,
        processed: rf.refiner.frames,
      });
    }
    for (const row of rows) {
      const line = JSON.stringify(row);
      process.stdout.write(`${line}\n`);
      if (process.env.OUT) appendFileSync(process.env.OUT, `${line}\n`);
    }
    process.stdout.write(`# seed ${seed} ${sc.view.name} 描画 ${(renderMs / frames).toFixed(0)}ms/フレーム\n`);
  }
}, 7200000);
