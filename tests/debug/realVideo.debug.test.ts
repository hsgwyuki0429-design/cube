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
//   REAL_PIECES=1（精密解析の解き直しをステッカーの動きの方程式で: RefineInput.pieces。表の AND 版。REAL_PIECES=v1 は最初の版）
// 設定画面の「録画を書き出す」で書き出した録画（cubevision-rec-….mp4）は、REAL_VIDEO=そのファイル だけで本体と同じ条件になる
// （tests/debug/lib/recording.ts）: 圧縮し直さず・縮めずに YUV のまま読み（本体と同じ planesToRgba）、時刻は本体の時間軸（ms）、始まりの状態・
//   解析の範囲・インスペクションの間引き・止めた時刻・終わりの状態・認識と追跡の設定は書き出しから。ライブは省き（REAL_NOLIVE=0 で通す）、
//   止まったフレームは飛ばす（REAL_STILL=0 で飛ばさない）。本体の結果と比べて「アプリの結果と同じ」を出す（REAL_EXPECT_SAME=1 なら違えば失敗）。
//   REAL_START・REAL_START_FILE・REAL_END・REAL_FROM・REAL_TO（秒、本体の時間軸）を渡せばそちらを使う（そのときは本体と同じにはならない）
//   REAL_APP_TRUTH=ファイル（本体の結果を piecesBench の正解の形で書き出す: REAL_RREADINGS・REAL_OBS と一緒に piecesBench に通す）
//   REAL_STATS_OUT=ファイル（読める量の物差しを 1 行の JSON で足す: 1 フレームに読めたマス・ピース、確かな読みのない区間、実際の fps・抜け。
//   範囲は REAL_STATS_RANGE=開始,終了（秒）か REAL_STATS_REF=精密解析の結果（REAL_REF の書き出し）の最初の手の回し始め〜最後の手の回し終わり、
//   なければこの解析の結果の。REAL_STATS_LABEL=条件の名前・REAL_NAME=動画の名前。まとめは tests/debug/recordingStats.debug.test.ts）
// 精密解析の追跡の設定は本体と同じ（controller.engineOptions: ARUCO_OBSERVER・候補 32・3 手）。
// 精密解析が完成までつながったら、その手順と時刻を本当の動きとみなして、ライブが 3D に出した状態が本当の状態と同じだった時間の割合を出す
// （手を回している間とその後 300ms は数えない）
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { STICKERS } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, applyMove, applyMoves, inverseMove, isSolved, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { mostLikelyState } from "../../src/cube/pattern";
import { PARTNERS, stickerIds } from "../../src/cube/stickers";
import { MoveDecoder, observationCost } from "../../src/track/decoder";
import { TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { layerAtRest } from "../../src/track/timing";
import { ARUCO_OBSERVER, type FrameReading, LIVE_OBSERVER } from "../../src/track/observer";
import { DEFAULT_OFFLINE, reversedObservations } from "../../src/track/offline";
import { liveStats } from "../../src/vision/arucoFrame";
import { type FrameResult, frameReading, processFrame } from "../../src/vision/pipeline";
import { StillSkipper } from "../../src/vision/motion";
import { sightFrame } from "../../src/track/sight";
import { type RefineResult, Refiner } from "../../src/vision/refine";
import { ShowFeed } from "../../src/vision/showFeed";
import { DEFAULT_PIPELINE } from "../../src/vision/pipeline";
import { type StatFrame, compareResults, exportPlan, loadExport, readExportFrames, readStats, statFrame } from "./lib/recording";
import type { SightFrame } from "../../src/track/sight";
import { loadTestOpenCv } from "../cv";
import { writePng } from "./png";
import { profile, summarize } from "./prof";

// いちばん近い代表色（ARUCO_REFS の番号 = 面）
function nearestRef(lab: ArrayLike<number>): number {
  let best = -1;
  let bd = Infinity;
  ARUCO_REFS.forEach((r, k) => {
    const d = (r[0] - lab[0]) ** 2 + (r[1] - lab[1]) ** 2 + (r[2] - lab[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  });
  return best;
}

const LONG = Number(process.env.REAL_LONG ?? 1280); // REAL_LONG=1920 など: 長辺（解像度が読みに効くかを測る）
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
  // 書き出した録画（メタデータつき）なら本体と同じ条件で
  const exp = loadExport(file);
  const plan = exp ? exportPlan(exp) : null;
  const flag = (k: string, dflt: boolean) => (process.env[k] === undefined ? dflt : process.env[k] !== "0");
  const noLive = flag("REAL_NOLIVE", !!exp);
  const sameAsApp = !!exp && !process.env.REAL_START && !process.env.REAL_START_FILE && !process.env.REAL_END && !process.env.REAL_FROM && !process.env.REAL_TO;
  // 大きさと回転
  const probe = exp ? [exp.recorder.width, exp.recorder.height] : spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const [sw, sh] = probe;
  const s = exp ? 1 : LONG / Math.max(sw, sh);
  const W = Math.round((sw * s) / 2) * 2;
  const H = Math.round((sh * s) / 2) * 2;
  // フレームの時刻（秒。書き出した録画は readExportFrames が本体の時間軸で）
  const times = exp
    ? []
    : spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 })
        .stdout.trim()
        .split("\n")
        .map((l) => Number.parseFloat(l)); // 行の終わりに "," が付く
  const from = Number(process.env.REAL_FROM ?? (exp ? -Infinity : 0));
  const to = Number(process.env.REAL_TO ?? Infinity);
  const allTimes: number[] = []; // 読んだフレームの時刻（ms。REAL_STATS_OUT の fps・抜け）
  // 動画を 1 フレームずつ読む（時刻 ms）
  const readFrames = async (each: (img: Img, t: number) => void, until = to) => {
    allTimes.length = 0;
    if (exp) {
      await readExportFrames(file, exp, (img, tUs) => {
        const t = tUs / 1000;
        if (t > until * 1000) return false;
        allTimes.push(t);
        if (t < from * 1000) return;
        each(img, t);
      });
      return;
    }
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
        allTimes.push(t);
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
  if (exp && !process.env.REAL_START && !process.env.REAL_START_FILE) start = Uint8Array.from(exp.analysis.input.state);
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
  const live = new TrackerEngine(start, ARUCO_REFS, { observer: liveObs, decoder: liveDec, snapToView: true, recover: true });
  // REAL_LIVE_WORKERS=2: ライブの認識を Worker 2 つで交互に処理したとき（フレームの間で引き継ぐものは Worker ごと）
  const liveMemories = Array.from({ length: Number(process.env.REAL_LIVE_WORKERS ?? 1) }, () => ({}));
  let liveTurn = 0;
  const pieces = process.env.REAL_PIECES ? { pieces: process.env.REAL_PIECES === "v1" ? ("v1" as const) : ("and" as const) } : {};
  const refineEngine = JSON.parse(process.env.REAL_REFINE_ENGINE ?? "{}");
  // 書き出した録画: 本体が解析に渡した入力（認識・追跡の設定も）のまま。本体の解析の Worker は認識の設定を DEFAULT_PIPELINE に重ねる
  const refiner =
    process.env.REAL_REFINE === "0"
      ? null
      : exp && plan
        ? new Refiner(cv as never, {
            ...plan.input,
            state: Array.from(start),
            ...(process.env.REAL_FROM ? { from: from * 1000 } : {}),
            ...(process.env.REAL_TO ? { to: to * 1000 } : {}),
            ...pieces,
            ...(process.env.REAL_REFINE_GATE === "0" ? { gate: false } : {}),
            engine: { ...plan.input.engine, ...refineEngine, decoder: { ...plan.input.engine?.decoder, ...refineEngine.decoder } },
            pipeline: { ...DEFAULT_PIPELINE, ...plan.input.pipeline, ...JSON.parse(process.env.REAL_REFINE_CFG ?? "{}") },
          })
        : new Refiner(cv as never, { state: Array.from(start), refs: ARUCO_REFS, from: from * 1000, to: to * 1000, ...(process.env.REAL_PIECES ? { pieces: process.env.REAL_PIECES === "v1" ? ("v1" as const) : ("and" as const) } : {}), ...(process.env.REAL_REFINE_GATE === "0" ? { gate: false } : {}), engine: { observer: ARUCO_OBSERVER, ...JSON.parse(process.env.REAL_REFINE_ENGINE ?? "{}"), decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...JSON.parse(process.env.REAL_REFINE_ENGINE ?? "{}").decoder } }, pipeline: { ...STICKERS, ...JSON.parse(process.env.REAL_REFINE_CFG ?? "{}") } });
  // REAL_RFRAMES=22.1-23.0: 精密解析が精密に処理したフレームの面
  // 精密解析が精密に処理したフレームの読み（ID が読めたマスの数。認識の良し悪し）
  const rstat = { frames: 0, faces: 0, ids: 0, empty: 0 };
  // REAL_RREADINGS=ファイル: 精密解析が精密に処理したフレームの読み（面と ID だけ）を書き出す（betweenMoves.debug.test.ts で、手と手の間の状態がどれだけ読めたかを測る）
  const rreadings: { t: number; faces: { slot: number; ids: number[]; w: number[]; rot?: number[]; held?: boolean; quad?: number[]; c?: number[] }[] }[] = [];
  // REAL_STATS_OUT: 精密に処理したフレームの読める量と、確かな読みのない区間の材料
  const statOn = !!process.env.REAL_STATS_OUT;
  const statFrames: StatFrame[] = [];
  const statSights: SightFrame[] = [];
  if (refiner && !process.env.REAL_RFRAMES)
    refiner.onFrame = (_t, r: FrameResult) => {
      if (statOn) {
        statFrames.push(statFrame(_t, r.faces));
        if (r.faces.length) statSights.push(sightFrame(_t, r));
      }
      if (process.env.REAL_RREADINGS) {
        // rot・held: ピースの時刻表（src/track/pieces）の材料（マーカーの向き・1 列だけの面）
        const sf = new Map(sightFrame(_t, r).faces.map((f) => [f.slot, f]));
        // c: 色だけで読めたマスの色（代表色 ARUCO_REFS のいちばん近いもの。ID のないマス）。ピースの時刻表の弱い手がかり
        rreadings.push({ t: _t, faces: r.faces.map((f) => ({ slot: f.slot, ids: Array.from(f.ids ?? new Array(9).fill(-1)), w: f.weight.map((x) => Math.round(x * 100) / 100), rot: sf.get(f.slot)?.rot ?? new Array(9).fill(-1), quad: sf.get(f.slot)?.quad ?? [], c: f.labs.map((lab, k) => (f.valid[k] ? nearestRef(lab) : -1)), ...(f.held ? { held: true } : {}) })) });
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
  const SOLVE_FROM = plan ? -Infinity : Number(process.env.REAL_SOLVE_FROM ?? -Infinity);
  if (refiner && Number.isFinite(SOLVE_FROM)) refiner.setInspectUntil(SOLVE_FROM * 1000);
  if (refiner && plan?.inspectUntil !== undefined) refiner.setInspectUntil(plan.inspectUntil);
  let endApplied = false; // 書き出した録画（ソルブ中から進めた解析）: 止めた知らせが届いた所で、解析の範囲の終わりと止めた時刻を渡す
  const applyEnd = () => {
    if (!refiner || !plan || plan.mode !== "stream" || endApplied) return;
    endApplied = true;
    if (!process.env.REAL_TO) refiner.setEnd(plan.to);
    refiner.setStop(plan.stop);
  };
  let lastInspect = -Infinity;
  const still = flag("REAL_STILL", !!exp) ? new StillSkipper() : null;
  let refineFrames = 0;
  const K = Number(process.env.REAL_K ?? 0);
  // REAL_FPS=6: 1 秒 N 枚に固定して処理する（処理時間によらないので、設定を比べるときに結果がぶれない）。待っている 3 枚のうち動きのいちばん小さいもの
  const FIX = Number(process.env.REAL_FPS ?? 0);
  let liveMs = 0;
  let trackMs = 0;
  let evals = 0;
  let obsN = 0;
  // REAL_SHOW=1: 止めた後の画面の知らせ（src/vision/showFeed.ts）を本体の Worker と同じように付ける（送り先は数えるだけ）。付けても結果と
  // 時間が変わらないことを確かめる（知らせの中で使った時間 showMs も出す）
  const show = { ms: 0, posts: 0 };
  if (refiner && process.env.REAL_SHOW === "1") {
    const feed = new ShowFeed(() => show.posts++, 1);
    const prev = refiner.onFrame;
    refiner.onFrame = (t, r) => {
      prev?.(t, r);
      const a = performance.now();
      feed.frame(t, r);
      show.ms += performance.now() - a;
    };
    refiner.onSearch = (stage, e) => {
      const a = performance.now();
      feed.search(stage, e);
      show.ms += performance.now() - a;
    };
  }
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
    const r = processFrame(cv as never, img, t, liveCfg, liveMemories[liveTurn++ % liveMemories.length]);
    const a2 = performance.now();
    const reading = frameReading(t, r);
    // sight: 面の外枠・マーカーの向き（src/track/pieces/frame.ts。スロットに頼らない位置の決め方を試すため）
    if (process.env.REAL_READINGS) readings.push({ ...reading, sight: sightFrame(t, r) } as FrameReading);
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
    if (noLive) {
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
    // 書き出した録画: 本体の解析の Worker と同じ範囲・間引き（tests/debug/lib/recording.ts の exportPlan）
    if (plan) {
      if (!plan.keep(t)) return;
      if (plan.endAt !== null && t > plan.endAt) applyEnd();
    }
    // REAL_SOLVE_FROM=11.4: この時刻（秒）より前はインスペクションとして 60ms に 1 枚だけ精密解析に渡す（vision.worker.ts の INSPECT_EVERY_MS）
    const inspecting = plan ? t < plan.thinBefore(t) : t < SOLVE_FROM * 1000;
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
    const eng = new TrackerEngine(start, ARUCO_REFS, { observer: liveObs, decoder: liveDec, snapToView: true, recover: true });
    const { nodes, interval } = await profile(() => {
      for (const p of picked) eng.push(frameReading(p.t, processFrame(cv as never, p.img, p.t, liveCfg, mem)));
    });
    console.log(summarize(nodes, interval, picked.length, 30));
  }
  if (process.env.REAL_READINGS) writeFileSync(process.env.REAL_READINGS, JSON.stringify({ start: Array.from(start), readings }));
  applyEnd(); // 止めた知らせが最後のフレームの後だった
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
    const end =
      process.env.REAL_END === "solved"
        ? solvedState()
        : process.env.REAL_END === "none"
          ? null
          : exp && !process.env.REAL_END
            ? exp.analysis.target && Uint8Array.from(exp.analysis.target)
            : isSolved(Uint8Array.from(shown))
              ? solvedState()
              : null;
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
    // 書き出した録画: 録画の設定と、本体の結果との比べ
    if (exp) {
      const a = exp.analysis;
      const rc = exp.recorder;
      const sec = (t?: number | null) => (t === undefined || t === null ? "-" : `${((t - exp.timeOriginUs / 1000) / 1000).toFixed(3)}s`);
      out.push(`書き出した録画: ${rc.codec}（${rc.hw ?? "?"}）・${(rc.bitrate / 1e6).toFixed(1)}Mbps・${rc.width}×${rc.height}・圧縮に回した ${rc.frames}・間引いた ${rc.dropped}・${exp.device?.ua ?? ""}`);
      out.push(`  時刻は録画の始まりから: 回し始め（リアルタイム）${sec(a.live?.startT)}・止めた ${sec(a.live?.endT)}（${a.live?.how ?? "-"}）・インスペクションの終わり ${sec(a.solvingFrom)}・解析の範囲の終わり ${sec(a.input.to)}・${plan?.note}`);
      const di = a.result?.decodeInfo;
      if (di) out.push(`  本体の復号: ${di.decoded} 枚（YUV のまま ${di.copied}・${di.format ?? "?"}・${di.matrix ?? "?"}・${di.fullRange ? "full" : "limited"}）・精密に処理 ${di.refined}・飛ばした ${di.gated}／手元: 精密に処理 ${refiner?.frames ?? "-"}・飛ばした ${refiner?.gated ?? "-"}${di.copied < di.decoded ? "（本体は canvas で画素にしたので、同じ画素にならない）" : ""}`);
      // REAL_APP_TRUTH=ファイル: 本体の結果を piecesBench の正解の形（buildTruth の BT_OUT と同じ { startState, moves }）で書き出す
      // （PB_TRUTH にそのフォルダを渡す。本当の正解ではなく、本体の解析と比べるため）
      if (process.env.REAL_APP_TRUTH && a.result?.solved) writeFileSync(process.env.REAL_APP_TRUTH, JSON.stringify({ startState: a.result.startState ?? a.input.state, moves: a.result.moves, note: "app" }));
      if (!a.result) out.push(`  本体の結果なし（${a.error ?? (a.pending ? "解析中に書き出した" : "?")}）`);
      else if (refiner) {
        const diff = compareResults(a.result, res);
        out.push(sameAsApp ? `アプリの結果と同じ: ${diff.length ? "いいえ" : "はい"}` : `アプリの結果との違い（条件を変えたので参考）: ${diff.length ? "" : "なし"}`);
        for (const d of diff) out.push(`  ${d}`);
        if (process.env.REAL_EXPECT_SAME && diff.length) {
          console.log(out.join("\n"));
          throw new Error("アプリの結果と違う");
        }
      }
    }
    // REAL_STATS_OUT=ファイル: 読める量の物差し（実機の録画と x264 を同じ物差しで比べる）
    if (statOn) {
      const ref = process.env.REAL_STATS_REF ? (JSON.parse(readFileSync(process.env.REAL_STATS_REF, "utf8")) as RefineResult) : null;
      const rr = process.env.REAL_STATS_RANGE?.split(",").map((x) => Number(x) * 1000);
      const base = ref ?? res;
      const range: [number, number] | null = rr ? [rr[0], rr[1]] : base.start !== null && base.end !== null ? [base.start, base.end] : null;
      if (range) {
        const st = readStats(range, allTimes, statFrames, statSights);
        const row = { name: process.env.REAL_NAME ?? file.split("/").pop(), label: process.env.REAL_STATS_LABEL ?? (exp ? "実機" : "動画"), ...st, solved: res.solved, method: res.method, moves: res.moves.length, inferred: res.moves.filter((m) => m.inferred).length, ...(exp ? { recorder: exp.recorder, device: exp.device?.ua } : {}) };
        appendFileSync(process.env.REAL_STATS_OUT!, `${JSON.stringify(row)}\n`);
        out.push(`読める量（${(range[0] / 1000).toFixed(2)}〜${(range[1] / 1000).toFixed(2)}s）: ${st.fps}fps（間隔の中央 ${st.medianMs}ms・抜け ${st.holes} か所 ${st.missing} 枚）・1 フレームに読めたマス ${st.cells}・ピース ${st.pieces}・確かな読みのない 1 秒より長い区間 ${st.gaps1}（${st.gaps1Sec} 秒）・いちばん長い ${st.longest} 秒`);
      } else out.push("読める量: 範囲が決まらない（REAL_STATS_RANGE か REAL_STATS_REF を渡す）");
    }
    // REAL_METHODS=old,v1,and・REAL_METHODS_OUT=ファイル: 同じ読みで解き直しの方法ごとに結果を 1 行ずつ足す（REAL_PIECES=1 と一緒に:
    // ピースの材料を集めるため）。タイムの端の前の決まり（端の手が inferred なら時刻も不確か）での不確かさも出す
    if (refiner && process.env.REAL_METHODS && process.env.REAL_METHODS_OUT) {
      const inp = (refiner as unknown as { input: { pieces?: boolean | "v1" | "and" } }).input;
      // REAL_METHODS_STOP=44.93,45.13（秒）: 止めた時刻（RefineInput.stop）を渡して方法ごとに出す（stopCut まで本体の流れと同じに）
      const ms0 = process.env.REAL_METHODS_STOP?.split(",").map((x) => Number(x) * 1000);
      if (ms0) refiner.setStop({ at: ms0[0], until: ms0[1] ?? ms0[0] });
      for (const m of process.env.REAL_METHODS.split(",")) {
        inp.pieces = m === "old" ? false : (m as "v1" | "and");
        const t0 = performance.now();
        const r = refiner.result(end);
        const e = refiner.edgeInfo;
        const row = {
          name: process.env.REAL_NAME ?? file,
          method: m,
          used: r.method,
          solved: r.solved,
          moves: r.moves.map((x) => `${MOVE_NAMES[x.move]}${x.inferred ? "?" : ""}`).join(" "),
          inferred: r.inferred,
          start: r.start,
          end: r.end,
          startUncertain: r.startUncertain,
          endUncertain: r.endUncertain,
          startMoveInferred: r.startMoveInferred,
          endMoveInferred: r.endMoveInferred,
          oldStartUncertain: r.startUncertain || e.startByLayer,
          oldEndUncertain: r.endUncertain || (e.endByLayer && !e.endByLooks),
          ms: Math.round(performance.now() - t0),
          piecesMs: Math.round(refiner.piecesMs),
          // まとめ（tests/debug/refinerCompare.debug.test.ts）の材料: 時刻つきの手・始まりの状態・打ち切り・完成の補い
          timed: r.moves.map((x) => ({ move: x.move, start: x.start, end: x.end, ...(x.inferred ? { inferred: true } : {}) })),
          startState: r.startState ?? null,
          forced: r.forced,
          gapped: !!r.gapped,
          stopCut: r.stopCut ?? null,
          endApproxMs: r.endApproxMs ?? null,
          stop: ms0 ?? null,
          stopTried: refiner.stopTried,
        };
        appendFileSync(process.env.REAL_METHODS_OUT, JSON.stringify(row) + "\n");
      }
    }
    // REAL_STOP=44.97 または 44.93,45.13（秒。ライブが揃ったと判断して止めた: 揃いが見え始めたフレーム・止めると決めたフレーム）。
    // "|" で区切って複数: 同じ読みで、止めた時刻で打ち切った結果も出す（RefineInput.stop。src/track/stopCut.ts）。REAL_STOP_OUT=ファイルに、
    // 打ち切らない結果と打ち切った結果を 1 行ずつ足す。REAL_TIMING_DBG=1: 打ち切った最後の手の前後のフレーム
    if (refiner && process.env.REAL_STOP) {
      const fmt = (r: RefineResult) => ({ solved: r.solved, method: r.method, n: r.moves.length, moves: r.moves.map((x) => `${MOVE_NAMES[x.move]}${x.inferred ? "?" : ""}`).join(" "), inferred: r.inferred, start: r.start, end: r.end, startUncertain: r.startUncertain, endUncertain: r.endUncertain, startState: r.startState ?? null, stopCut: r.stopCut ?? null, endApproxMs: r.endApproxMs ?? null });
      for (const spec of process.env.REAL_STOP.split("|")) {
        const [a, b] = spec.split(",").map((x) => Number(x) * 1000);
        refiner.setStop({ at: a, until: b ?? a });
        const t0 = performance.now();
        const rc = refiner.result(end);
        refiner.setStop(undefined);
        const ms = Math.round(performance.now() - t0);
        out.push(`止めた時刻（${spec} 秒）で打ち切った精密解析（${ms}ms）: ${rc.stopCut ? JSON.stringify(rc.stopCut) : "打ち切らない"}・${rc.moves.length} 手・終了 ${rc.end === null ? "-" : (rc.end / 1000).toFixed(3)}s${rc.endUncertain ? "（不確か）" : ""}・推定 ${rc.inferred}`);
        out.push(`  手順 ${fmt(rc).moves}`);
        if (process.env.REAL_TIMING_DBG) {
          const lm = rc.moves[rc.moves.length - 1];
          for (const f of refiner.engine.frames.filter((f) => f.t > lm.end - 300 && f.t < lm.end + 600)) out.push(`  DBG F ${(f.t / 1000).toFixed(3)} rest=${layerAtRest(f, lm.orient, Math.floor(lm.move / 3))} faces=${f.faces.map((x) => `${x.slot}:${(x.ids ?? []).join(",")}`).join(" ")}`);
        }
        if (process.env.REAL_ENDS) out.push(`  端の手（打ち切り）: 最後 ${JSON.stringify(rc.moves.slice(-2))} raw ${JSON.stringify(rc.raw?.slice(-3))} ${JSON.stringify(refiner.edgeInfo)}`);
        if (process.env.REAL_STOP_OUT) appendFileSync(process.env.REAL_STOP_OUT, `${JSON.stringify({ name: process.env.REAL_NAME ?? file, stop: spec, before: fmt(res), after: fmt(rc), tried: refiner.stopTried, ms })}\n`);
      }
    }
    if (rstat.frames) out.push(`精密解析の読み: 精密に処理した ${rstat.frames} 枚・面なし ${((100 * rstat.empty) / rstat.frames).toFixed(1)}%・平均 ${(rstat.faces / rstat.frames).toFixed(2)} 面・ID が読めたマス 平均 ${(rstat.ids / rstat.frames).toFixed(2)}`);
    out.push(`精密解析${cached ? "（書き出した結果）" : ""} ${(refineMs / frames).toFixed(1)}ms/フレーム（渡した ${refineFrames} 枚・計 ${(refineMs / 1000).toFixed(1)} 秒）・解き直し ${(performance.now() - r0).toFixed(0)}ms・${res.method}${refiner?.deepUsed ? "（2 回目の深い解き直し）" : ""}・${res.solved ? "完成まで" : "完成に届かない"}・推定した手 ${res.moves.filter((m) => m.inferred).length}${process.env.REAL_SHOW === "1" ? `・知らせ ${show.posts} 回 ${show.ms.toFixed(1)}ms` : ""}`);
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
