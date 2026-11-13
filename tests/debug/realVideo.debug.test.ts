// 実際のプレイ動画（iPhone などで撮った .MOV / .mp4）を、本体のライブの認識・追跡と精密解析に通す。
// 動画は ffmpeg で長辺 1280 に縮めて 1 フレームずつ読む（時刻は動画のフレームの時刻）。
//   REAL_VIDEO=path/to/IMG_4970.MOV npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false
//   REAL_START: "スクランブル"（省略時は揃った状態から）・"scan"（REAL_SCAN_TO 秒までの、まだ回していないフレームで読んだステッカーの ID から
//     始まりの状態を組み立てる。インスペクションでキューブを回して見せた動画）・"?"（ライブの認識の観測を揃った終わりから後ろ向きに解いて推定）
//   REAL_TRUTH="正解の手順"（あれば照合）・REAL_FROM/REAL_TO（秒）・REAL_END=solved（最後は揃った状態。T-perm 2 回など）・
//   REAL_K=4（実機のライブのように、処理している間（Node の処理時間 × K）に来たフレームは捨て、空いたら待っている 3 枚のうち動きのいちばん
//     小さいものを処理する: vision.worker.ts の pickFrame。省略時は全フレーム）・
//   REAL_FPS=6（1 秒 6 枚に固定して処理する。処理時間によらないので、設定を比べるときにぶれない）・REAL_LIVE_DEC='{"beamWidth":16}'（ライブのデコーダ）・
//   REAL_PROFILE=1（ライブが処理したフレームで関数ごとの時間）・
//   REAL_DUMP=1（フレームごとの読み・合わない観測・作り変え）・REAL_REFINE=0（精密解析を省く）・REAL_SAVE=フォルダ（REAL_SAVE_AT 秒の
//   フレームを PNG で）・REAL_REFINE_CFG='{"arucoColorFill":false}' など（精密解析の認識の設定を上書き）・REAL_LIVE='{"arucoColorFill":true}' など（ライブの認識の設定を上書き）・
//   REAL_REFINE_GATE=0（精密解析の軽い検査で飛ばさない）・REAL_REFINE_ENGINE='{"decoder":{"priorWeight":0}}' など（精密解析の追跡の設定）
//   REAL_READINGS=ファイル（ライブが処理したフレームの読みを書き出す: liveReplay.debug.test.ts で追跡だけを測る）
//   REAL_NOLIVE=1（ライブを省く）・REAL_STILL=1（精密解析で止まっているフレームを飛ばす。本体の録画の解析と同じ）・
//   REAL_ENDS=1（精密解析の最初・最後の手の時刻の詳しい内容）
//   REAL_START_FILE=ファイル（始まりの状態: JSON の startState か start）
//   REAL_RREADINGS=ファイル（精密解析が精密に処理したフレームの読み: betweenMoves.debug.test.ts）
//   REAL_OBS=ファイル（精密解析の観測を書き出す: obsReplay.debug.test.ts で解き直しだけを測る）・REAL_OBS_ONLY=1（書き出したら解き直さない）
//   REAL_REF=ファイル（精密解析の結果を書き出す。REAL_REFINE=0 なら読み込んで、ライブの一致だけ測る: ライブを直して何度も測るとき）
// 精密解析の追跡の設定は本体と同じ（controller.engineOptions: ARUCO_OBSERVER・候補 32・3 手）。
// 精密解析が完成までつながったら、その手順と時刻を本当の動きとみなして、ライブが 3D に出した状態が本当の状態と同じだった時間の割合を出す
// （手を回している間とその後 300ms は数えない）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { STICKERS } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, applyMove, applyMoves, inverseMove, isSolved, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { mostLikelyState } from "../../src/cube/pattern";
import { PARTNERS, stickerIds } from "../../src/cube/stickers";
import { MoveDecoder, observationCost } from "../../src/track/decoder";
import { TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER, type FrameReading, LIVE_OBSERVER } from "../../src/track/observer";
import { DEFAULT_OFFLINE, reversedObservations } from "../../src/track/offline";
import { liveStats } from "../../src/vision/arucoFrame";
import { type FrameResult, frameReading, processFrame } from "../../src/vision/pipeline";
import { StillSkipper } from "../../src/vision/motion";
import { sightFrame } from "../../src/track/pieces/frame";
import { type RefineResult, Refiner } from "../../src/vision/refine";
import { loadTestOpenCv } from "../cv";
import { writePng } from "./png";
import { profile, summarize } from "./prof";

