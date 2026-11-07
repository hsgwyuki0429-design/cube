// 実際のプレイ動画（iPhone などで撮った .MOV / .mp4）を、本体のライブの認識・追跡と精密解析に通す。
// 動画は ffmpeg で長辺 1280 に縮めて 1 フレームずつ読む（時刻は動画のフレームの時刻）。
//   REAL_VIDEO=path/to/IMG_4970.MOV npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false
//   REAL_START="スクランブル"（省略時は揃った状態から。"?" ならライブの認識の観測を、揃った終わりから後ろ向きに解いて推定する）・
//   REAL_TRUTH="正解の手順"（あれば照合）・REAL_FROM/REAL_TO（秒）・REAL_END=solved（最後は揃った状態。T-perm 2 回など）・
//   REAL_DUMP=1（フレームごとの読み・合わない観測・作り変え）・REAL_REFINE=0（精密解析を省く）・REAL_SAVE=フォルダ（REAL_SAVE_AT 秒の
//   フレームを PNG で）・REAL_LIVE='{"arucoColorFill":true}' など（ライブの認識の設定を上書き）
import { spawn, spawnSync } from "node:child_process";
import { it } from "vitest";
import { STICKERS } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, applyMoves, inverseMove, isSolved, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { MoveDecoder } from "../../src/track/decoder";
import { TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { DEFAULT_OFFLINE, reversedObservations } from "../../src/track/offline";
import { liveStats } from "../../src/vision/arucoFrame";
import { frameReading, processFrame } from "../../src/vision/pipeline";
import { Refiner } from "../../src/vision/refine";
import { loadTestOpenCv } from "../cv";
import { writePng } from "./png";

const LONG = 1280;
type Img = { data: Uint8ClampedArray; width: number; height: number };

it("実際のプレイ動画", async () => {
  const file = process.env.REAL_VIDEO;
  if (!file) return;
  const cv = await loadTestOpenCv();
  // 大きさと回転
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const [sw, sh] = probe;
  const s = LONG / Math.max(sw, sh);
  const W = Math.round((sw * s) / 2) * 2;
  const H = Math.round((sh * s) / 2) * 2;
  // フレームの時刻（秒）
  const times = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 })
    .stdout.trim()
    .split("\n")
    .map((l) => Number.parseFloat(l)); // 行の終わりに "," が付く
  const from = Number(process.env.REAL_FROM ?? 0);
  const to = Number(process.env.REAL_TO ?? Infinity);
  // 動画を 1 フレームずつ読む（時刻 ms）
  const readFrames = async (each: (img: Img, t: number) => void) => {
    const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    const size = W * H * 4;
    let buf = Buffer.alloc(0);
    let k = 0;
    for await (const chunk of proc.stdout) {
      buf = Buffer.concat([buf, chunk as Buffer]);
      while (buf.length >= size) {
        const data = new Uint8ClampedArray(buf.subarray(0, size));
        buf = buf.subarray(size);
        const t = (times[k] ?? k / 60) * 1000;
        k++;
        if (t < from * 1000 || t > to * 1000) continue;
        each({ data, width: W, height: H }, t);
      }
    }
  };
  // 本体のライブの認識（controller.liveConfig）。REAL_LIVE='{"arucoGrid":false}' などで上書き
  const liveCfg = { ...STICKERS, arucoRegion: true, arucoTrack: true, arucoTurn: false, arucoGrid: true, arucoColorFill: false, ...JSON.parse(process.env.REAL_LIVE ?? "{}") };

  let start = solvedState();
  if (process.env.REAL_START === "?") {
    // スクランブルが分からない: ライブの認識で観測を集め、揃った終わりから後ろ向きに解いて始まりの状態を推定する
    const pre = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER, keepObservations: true });
    const mem = {};
    let lastT = 0;
    await readFrames((img, t) => {
      pre.push(frameReading(t, processFrame(cv as never, img, t, liveCfg, mem)));
      lastT = t;
    });
    const bwd = new MoveDecoder(solvedState(), DEFAULT_OFFLINE.decoder);
    for (const o of reversedObservations(pre.observationLog.filter((o) => o.faces.length), lastT)) bwd.observe(o);
    start = Uint8Array.from(bwd.best().state);
    const back = bwd.bestMoves().map((m) => MOVE_NAMES[inverseMove(m.move)]).reverse();
    console.log(`後ろ向きに解いた始まりの状態（その後の手 ${back.length} 手: ${back.join(" ")}）・${bwd.status}・観測 ${pre.observationLog.length}`);
  } else if (process.env.REAL_START) start = applyMoves(solvedState(), process.env.REAL_START);

  const live = new TrackerEngine(start, ARUCO_REFS, { observer: ARUCO_OBSERVER, decoder: { priorWeight: 0, confirmMargin: 1 }, snapToView: true });
  const liveMemory = {};
  const refiner = process.env.REAL_REFINE === "0" ? null : new Refiner(cv as never, { state: Array.from(start), refs: ARUCO_REFS, from: from * 1000, to: to * 1000, pipeline: { ...STICKERS } });
  Object.assign(liveStats, { tracked: 0, gridded: 0, partial: 0, detected: 0, last: "" });
  let liveMs = 0;
  let refineMs = 0;
  let frames = 0;
  const cells: number[] = [];
  const faces: number[] = [];
  let lastBase = 0;
  const saveAt = Number(process.env.REAL_SAVE_AT ?? -1);
  const dump = !!process.env.REAL_DUMP;
  await readFrames((img, t) => {
    if (process.env.REAL_SAVE && Math.abs(t / 1000 - saveAt) < 0.009) writePng(`${process.env.REAL_SAVE}/frame-${saveAt}.png`, img);
    const a = performance.now();
    const r = processFrame(cv as never, img, t, liveCfg, liveMemory);
    const u = live.push(frameReading(t, r));
    liveMs += performance.now() - a;
    frames++;
    faces.push(r.faces.length);
    cells.push(r.faces.reduce((n, f) => n + f.valid.filter(Boolean).length, 0));
    // 一番合う仮説の状態で見えるはずの色（facelet → 面）
    const best = live.decoder.best();
    const want = best.state;
    const o = best.orient;
    if (dump && u && u.obsCost >= 1.4) {
      const cell = (slot: number, c: number, l: number) => (l < 0 ? "." : l === want[VIEW[(o * 6 + slot) * 9 + c]] ? "URFDLB"[l] : `${"URFDLB"[l]}≠${"URFDLB"[want[VIEW[(o * 6 + slot) * 9 + c]]]}`);
      const raw = r.faces.map((f) => `${f.slot}:${f.labs.map((_, c) => (f.valid[c] ? ((f.ids?.[c] ?? -1) >= 0 ? "i" : "c") : ".")).join("")}`).join(" ");
      process.stdout.write(`? 観測 ${u.obsCost.toFixed(1)}: ${u.observation.faces.map((f) => `${f.slot}:${f.labels.map((l, c) => cell(f.slot, c, l)).join("")}`).join(" ")} 生: ${raw}\n`);
    }
    // 作り変えた仮説が一番になったとき: その状態で見えるはずの ID と、読んだ ID
    if (dump && live.base && live.base.n !== lastBase) {
      const ids = stickerIds(want);
      process.stdout.write(`! 作り変え ${live.base.n}: ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (id < 0 ? "." : id === ids[VIEW[(o * 6 + f.slot) * 9 + c]] ? id : `${id}≠${ids[VIEW[(o * 6 + f.slot) * 9 + c]]}`)).join(",")}`).join(" ")}\n`);
    }
    lastBase = live.base?.n ?? 0;
    if (dump)
      process.stdout.write(
        `# ${(t / 1000).toFixed(3)} ${liveStats.last.padEnd(8)} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id) => (id < 0 ? "." : id)).join(",")}`).join(" ")} | ${live.base?.n ?? 0}/${live.view?.n ?? 0} ${live.decoder.status} ${best.obsCost.toFixed(1)} ${live.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")}\n`,
      );
    if (refiner) {
      const b = performance.now();
      refiner.push(img, t);
      refineMs += performance.now() - b;
    }
  });
  const liveMoves = simplifyMoves(live.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
  const shown = live.view?.state ?? live.decoder.best().state;
  const out: string[] = [];
  out.push(`動画 ${file}: ${sw}×${sh} → ${W}×${H}・${frames} フレーム`);
  out.push(`面が組み立てられたフレーム ${faces.filter((n) => n > 0).length}/${frames}・平均 ${(faces.reduce((a, b) => a + b, 0) / frames).toFixed(2)} 面・読めたマス 平均 ${(cells.reduce((a, b) => a + b, 0) / frames).toFixed(1)}`);
  out.push(`ライブ ${(liveMs / frames).toFixed(1)}ms/フレーム（格子 ${liveStats.gridded}・範囲の検出 ${liveStats.partial}・検出 ${liveStats.detected}）・${live.decoder.status}`);
  out.push(`ライブの手順 ${liveMoves || "（なし）"}・最後に 3D に出した状態 ${isSolved(Uint8Array.from(shown)) ? "揃っている" : "揃っていない"}（${live.view ? `作り変え ${live.view.n} 回目・${(live.view.t / 1000).toFixed(2)}s` : "追跡の最良の仮説"}・作り変えた仮説 ${live.base ? `${live.base.n} 回目から` : "なし"}）`);
  if (refiner) {
    const r0 = performance.now();
    const end = process.env.REAL_END === "solved" ? solvedState() : process.env.REAL_END === "none" ? null : isSolved(Uint8Array.from(shown)) ? solvedState() : null;
    const res = refiner.result(end);
    out.push(`精密解析 ${(refineMs / frames).toFixed(1)}ms/フレーム・解き直し ${(performance.now() - r0).toFixed(0)}ms・${res.method}・${res.solved ? "完成まで" : "完成に届かない"}`);
    out.push(`精密解析の手順（${res.moves.length} 手） ${res.moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ")}`);
    out.push(`精密解析の時刻 開始 ${res.start === null ? "-" : (res.start / 1000).toFixed(3)}s${res.startUncertain ? "（不確か）" : ""}・終了 ${res.end === null ? "-" : (res.end / 1000).toFixed(3)}s${res.endUncertain ? "（不確か）" : ""}`);
  }
  if (process.env.REAL_TRUTH) {
    const truth = simplifyMoves(parseMoves(process.env.REAL_TRUTH).map((move, i) => ({ move, t: i, orient: 0 }))).map((m) => MOVE_NAMES[m.move]).join(" ");
    out.push(`正解 ${truth}・ライブ ${liveMoves === truth || statesEqual(applyMoves(start, liveMoves), applyMoves(start, truth)) ? "一致" : "違う"}`);
  }
  console.log(out.join("\n"));
}, 3600000);
