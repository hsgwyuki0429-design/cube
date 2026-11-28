// ArUco ステッカーの認識と追跡の総合評価（ステッカーの中のマーカーの配置ごと: src/aruco/design.ts）。
//   A: 1 フレーム。崩した状態・向き・距離・指・ぶれの場面（tests/arucoScenes.ts）で、見えているマスのうち色が正しく分かったマス・
//      誤ったマス（ライブの設定と精密解析の設定）
//   B: 手順。30fps で 8 手回す間、持つ指が動いてマーカーを隠す。ライブの追跡と精密解析の手順が正しいか
//   C: 速い回転（120fps・約 8 手/秒・回している層のぶれ。スロー撮影の動画の解析）。精密解析の手順が正しいか
//   npx vitest run -c vitest.debug.config.ts tests/debug/arucoEval.debug.test.ts --silent=false
//   DESIGNS=standard,quad-half・PARTS=A,B,C・N=場面の数（距離ごと、既定 20）・SEEDS=手順の数（既定 4）
//   A の設定: 既定は本体と同じ（ライブ = controller.liveConfig: 面の格子で読む・色で補わない、精密 = REFINE_PIPELINE。配置は
//   stickerPipeline: 1 個の配置も専用の検出）。OLD=1 で前の比べ（DEFAULT_PIPELINE に配置だけ。1 個の配置は OpenCV）。
//   PITCHES=90,65,45,32（正面のマスの間隔 px。32 は実機で遠くから撮ったときの大きさ。後ろに足しても前の場面は変わらない）・
//   H264=5000 など（1 場面を 4 枚続けて 60fps の本体の録画と同じ形の H.264 に圧縮して戻し、4 枚目を読む。kbps）
import { spawnSync } from "node:child_process";
import { it } from "vitest";
import { designOf, stickerPipeline, stickersOf } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, type Vec3, applyMoves, parseMoves, solvedState } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { cellCenter } from "../../src/vision/layout";
import { DEFAULT_PIPELINE, frameReading, processFrame } from "../../src/vision/pipeline";
import { REFINE_PIPELINE, Refiner } from "../../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import { H, W, inPoly, makeScenes } from "../arucoScenes";
import type { Finger } from "../render";
import { loadTestOpenCv } from "../cv";

// 本体の録画と同じ形の H.264（CLAUDE.md の ffmpeg の条件。60fps）に圧縮して戻す
function h264(frames: { data: Uint8ClampedArray; width: number; height: number }[], kbps: number): { data: Uint8ClampedArray; width: number; height: number }[] {
  const { width: w, height: h } = frames[0];
  const raw = Buffer.concat(frames.map((f) => Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)));
  const br = `${kbps}k`;
  const enc = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", "60", "-i", "-", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-threads", "1", "-profile:v", "baseline", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", br, "-maxrate", br, "-bufsize", `${kbps / 2}k`, "-g", "60", "-f", "h264", "-"], { input: raw, maxBuffer: 1 << 30 });
  const dec = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "h264", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { input: enc.stdout, maxBuffer: 2 ** 32 });
  const n = w * h * 4;
  if (dec.stdout.length < n * frames.length) throw new Error(`H.264 の圧縮・復号に失敗: ${enc.stderr} ${dec.stderr}`);
  return frames.map((_, i) => ({ data: new Uint8ClampedArray(dec.stdout.buffer.slice(dec.stdout.byteOffset + i * n, dec.stdout.byteOffset + (i + 1) * n)), width: w, height: h }));
}

const colorOf = (lab: number[]) => ARUCO_REFS.findIndex((r) => r[0] === lab[0] && r[1] === lab[1] && r[2] === lab[2]);
const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;