const LONG = 1280;
const LAGS = [150, 300, 600]; // 遅れを許した一致で許す遅れ（ms）
const SETTLE_MS = 300; // 手を回し終えてから、ライブが追いつくのを待つ時間（一致の割合で数えない）
type Img = { data: Uint8ClampedArray; width: number; height: number };

// 動きの量（vision.worker.ts の motionOf と同じ: 64×48 の縮小画像で明るさが 25 より変わった点の数）
function thumb(img: Img): Uint8Array {
  const out = new Uint8Array(64 * 48);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 64; x++) {
      const i = ((Math.floor(((y + 0.5) * img.height) / 48) * img.width + Math.floor(((x + 0.5) * img.width) / 64)) * 4) | 0;
      out[y * 64 + x] = Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
    }
  return out;
}
const motionOf = (a: Uint8Array, b: Uint8Array | null) => {
  if (!b) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 25) n++;
  return n;
};

// 1 フレームの読みから姿勢（キューブ固定 → カメラ）を決める: 読めたセンターの ID がどれもその姿勢で見えるはずの facelet と同じこと（2 面以上）
function orientOfIds(r: FrameResult): number | null {
  const centers = r.faces.filter((f) => (f.ids?.[4] ?? -1) >= 0 && f.ids![4] % 9 === 4);
  if (centers.length < 2) return null;
  const ok: number[] = [];
  for (let o = 0; o < 24; o++) if (centers.every((f) => VIEW[(o * 6 + f.slot) * 9 + 4] === f.ids![4])) ok.push(o);
  return ok.length === 1 ? ok[0] : null;
}

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
  const readFrames = async (each: (img: Img, t: number) => void, until = to) => {
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
        if (t < from * 1000 || t > until * 1000) continue;
        each({ data, width: W, height: H }, t);
      }
      if ((times[k] ?? 0) > until) {
        proc.kill();
        break;
      }
    }
  };
  // 本体のライブの認識（controller.liveConfig）。REAL_LIVE='{"arucoGrid":false}' などで上書き
  const liveCfg = { ...STICKERS, arucoRegion: true, arucoTrack: true, arucoTurn: false, arucoGrid: true, arucoColorFill: false, ...JSON.parse(process.env.REAL_LIVE ?? "{}") };
  const out: string[] = [];

  let start = solvedState();
  // REAL_START_FILE=ファイル: 始まりの状態（JSON の startState か start。精密解析の結果・REAL_READINGS の書き出しをそのまま使える）
  if (process.env.REAL_START_FILE) {
    const j = JSON.parse(readFileSync(process.env.REAL_START_FILE, "utf8")) as { startState?: number[]; start?: number[] };
    start = Uint8Array.from((j.startState ?? j.start)!);
  } else if (process.env.REAL_START === "scan") {
    // 回し始める前のフレームで読んだステッカーの ID を、センターの ID から決めた姿勢で facelet ごとに数える
    const votes = Array.from({ length: 54 }, () => new Map<number, number>());
    const mem = {};
    let used = 0;
    await readFrames(
      (img, t) => {
        const r = processFrame(cv as never, img, t, { ...STICKERS }, mem);
        const o = orientOfIds(r);
        if (o === null) return;
        used++;
        for (const f of r.faces)
          for (let cell = 0; cell < 9; cell++) {
            const id = f.ids?.[cell] ?? -1;
            if (id < 0) continue;
            const v = votes[VIEW[(o * 6 + f.slot) * 9 + cell]];
            v.set(id, (v.get(id) ?? 0) + 1);
          }
      },
      Number(process.env.REAL_SCAN_TO ?? 5),
    );
    // facelet ごとにいちばん多い ID。その色と、同じピースのほかの facelet の色（ID から決まる）を割り当ての手がかりにする
    const top = votes.map((v) => [...v].sort((a, b) => b[1] - a[1])[0] ?? null);
    const want = new Map<number, number>();
    for (let f = 0; f < 54; f++) {
      const t = top[f];
      if (!t) continue;
      want.set(f, Math.floor(t[0] / 9));
      if (PARTNERS[f].length === PARTNERS[t[0]].length) PARTNERS[f].forEach((g, k) => want.has(g) || want.set(g, Math.floor(PARTNERS[t[0]][k] / 9)));
    }
    start = mostLikelyState((f, c) => (want.has(f) && want.get(f) !== c ? 3 : 0)).state;
    const seen = top.filter(Boolean).length;
    const ids = stickerIds(start);
    const disagree = top.filter((t, f) => t && ids[f] !== t[0]).length;
    out.push(`始まりの状態をスキャン: ${used} フレーム・読めた facelet ${seen}/54・ピースから決まった ${want.size}/54・組み立てた状態と違う読み ${disagree}`);
  } else if (process.env.REAL_START === "?") {
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
    out.push(`後ろ向きに解いた始まりの状態（その後の手 ${back.length} 手）・${bwd.status}・観測 ${pre.observationLog.length}`);
  } else if (process.env.REAL_START) start = applyMoves(solvedState(), process.env.REAL_START);

  // REAL_REF=ファイル: 精密解析の結果を書き出す（REAL_REFINE=0 なら読み込んで、ライブの一致だけ測る）
  const refFile = process.env.REAL_REF;
  const cached = process.env.REAL_REFINE === "0" && refFile && existsSync(refFile) ? (JSON.parse(readFileSync(refFile, "utf8")) as RefineResult) : null;
  // 書き出した精密解析の、時刻 t の状態と回し終えた手の数（ダンプ用）
  const refAt = (t: number) => {
    let st: Uint8Array = Uint8Array.from(start);
    let k = 0;
    for (const m of cached?.moves ?? []) {
      if (m.end > t) break;
      st = applyMove(st, m.move);
      k++;
    }
    return { st, k };
  };
  // REAL_LIVE_DEC='{"beamWidth":16}' など: ライブの追跡のデコーダの設定を上書き
  const liveDec = { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5, ...JSON.parse(process.env.REAL_LIVE_DEC ?? "{}") };
  // REAL_LIVE_OBS='{"idBoost":1}' など: ライブの観測器の設定を上書き
  const liveObs = { ...ARUCO_OBSERVER, ...LIVE_OBSERVER, ...JSON.parse(process.env.REAL_LIVE_OBS ?? "{}") };
  const live = new TrackerEngine(start, ARUCO_REFS, { observer: liveObs, decoder: liveDec, snapToView: true });
  const liveMemory = {};
  const refiner = process.env.REAL_REFINE === "0" ? null : new Refiner(cv as never, { state: Array.from(start), refs: ARUCO_REFS, from: from * 1000, to: to * 1000, ...(process.env.REAL_REFINE_GATE === "0" ? { gate: false } : {}), ...(process.env.REAL_PIECES === "0" ? { pieces: false } : {}), engine: { observer: ARUCO_OBSERVER, ...JSON.parse(process.env.REAL_REFINE_ENGINE ?? "{}"), decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...JSON.parse(process.env.REAL_REFINE_ENGINE ?? "{}").decoder } }, pipeline: { ...STICKERS, ...JSON.parse(process.env.REAL_REFINE_CFG ?? "{}") } });
  // REAL_RFRAMES=22.1-23.0: 精密解析が精密に処理したフレームの面
  // 精密解析が精密に処理したフレームの読み（ID が読めたマスの数。認識の良し悪し）
  const rstat = { frames: 0, faces: 0, ids: 0, empty: 0 };
  // REAL_RREADINGS=ファイル: 精密解析が精密に処理したフレームの読み（面と ID だけ）を書き出す（betweenMoves.debug.test.ts で、手と手の間の状態がどれだけ読めたかを測る）
  const rreadings: { t: number; faces: { slot: number; ids: number[]; w: number[]; rot?: number[]; held?: boolean; quad?: number[] }[] }[] = [];
  if (refiner && !process.env.REAL_RFRAMES)
    refiner.onFrame = (_t, r: FrameResult) => {
      if (process.env.REAL_RREADINGS) {
        // rot・held: ピースの時刻表（src/track/pieces）の材料（マーカーの向き・1 列だけの面）
        const sf = new Map(sightFrame(_t, r).faces.map((f) => [f.slot, f]));
        rreadings.push({ t: _t, faces: r.faces.map((f) => ({ slot: f.slot, ids: Array.from(f.ids ?? new Array(9).fill(-1)), w: f.weight.map((x) => Math.round(x * 100) / 100), rot: sf.get(f.slot)?.rot ?? new Array(9).fill(-1), quad: sf.get(f.slot)?.quad ?? [], ...(f.held ? { held: true } : {}) })) });
      }
      rstat.frames++;
      rstat.faces += r.faces.length;
      if (!r.faces.length) rstat.empty++;
      for (const f of r.faces) for (const id of f.ids ?? []) if (id >= 0) rstat.ids++;
    };
  if (refiner && process.env.REAL_RFRAMES) {
    const [f0, f1] = process.env.REAL_RFRAMES.split("-").map((x) => Number(x) * 1000);
    refiner.onFrame = (t, r: FrameResult) => {
      if (t >= f0 && t <= f1) process.stdout.write(`F ${(t / 1000).toFixed(3)} ${r.faces.map((f) => `${f.slot}:${f.valid.map((v, c) => (!v ? "." : (f.ids?.[c] ?? -1) >= 0 ? f.ids![c] : `*${"URFDLB"[ARUCO_REFS.findIndex((x) => x.every((y, k) => Math.abs(y - f.labs[c][k]) < 1e-6))]}`)).join(",")}`).join(" ")}\n`);
    };
  }
  Object.assign(liveStats, { tracked: 0, gridded: 0, partial: 0, detected: 0, last: "" });
  const REFINE_EVERY = Number(process.env.REAL_REFINE_EVERY ?? 1); // 精密解析に N 枚に 1 枚だけ渡す（間引いたときの正確さを見る）
  const SOLVE_FROM = Number(process.env.REAL_SOLVE_FROM ?? -Infinity);
  if (refiner && Number.isFinite(SOLVE_FROM)) refiner.setInspectUntil(SOLVE_FROM * 1000);
  let lastInspect = -Infinity;
  const still = process.env.REAL_STILL ? new StillSkipper() : null;
  let refineFrames = 0;
  const K = Number(process.env.REAL_K ?? 0);
  // REAL_FPS=6: 1 秒 N 枚に固定して処理する（処理時間によらないので、設定を比べるときに結果がぶれない）。待っている 3 枚のうち動きのいちばん小さいもの
  const FIX = Number(process.env.REAL_FPS ?? 0);
  let liveMs = 0;
  let trackMs = 0;
  let evals = 0;
  let obsN = 0;
  let refineMs = 0;
  let frames = 0;
  let processed = 0;
  let busyUntil = -Infinity;
  let pending: { img: Img; t: number; motion: number }[] = [];
  let lastThumb: Uint8Array | null = null;
  const cells: number[] = [];
  const faces: number[] = [];
  const shownLog: { t: number; state: Uint8Array }[] = [];
  let lastBase = 0;
  const saveAt = Number(process.env.REAL_SAVE_AT ?? -1);
  const dump = !!process.env.REAL_DUMP;
  const picked: { img: Img; t: number }[] = [];
  const readings: FrameReading[] = []; // REAL_READINGS=ファイル: ライブが処理したフレームの読みを書き出す（liveReplay.debug.test.ts で追跡だけを繰り返し測る）
  const liveFrame = (img: Img, t: number) => {
    if (process.env.REAL_PROFILE && picked.length < 120) picked.push({ img, t });
    const a = performance.now();
    const r = processFrame(cv as never, img, t, liveCfg, liveMemory);
    const a2 = performance.now();
    const reading = frameReading(t, r);
    if (process.env.REAL_READINGS) readings.push(reading);
    const u = live.push(reading);
    trackMs += performance.now() - a2;
    if (u) {
      evals += live.decoder.lastExpanded;
      obsN++;
    }
    const spent = performance.now() - a;
    liveMs += spent;
    processed++;
    if (FIX) busyUntil = t + 1000 / FIX - 1;
    else if (K) busyUntil = t + spent * K;
    faces.push(r.faces.length);
    cells.push(r.faces.reduce((n, f) => n + f.valid.filter(Boolean).length, 0));
    const best = live.decoder.best();
    shownLog.push({ t, state: Uint8Array.from(live.view?.state ?? best.state) });
    // 一番合う仮説の状態で見えるはずの色（facelet → 面）
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
        `# ${(t / 1000).toFixed(3)} ${cached ? `${statesEqual(refAt(t).st, live.view?.state ? Uint8Array.from(live.view.state) : best.state) ? "=" : "≠"}${String(refAt(t).k).padStart(2)} ` : ""}${liveStats.last.padEnd(8)} ${spent.toFixed(0).padStart(3)}ms ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id) => (id < 0 ? "." : id)).join(",")}`).join(" ")} | ${live.base?.n ?? 0}/${live.view?.n ?? 0} ${live.decoder.status} ${best.obsCost.toFixed(1)} ${live.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")}\n`,
      );
  };
  await readFrames((img, t) => {
    if (process.env.REAL_SAVE && Math.abs(t / 1000 - saveAt) < 0.009) writePng(`${process.env.REAL_SAVE}/frame-${saveAt}.png`, img);
    frames++;
    if (process.env.REAL_NOLIVE) {
      // ライブを省く（精密解析だけを本体と同じ条件で測るとき）
    } else if (!K && !FIX) liveFrame(img, t);
    else {
      // 実機のように: 結果の来ていないフレームは 3 枚まで（visionClient の MAX_INFLIGHT）。空いたら動きのいちばん小さいもの
      const th = thumb(img);
      pending.push({ img, t, motion: motionOf(th, lastThumb) });
      lastThumb = th;
      if (pending.length > 3) pending.shift();
      if (t >= busyUntil) {
        let best = pending[pending.length - 1];
        for (const p of pending) if (p.motion < best.motion * 0.7) best = p;
        pending = [];
        liveFrame(best.img, best.t);
      }
    }
    // REAL_SOLVE_FROM=11.4: この時刻（秒）より前はインスペクションとして 60ms に 1 枚だけ精密解析に渡す（vision.worker.ts の INSPECT_EVERY_MS）
    const inspecting = t < SOLVE_FROM * 1000;
    if (inspecting && t - lastInspect < 60) return;
    if (inspecting) lastInspect = t;
    if (refiner && frames % REFINE_EVERY === 0) {
      refineFrames++;
      const b = performance.now();
      // REAL_STILL=1: 本体の録画の解析と同じく、止まっているフレームを飛ばす（vision.worker.ts の streamFrame の StillSkipper）
      if (still) for (const f of still.next(img, t)) refiner.push(f.img, f.t);
      else refiner.push(img, t);
      refineMs += performance.now() - b;
      if (dump) {
        const d = refiner.engine.decoder;
        process.stdout.write(`R ${(t / 1000).toFixed(3)} ${d.status} ${d.lastObservationCost.toFixed(1)} obs${d.observations} ${d.bestMoves().slice(-8).map((m) => MOVE_NAMES[m.move]).join(" ")}\n`);
      }
    }
  });
  // REAL_PROFILE=1: ライブが処理したフレーム（120 枚まで）を、もう一度ライブの認識に通して関数ごとの時間を出す
  if (process.env.REAL_PROFILE && picked.length) {
    const mem = {};
    const eng = new TrackerEngine(start, ARUCO_REFS, { observer: liveObs, decoder: liveDec, snapToView: true });
    const { nodes, interval } = await profile(() => {
      for (const p of picked) eng.push(frameReading(p.t, processFrame(cv as never, p.img, p.t, liveCfg, mem)));
    });
    console.log(summarize(nodes, interval, picked.length, 30));
  }
  if (process.env.REAL_READINGS) writeFileSync(process.env.REAL_READINGS, JSON.stringify({ start: Array.from(start), readings }));
  if (process.env.REAL_RREADINGS) writeFileSync(process.env.REAL_RREADINGS, JSON.stringify({ start: Array.from(start), readings: rreadings }));
  const liveMoves = simplifyMoves(live.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
  const shown = live.view?.state ?? live.decoder.best().state;
  out.push(`動画 ${file}: ${sw}×${sh} → ${W}×${H}・${frames} フレーム（ライブが処理したのは ${processed}・1 秒 ${((processed / (frames || 1)) * 60).toFixed(1)} 枚相当）`);
  out.push(`面が組み立てられたフレーム ${faces.filter((n) => n > 0).length}/${processed}・平均 ${(faces.reduce((a, b) => a + b, 0) / processed).toFixed(2)} 面・読めたマス 平均 ${(cells.reduce((a, b) => a + b, 0) / processed).toFixed(1)}`);
  out.push(`ライブ ${(liveMs / processed).toFixed(1)}ms/フレーム（追跡 ${(trackMs / processed).toFixed(1)}ms・観測 ${obsN}・1 観測の評価 ${(evals / Math.max(1, obsN)).toFixed(0)}・格子 ${liveStats.gridded}・範囲の検出 ${liveStats.partial}・検出 ${liveStats.detected}）・${live.decoder.status}`);
  out.push(`ライブの手順 ${liveMoves || "（なし）"}・最後に 3D に出した状態 ${isSolved(Uint8Array.from(shown)) ? "揃っている" : "揃っていない"}（作り変えた仮説 ${live.base ? `${live.base.n} 回目から` : "なし"}）`);
  // REAL_OBSCHECK=22.0-23.2: 精密解析の観測を、ライブの手順（時刻つき）の状態と照らす（どの観測がライブの手順と合わないか）
  if (refiner && process.env.REAL_OBSCHECK) {
    const [c0, c1] = process.env.REAL_OBSCHECK.split("-").map((x) => Number(x) * 1000);
    const lm = live.decoder.bestMoves();
    for (const o of refiner.engine.observationLog) {
      if (o.t < c0 || o.t > c1) continue;
      let st: Uint8Array = Uint8Array.from(start);
      for (const m of lm) if (m.t <= o.t) st = applyMove(st, m.move);
      let best = { c: Infinity, o: -1 };
      for (let k = 0; k < 24; k++) {
        const c = observationCost(st, k, o);
        if (c < best.c) best = { c, o: k };
      }
      process.stdout.write(`O ${(o.t / 1000).toFixed(3)} ライブの状態で ${best.c.toFixed(1)}（姿勢 ${best.o}） ${o.faces.map((f) => `${f.slot}:${Array.from(f.ids ?? f.labels).map((x) => (x < 0 ? "." : x)).join(",")}`).join(" ")}\n`);
    }
  }
  if (refiner || cached) {
    const r0 = performance.now();
    const end = process.env.REAL_END === "solved" ? solvedState() : process.env.REAL_END === "none" ? null : isSolved(Uint8Array.from(shown)) ? solvedState() : null;
    // REAL_OBS=ファイル: 精密解析の観測を書き出す（解き直しだけを tests/debug/obsReplay.debug.test.ts で繰り返し測る）
    if (refiner && process.env.REAL_OBS) {
      const arr = (a?: ArrayLike<number>) => (a ? Array.from(a) : undefined);
      writeFileSync(process.env.REAL_OBS, JSON.stringify({ start: Array.from(start), end: end ? Array.from(end) : null, lastT: refiner.lastT, obs: refiner.engine.observationLog.map((o) => ({ ...o, faces: o.faces.map((f) => ({ slot: f.slot, cost: arr(f.cost), labels: arr(f.labels), ids: arr(f.ids), idCost: arr(f.idCost) })) })) }));
    }
    // REAL_OBS_ONLY=1: 観測と読みを書き出したら、解き直しはしない（解き直しは obsReplay で繰り返す）
    if (process.env.REAL_OBS_ONLY) {
      console.log(out.join("\n"));
      return;
    }
    const res = cached ?? refiner!.result(end);
    if (refiner && refFile) writeFileSync(refFile, JSON.stringify(res));
    if (rstat.frames) out.push(`精密解析の読み: 精密に処理した ${rstat.frames} 枚・面なし ${((100 * rstat.empty) / rstat.frames).toFixed(1)}%・平均 ${(rstat.faces / rstat.frames).toFixed(2)} 面・ID が読めたマス 平均 ${(rstat.ids / rstat.frames).toFixed(2)}`);
    out.push(`精密解析${cached ? "（書き出した結果）" : ""} ${(refineMs / frames).toFixed(1)}ms/フレーム（渡した ${refineFrames} 枚・計 ${(refineMs / 1000).toFixed(1)} 秒）・解き直し ${(performance.now() - r0).toFixed(0)}ms${refiner?.piecesMs ? `（ピースの時刻表 ${refiner.piecesMs.toFixed(0)}ms）` : ""}・${res.method}${refiner?.deepUsed ? "（2 回目の深い解き直し）" : ""}・${res.solved ? "完成まで" : "完成に届かない"}・推定した手 ${res.moves.filter((m) => m.inferred).length}`);
    out.push(`精密解析の手順（${res.moves.length} 手） ${res.moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ")}`);
    if (process.env.REAL_ENDS) out.push(`端の手: 最初 ${JSON.stringify(res.moves.slice(0, 3))} raw ${JSON.stringify(res.raw?.slice(0, 3))} / 最後 ${JSON.stringify(res.moves.slice(-2))} raw ${JSON.stringify(res.raw?.slice(-2))}`);
    out.push(`精密解析の時刻 開始 ${res.start === null ? "-" : (res.start / 1000).toFixed(3)}s${res.startUncertain ? "（不確か）" : ""}・終了 ${res.end === null ? "-" : (res.end / 1000).toFixed(3)}s${res.endUncertain ? "（不確か）" : ""}`);
    // 精密解析の手順と時刻を本当の動きとみなし、ライブが 3D に出した状態が同じだった時間の割合（回している間・その後 SETTLE_MS は除く）
    if (res.solved || !end) {
      let state: Uint8Array = Uint8Array.from(start);
      let k = 0;
      // all: 動画全体・solve: 最初の手の回し始め〜最後の手の回し終わり + 1 秒
      const acc = { all: { same: 0, counted: 0 }, solve: { same: 0, counted: 0 } };
      let worst = { from: 0, to: 0 };
      let runFrom: number | null = null;
      const s0 = res.start ?? res.moves[0]?.start ?? Infinity;
      const s1 = (res.end ?? res.moves[res.moves.length - 1]?.end ?? -Infinity) + 1000;
      for (let i = 0; i < shownLog.length; i++) {
        const { t } = shownLog[i];
        while (k < res.moves.length && res.moves[k].end <= t) state = applyMove(state, res.moves[k++].move);
        const busy = (k < res.moves.length && res.moves[k].start <= t) || (k > 0 && t - res.moves[k - 1].end < SETTLE_MS);
        if (busy) continue;
        const dt = (shownLog[i + 1]?.t ?? t) - t;
        const eq = statesEqual(state, shownLog[i].state);
        for (const [key, on] of [["all", true], ["solve", t >= s0 && t <= s1]] as const) {
          if (!on) continue;
          acc[key].counted += dt;
          if (eq) acc[key].same += dt;
        }
        if (eq) runFrom = null;
        else {
          runFrom ??= t;
          if (t + dt - runFrom > worst.to - worst.from) worst = { from: runFrom, to: t + dt };
        }
      }
      // 遅れを許した一致: 回している間も数える。時刻 t に 3D に出した状態が、t - LAG_MS から t までのどこかの本当の状態
      // （回し始めた手は回し終えたとみなしてもよい）と同じだった時間の割合。速い手順では「回していない間」がほとんどなく、上の割合は
      // 数える時間が 1 秒に満たない
      const lagged = LAGS.map((lag) => {
        let same = 0;
        let counted = 0;
        for (let i = 0; i < shownLog.length; i++) {
          const { t } = shownLog[i];
          if (t < s0 || t > s1) continue;
          const dt = (shownLog[i + 1]?.t ?? t) - t;
          let st: Uint8Array = Uint8Array.from(start);
          let ok = false;
          for (let j = 0; j <= res.moves.length && !ok; j++) {
            // j 手回した状態が、t - lag〜t の間にあったか（j 手目の回し始め <= t、j + 1 手目の回し終わり > t - lag）
            const began = j === 0 || res.moves[j - 1].start <= t;
            const still = j === res.moves.length || res.moves[j].end > t - lag;
            if (began && still && statesEqual(st, shownLog[i].state)) ok = true;
            if (j < res.moves.length) st = applyMove(st, res.moves[j].move);
          }
          counted += dt;
          if (ok) same += dt;
        }
        return `${lag}ms ${((same / Math.max(1, counted)) * 100).toFixed(1)}%`;
      });
      out.push(`ライブの 3D の一致（ソルブ中、回している間も数える。遅れを許す）: ${lagged.join("・")}`);
      const pct = (a: { same: number; counted: number }) => `${((a.same / Math.max(1, a.counted)) * 100).toFixed(1)}%（${(a.counted / 1000).toFixed(1)} 秒のうち）`;
      out.push(`ライブの 3D が精密解析の状態と同じだった時間（回している間・その後 ${SETTLE_MS}ms を除く）: ソルブ中 ${pct(acc.solve)}・全体 ${pct(acc.all)}・いちばん長く違ったまま ${((worst.to - worst.from) / 1000).toFixed(2)} 秒（${(worst.from / 1000).toFixed(2)}〜${(worst.to / 1000).toFixed(2)}s）`);
    }
  }
  if (process.env.REAL_TRUTH) {
    const truth = simplifyMoves(parseMoves(process.env.REAL_TRUTH).map((move, i) => ({ move, t: i, orient: 0 }))).map((m) => MOVE_NAMES[m.move]).join(" ");
    out.push(`正解 ${truth}・ライブ ${liveMoves === truth || statesEqual(applyMoves(start, liveMoves), applyMoves(start, truth)) ? "一致" : "違う"}`);
  }
  console.log(out.join("\n"));
}, 3600000);
