// 精密解析（Refiner）の 1 フレームの処理時間。合成の動画を先に作っておき、Refiner に通す部分だけを計る。
// 場面ごとに 1 フレームあたりの時間と、再構成した手順が正しいかを出す。PROFILE=1 で関数ごとの時間（node:inspector の CPU プロファイル）も。
//   npx vitest run -c vitest.debug.config.ts tests/debug/refineProfile.debug.test.ts --silent=false
//   SCENES=場面の名前（, 区切り。既定 すべて）・PROFILE=1・TOP=関数の数（既定 25）・SAVE=フォルダ（場面の途中の 1 枚を PNG で）
// 場面: color（色ステッカー・横 800×600）・color-tall / color-tall-old（縦向き 450×800 / 800×1422 = 幅を 800 にした以前の録画）・
// stickerless（ステッカーレス）・aruco / aruco-far（unique54・キューブが大きい / 小さめ。1280×960）・
// aruco-tall / aruco-tall-old（縦向き 720×1280 / 1080×1920 = 以前の録画）
import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { type CubeState, MOVE_NAMES, type Vec3, applyMoves, invertMoves, parseMoves, solvedState } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { Refiner } from "../../src/vision/refine";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import type { Finger } from "../render";
import { REFS, simulate } from "../speed";
import { writePng } from "./png";

type Img = { data: Uint8ClampedArray; width: number; height: number };
interface Scene {
  name: string;
  frames: { t: number; img: Img; hands: [number, number][][] }[];
  refiner: () => Refiner;
  target: CubeState; // 最後の状態
  truth: string; // 正しい手順
}

interface ProfNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount: number;
  children?: number[];
}