it("ArUco の総合評価", async () => {
  const cv = await loadTestOpenCv();
  const designs = (process.env.DESIGNS ?? "standard,quad-half").split(",");
  const parts = process.env.PARTS ?? "A,B,C";
  const out: string[] = [];
  const log = (s: string) => {
    out.push(s);
    process.stdout.write(`${s}\n`);
  };

  if (parts.includes("A")) {
    const scenes = makeScenes(Number(process.env.N ?? 20), process.env.PITCHES ? process.env.PITCHES.split(",").map(Number) : undefined);
    for (const key of designs) {
      const design = designOf(key);
      // 場面の画像。H264= なら 1 場面ずつ、雑音だけ変えた REPEAT 枚を 60fps の H.264 に圧縮して戻し、最後の 1 枚を読む（止まった
      // キューブを撮り続けたときの画質。最初の 1 枚は圧縮の立ち上がりで粗い）
      const REPEAT = 8;
      const frames = scenes.map((sc, si) => {
        const img = renderArucoCube(cv, { width: W, height: H, stickers: sc.st, orient: sc.orient, eye: sc.eye, noise: 2.5, seed: si + 1, scheme: "unique54", design, fingers: sc.fingers, shake: sc.shake || undefined });
        if (!process.env.H264) return img;
        let z = si * 7919 + 13;
        const rnd = () => (z = (z * 1664525 + 1013904223) >>> 0) / 4294967296;
        const seq = Array.from({ length: REPEAT }, (_, k) => {
          if (!k) return img;
          const d = new Uint8ClampedArray(img.data);
          for (let i = 0; i < d.length; i++) if ((i & 3) !== 3) d[i] += (rnd() + rnd() + rnd() - 1.5) * 4;
          return { ...img, data: d };
        });
        return h264(seq, Number(process.env.H264))[REPEAT - 1];
      });
      const app = stickerPipeline(stickersOf(key));
      const cfgs = process.env.OLD
        ? [false, true].map((thorough) => ({ name: thorough ? "精密" : "ライブ", cfg: { ...DEFAULT_PIPELINE, arucoDesign: key, arucoThorough: thorough } }))
        : [
            { name: "ライブ", cfg: { ...DEFAULT_PIPELINE, ...app, arucoRegion: true, arucoTrack: true, arucoTurn: false, arucoGrid: true, arucoColorFill: false } },
            { name: "精密", cfg: { ...DEFAULT_PIPELINE, ...REFINE_PIPELINE, ...app, arucoThorough: true, arucoRegion: true } },
          ];
      for (const { name, cfg } of cfgs) {
        const thorough = name === "精密";
        let ms = 0;
        type Tally = { n: number; ok: number; bad: number };
        const cats = new Map<string, Tally>();
        const add = (k: string, ok: boolean, bad: boolean) => {
          const t = cats.get(k) ?? { n: 0, ok: 0, bad: 0 };
          t.n++;
          if (ok) t.ok++;
          if (bad) t.bad++;
          cats.set(k, t);
        };
        for (const [si, sc] of scenes.entries()) {
          const img = frames[si];
          const t0 = performance.now();
          const r = processFrame(cv, img, 0, { ...cfg, ...JSON.parse((thorough ? process.env.EXTRA_REFINE : process.env.EXTRA_LIVE) ?? "{}") }, {});
          ms += performance.now() - t0;
          // 読んだマス → そのマスの中心が入る本当のマス
          const read = new Map<number, number>();
          for (const f of r.faces)
            for (let cell = 0; cell < 9; cell++) {
              if (!f.valid[cell]) continue;
              const [x, y] = cellCenter(f, cell);
              const c = sc.cells.find((tc) => inPoly(tc.poly, x, y));
              if (c) read.set(c.facelet, colorOf(f.labs[cell]));
            }
          for (const c of sc.cells) {
            if (c.facing < 0.3) continue;
            const got = read.get(c.facelet);
            const ok = got === Math.floor(c.sticker / 9);
            const bad = got !== undefined && !ok;
            add("全体", ok, bad);
            add(c.occluded === 0 ? "指なし" : c.occluded <= 0.5 ? "指 〜50%" : "指 50%〜", ok, bad);
            add(`ぶれ ${sc.shake}`, ok, bad);
            add(`間隔 ${sc.pitch}px`, ok, bad);
            if (c.occluded === 0 && sc.shake === 0) add(`指なし・ぶれなし 間隔 ${sc.pitch}px`, ok, bad);
          }
        }
        for (const [k, t] of cats) log(`A ${key} ${name} ${k}: 色が正しいマス ${pct(t.ok, t.n)}・誤り ${pct(t.bad, t.n)}（${t.n}）`);
        log(`A ${key} ${name} 1 フレーム ${(ms / scenes.length).toFixed(1)}ms（前のフレームなし: 検出 + 格子）`);
      }
    }
  }

  // 指が動いてマーカーを隠しながら回す動画（fps・1 手の時間・手の間）。live: ライブの追跡も通す
  const sequence = (key: string, seed: number, o: { fps: number; turnMs: number; period: number; alg: string; live: boolean; spread: number; turn?: boolean }) => {
    const design = designOf(key);
    let s = seed * 7919;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const truth = parseMoves(o.alg);
    const SIZE = { width: 1280, height: 720 };
    const EYE: Vec3 = [2.2 + rnd() * 0.6, 2.4, 6];
    // ライブは本体と同じ設定（直前のマーカーの周りだけで検出・大きく映ったら縮める）。NOSHRINK=1 で縮めない
    const pipeline = { ...DEFAULT_PIPELINE, arucoDesign: key, arucoTurn: o.turn !== false, arucoRegion: true, arucoShrink: !process.env.NOSHRINK, arucoTrack: !process.env.NOTRACK };
    const engine = o.live ? new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER }) : null;
    const memory = {};
    const refiner = new Refiner(cv, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: 300, pipeline });
    let st = solvedStickers();
    let done = 0;
    const lead = 300;
    const phase = [rnd() * 6, rnd() * 6, rnd() * 6];
    const pitch = 70;
    for (let t = 0; t <= lead + truth.length * o.period + 400; t += 1000 / o.fps) {
      while (done < truth.length && t >= lead + done * o.period + o.turnMs) st = applyMoveStickers(st, truth[done++]);
      const start = lead + done * o.period;
      const turning = done < truth.length && t >= start;
      // 親指 2 本（下の面の前でゆっくり動く）と、ときどき横切る指
      const fingers: Finger[] = [0.42, 0.58].map((x, i) => {
        const tip: [number, number] = [SIZE.width * (x + 0.04 * Math.sin(t / 400 + phase[i])), SIZE.height * 0.5 + pitch * (2.4 + 0.4 * Math.sin(t / 300 + phase[i]))];
        return { a: [tip[0], tip[1] + pitch * 3.5], b: tip, width: pitch * 0.85 };
      });
      if (Math.sin(t / 700 + phase[2]) > 0.3) {
        const tip: [number, number] = [SIZE.width * (0.5 + 0.08 * Math.sin(t / 250)), SIZE.height * 0.5 - pitch * 0.5];
        fingers.push({ a: [tip[0] + pitch * 3, tip[1] - pitch * 2], b: tip, width: pitch * 0.8 });
      }
      const img = renderArucoCube(cv, {
        ...SIZE,
        stickers: st,
        orient: 0,
        eye: [EYE[0] + 0.1 * Math.sin(t / 300), EYE[1], EYE[2]],
        turn: turning ? { move: truth[done], fraction: Math.min(1, (t - start) / o.turnMs), spread: o.spread } : undefined,
        noise: 2,
        seed: Math.round(t) + seed * 1000,
        scheme: "unique54",
        design,
        fingers,
      });
      if (engine) {
        const r = processFrame(cv, img, t, pipeline, memory);
        engine.push(frameReading(t, r));
      }
      refiner.push(img, t);
    }
    const names = (ms: { move: number }[]) => ms.map((m) => MOVE_NAMES[m.move]).join(" ");
    const live = engine ? names(simplifyMoves(engine.decoder.bestMoves())) : "";
    const res = refiner.result(applyMoves(solvedState(), truth));
    const hints = refiner.engine.observationLog.reduce((n, ob) => n + (ob.turns?.length ?? 0), 0);
    return { live, refined: names(res.moves), truth: o.alg, hints };
  };

  const seeds = Number(process.env.SEEDS ?? 4);
  const ALGS = ["R U R' U' F2 D L' B", "F R' D2 L U' B2 R F'", "U2 L' F D' R2 B U R'", "D R2 F' U L B' D2 R'", "L F2 U' R' D B2 L' U"];
  if (parts.includes("B")) {
    for (const key of designs) {
      let live = 0;
      let refined = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const r = sequence(key, seed, { fps: 30, turnMs: 170, period: 400, alg: ALGS[(seed - 1) % ALGS.length], live: true, spread: 0.15 });
        if (r.live === r.truth) live++;
        if (r.refined === r.truth) refined++;
        if (r.live !== r.truth || r.refined !== r.truth) log(`  B ${key} seed ${seed}: 正解 ${r.truth} / ライブ ${r.live} / 精密 ${r.refined}`);
      }
      log(`B ${key} 30fps・2.5 手/秒・指: ライブの手順が正しい ${live}/${seeds}・精密解析 ${refined}/${seeds}`);
    }
  }
  // C: 240fps で撮った動画を 120fps で解析（露光 4ms 程度のぶれ）。回転途中の形状認識の手がかりあり・なし
  if (parts.includes("C")) {
    for (const key of designs) {
      for (const turn of [false, true]) {
        let refined = 0;
        let hints = 0;
        for (let seed = 1; seed <= seeds; seed++) {
          const r = sequence(key, seed, { fps: 120, turnMs: 90, period: Number(process.env.PERIOD ?? 115), alg: ALGS[(seed - 1) % ALGS.length], live: false, spread: 0.05, turn });
          hints += r.hints;
          if (r.refined === r.truth) refined++;
          else log(`  C ${key} 形状${turn ? "あり" : "なし"} seed ${seed}: 正解 ${r.truth} / 精密 ${r.refined}`);
        }
        log(`C ${key} 120fps・約 9 手/秒・指・形状認識${turn ? "あり" : "なし"}: 精密解析の手順が正しい ${refined}/${seeds}（手がかり ${hints}）`);
      }
    }
  }
  process.stdout.write(`\n==== まとめ\n${out.filter((l) => !l.startsWith("  ")).join("\n")}\n`);
}, 7200000);