async function profile<T>(f: () => T): Promise<{ value: T; nodes: ProfNode[]; interval: number }> {
  const s = new Session();
  s.connect();
  const post = (m: string, p?: object) => new Promise<unknown>((res, rej) => s.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  const value = f();
  const { profile: p } = (await post("Profiler.stop")) as { profile: { nodes: ProfNode[]; startTime: number; endTime: number; samples: number[] } };
  s.disconnect();
  return { value, nodes: p.nodes, interval: (p.endTime - p.startTime) / 1000 / p.samples.length };
}

// 関数ごとの自分の時間と、呼んだ先を含めた時間（再帰は 1 回だけ数える）
function summarize(nodes: ProfNode[], interval: number, frames: number, top: number): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const key = (n: ProfNode) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const walk = (id: number, stack: Set<string>): number => {
    const n = byId.get(id)!;
    const k = key(n);
    let sum = n.hitCount;
    for (const c of n.children ?? []) sum += walk(c, new Set([...stack, k]));
    self.set(k, (self.get(k) ?? 0) + n.hitCount);
    if (!stack.has(k)) total.set(k, (total.get(k) ?? 0) + sum);
    return sum;
  };
  walk(nodes[0].id, new Set());
  const ms = (h: number) => ((h * interval) / frames).toFixed(1).padStart(6);
  const rows = (m: Map<string, number>) =>
    [...m.entries()]
      .filter(([k]) => !k.startsWith("(root)") && !k.startsWith("(program)") && !k.startsWith("(idle)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, v]) => `${ms(v)}ms  ${k}`)
      .join("\n");
  return `--- 呼んだ先を含めた時間（1 フレームあたり）\n${rows(total)}\n--- 自分の時間\n${rows(self)}`;
}

const TPERM = "R U R' U' R' F R2 U' R' U' R U R' F'";

function colorScene(cv: unknown, name: string, width: number, height: number, gap: number, harsh: boolean): Scene {
  const frames: Scene["frames"] = [];
  const seq = parseMoves(TPERM);
  const scene = { harshness: harsh ? ("harsh" as const) : ("real" as const), fingers: harsh ? ("heavy" as const) : ("hold" as const) };
  // 縦向きはキューブが画面の幅に収まるよう少し離す
  const eye: Vec3 | undefined = height > width ? [0.8, 4.5, 11] : undefined;
  simulate(cv as never, { seed: 3, tps: 8, fps: 60, moves: seq.length, sequence: seq, solveTo: true, width, height, gap, eye, scene, onFrame: (t, img, hands) => frames.push({ t, img: { data: img.data, width: img.width, height: img.height }, hands }) });
  return {
    name: `${name}（${gap ? "色ステッカー" : "ステッカーレス"}・${harsh ? "厳しい条件" : "実物らしい条件"}・T-perm・60fps・${width}×${height}）`,
    frames,
    target: solvedState(),
    truth: TPERM,
    refiner: () => new Refiner(cv as never, { state: Array.from(applyMoves(solvedState(), invertMoves(seq))), refs: REFS, from: 0, to: Infinity, startHint: 600 }),
  };
}

function arucoScene(cv: unknown, name: string, width: number, height: number, eye: Vec3): Scene {
  const frames: Scene["frames"] = [];
  const alg = "R U R' U' F2 D L' B";
  const truth = parseMoves(alg);
  let st = solvedStickers();
  let done = 0;
  const period = 400;
  const turnMs = 170;
  const lead = 300;
  const pitch = (75 * Math.min(width, height)) / 960 / (eye[2] / 5.5);
  for (let t = 0; t <= lead + truth.length * period + 400; t += 1000 / 30) {
    while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
    const start = lead + done * period;
    const turning = done < truth.length && t >= start;
    // 持つ指 2 本（下の面の前で少し動く）
    const fingers: Finger[] = [0.42, 0.58].map((x, i) => {
      const tip: [number, number] = [width * (x + 0.03 * Math.sin(t / 400 + i)), height * 0.5 + pitch * (2.6 + 0.3 * Math.sin(t / 300 + i))];
      return { a: [tip[0], tip[1] + pitch * 3.5], b: tip, width: pitch * 0.85 };
    });
    const img = renderArucoCube(cv as never, { width, height, stickers: st, orient: 0, eye: [eye[0] + 0.1 * Math.sin(t / 300), eye[1], eye[2]], turn: turning ? { move: truth[done], fraction: (t - start) / turnMs, spread: 0.15 } : undefined, noise: 2, seed: Math.round(t), scheme: "unique54", fingers });
    frames.push({ t, img, hands: [] });
  }
  return {
    name: `${name}（ArUco unique54・指つき・30fps・${width}×${height}）`,
    frames,
    target: applyMoves(solvedState(), truth),
    truth: alg,
    refiner: () => new Refiner(cv as never, { state: Array.from(solvedState()), refs: ARUCO_REFS, from: 0, to: Infinity, startHint: lead, pipeline: { stickers: "unique54" } }),
  };
}

const SCENES: Record<string, (cv: unknown) => Scene> = {
  color: (cv) => colorScene(cv, "color", 800, 600, 0.07, false),
  "color-tall": (cv) => colorScene(cv, "color-tall", 450, 800, 0.07, false),
  "color-tall-old": (cv) => colorScene(cv, "color-tall-old", 800, 1422, 0.07, false),
  stickerless: (cv) => colorScene(cv, "stickerless", 800, 600, 0, false),
  aruco: (cv) => arucoScene(cv, "aruco", 1280, 960, [2.4, 2.4, 5.5]),
  "aruco-far": (cv) => arucoScene(cv, "aruco-far", 1280, 960, [1.5, 3, 9]),
  "aruco-tall": (cv) => arucoScene(cv, "aruco-tall", 720, 1280, [1.5, 3, 8]),
  "aruco-tall-old": (cv) => arucoScene(cv, "aruco-tall-old", 1080, 1920, [1.5, 3, 8]),
};

it("精密解析の処理時間", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const names = process.env.SCENES ? process.env.SCENES.split(",") : Object.keys(SCENES);
  const top = Number(process.env.TOP ?? 25);
  for (const name of names) {
    const scene = SCENES[name](cv);
    if (process.env.SAVE) {
      const f = scene.frames[Math.floor(scene.frames.length * 0.4)].img;
      writePng(`${process.env.SAVE}/${name}.png`, f);
    }
    // 1 回目は JIT のため捨てる（短く）
    const warm = scene.refiner();
    for (const f of scene.frames.slice(0, 20)) warm.push(f.img, f.t, f.hands);
    const r = scene.refiner();
    const t0 = performance.now();
    let prof = "";
    if (process.env.PROFILE) {
      const { nodes, interval } = await profile(() => {
        for (const f of scene.frames) r.push(f.img, f.t, f.hands);
      });
      prof = `\n${summarize(nodes, interval, scene.frames.length, top)}`;
    } else for (const f of scene.frames) r.push(f.img, f.t, f.hands);
    const pushMs = performance.now() - t0;
    const t1 = performance.now();
    const res = r.result(scene.target);
    const resultMs = performance.now() - t1;
    const moves = res.moves.map((m) => MOVE_NAMES[m.move]).join(" ");
    process.stdout.write(
      `=== ${scene.name}: ${(pushMs / scene.frames.length).toFixed(1)}ms/フレーム（${scene.frames.length} フレーム・計 ${(pushMs / 1000).toFixed(1)}s）・解き直し ${resultMs.toFixed(0)}ms・` +
        `${moves === scene.truth ? "手順 正しい" : `手順 違う: ${moves}`}（${res.method}）${prof}\n`,
    );
  }
}, 7200000);
