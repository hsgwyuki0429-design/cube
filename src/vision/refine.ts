// ソルブ後の精密解析: 録画した全フレームを1枚ずつ、リアルタイムより重い設定で認識・追跡し直す。
// 手順と、各手の開始・終了時刻（フレームの記録から求めた、誤差はフレーム間隔の半分程度）を出す。
// OpenCV のオブジェクトは呼び出し側が渡すので、Worker でもテスト（Node）でも同じコードが動く。
import { type CubeState, OPPOSITE, applyMove, isSolved, moveFace, solvedState, statesEqual } from "../cube/model";
import { type EngineOptions, TrackerEngine } from "../track/engine";
import { mergeQuickRepeats, separateMotions, simplifyMoves } from "../track/merge";
import { DEFAULT_OFFLINE, OfflineForward, type OfflineOptions, type OfflineResult, type SearchStep, decodeOffline, finishDeep } from "../track/offline";
import type { SearchStage, ShowRef } from "./showProtocol";
import { type DecodeOptions as PiecesDecodeOptions, decodePieces } from "../track/pieces/decode";
import { type SolveOptions as PiecesSolveOptions, solvePieces } from "../track/pieces/solve";
import { PERM, TOUCH, piecesOf } from "../track/pieces/model";
import { type TableOptions as PiecesTableOptions, buildTable } from "../track/pieces/table";
import { type SightFrame, sightFrame } from "../track/sight";
import { SureLog, type StartVerdict, judgeBackwardStart } from "../track/startCheck";
import { type LiveStop, STOP_AFTER_MS, STOP_BEFORE_MS, stopCut } from "../track/stopCut";
import { edgeTiming } from "../track/timing";
import type { DecodedMove, TrackStatus } from "../track/types";
import type { Lab } from "./color";
import { type PatchFrame, facePatch, refineEnd, refineStart } from "./fineTiming";
import type { CV, PixelSource } from "./image";
import type { DecodeInfo } from "./videoDecoder";
import { DEFAULT_PIPELINE, type FrameResult, type PipelineConfig, frameReading, processFrame } from "./pipeline";
import { type FaceLayer, cellH } from "../aruco/cube";
import type { Marker } from "../aruco/detect";
import { type DetectHint, detectHint } from "./arucoFrame";
import { type Mat3, applyH } from "./homography";

export interface RefineInput {
  state: number[]; // 解析範囲の始まりの状態（スクランブル後）
  refs: Lab[];
  orients?: number[];
  from: number; // 解析する範囲（ms）
  to: number;
  startHint?: number; // 最初の手のおおよその時刻（リアルタイムの追跡から）。タイムの両端の画素を残す範囲を絞る
  engine?: Partial<EngineOptions>;
  pipeline?: Partial<PipelineConfig>;
  // タイムを測らない解析（フリー）: 画素のパッチは直近のこれだけ残す（長く続けてもメモリが増えないように）
  keepPatchesMs?: number;
  // 軽い検査で、前に精密に処理したフレームとマスの色が同じフレームを飛ばす（既定 true。下の「軽い検査」）
  gate?: boolean;
  // インスペクションの終わり（回し始めの少し前、ms）。録画全体を解析するとき（止まった後のやり直し）、これより前のフレームはソルブ中から
  // 進める解析と同じく間引く（vision.worker.ts の INSPECT_EVERY_MS）。インスペクションで回して見せている間を全部処理すると、持ち替えを
  // 手と読み違えて完成までつながらないことがあった（録画の画質の実物のソルブ 2 本）
  inspectUntil?: number;
  // ステッカーの動きの方程式（src/track/pieces）で先に解き直す（既定 false。比べるため）。完成までつながらなければ、これまでの解き直し
  // （decodeOffline）に戻す。CLAUDE.md の「ステッカーの動きの方程式による解き直し」。true・"and" = 区間を表の AND で解く版（solve.ts）、
  // "v1" = 最初の版（ビームで手を 1 つずつ足す: decode.ts。比べるため）
  pieces?: boolean | "and" | "v1";
  piecesOptions?: { table?: Partial<PiecesTableOptions>; decode?: Partial<PiecesDecodeOptions>; solve?: Partial<PiecesSolveOptions> };
  // 検出を別の Worker に分ける（src/vision/detectPool.ts）。true はコア数から（poolSize。コアが少ない・Worker を作れないときは分けない）、
  // 数を渡すとその数（URL の ?refinepool=0・1・2）。省略時: 動画ファイルの解析は true、タイマーの解析は分けない（vision.worker.ts の Stream.par）
  parallel?: boolean | number;
  // ライブが揃ったと判断して止めた時刻（ms。at = 見え方の揃いが見え始めたフレーム: Solve.edges.stop の hold の始まり、until = 止めると
  // 決めたフレーム）。完成までつながったら、手順をこの時刻より前の最後の揃いで打ち切る（src/track/stopCut.ts。止めた後の手は数えない）。
  // 手動・GAN タイマーで止めたときは渡さない
  stop?: LiveStop;
  // 止めた後の画面に見せる知らせの送り先（src/vision/showFeed.ts。タイマーの解析だけ。解き方は変えない）
  show?: ShowRef;
}

// 軽い検査: 全フレームを精密に処理する代わりに、前に精密に処理したフレーム（基準）の面の格子で、各マスの真ん中あたりの色を数点だけ測り
// （CHECK_POINTS × CHECK_POINTS 点の平均。1 フレーム 0.1ms 程度）、基準と同じなら飛ばす。層を回す・持ち替える・指が動く・キューブが
// 揺れて格子からずれると色が変わるので精密に処理する（迷ったら精密に。読み違えて飛ばすことはない向き）。
// 変わっていたら、取っておいた直前のフレーム（変わる前の最後の 1 枚。回し始めの時刻に要る）と、そのフレームを精密に処理し、
// その後 GATE_TAIL 枚も精密に処理する（回し終わりの時刻は、止まった後のフレームでも止まっていることを確かめる）。GATE_KEEP_MS ごとにも精密に
// （ライブ並みの認識を軽い検査にすると、精密な処理の 7 割ほどかかり、飛ばしても全体では遅くなった）
const GATE_KEEP_MS = 200;
const GATE_TAIL = 2;
const CHECK_POINTS = 5;
const CHECK_DIFF = 25; // マスの色（25 点の R・G・B の平均）の差の最大がこれより大きければ「変わった」（0..255）

interface CellSignature {
  faces: { H: Mat3; layer?: FaceLayer; rgb: Float32Array }[]; // 面ごとに 9 マス × RGB
}

function cellColors(img: PixelSource, H: Mat3, layer: FaceLayer | undefined): Float32Array | null {
  const out = new Float32Array(27);
  for (let cell = 0; cell < 9; cell++) {
    const Hc = cellH({ H, layer }, cell);
    const r = Math.floor(cell / 3);
    const c = cell % 3;
    let n = 0;
    for (let i = 0; i < CHECK_POINTS; i++)
      for (let j = 0; j < CHECK_POINTS; j++) {
        const [x, y] = applyH(Hc, c + 0.15 + (0.7 * (j + 0.5)) / CHECK_POINTS, r + 0.15 + (0.7 * (i + 0.5)) / CHECK_POINTS);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
        const k = (yi * img.width + xi) * 4;
        out[cell * 3] += img.data[k];
        out[cell * 3 + 1] += img.data[k + 1];
        out[cell * 3 + 2] += img.data[k + 2];
        n++;
      }
    for (let k = 0; k < 3; k++) out[cell * 3 + k] /= n;
  }
  return out;
}

// 基準の格子のまま、マスの色を img で測り直す（並列のとき: 格子は最後に処理し終えたフレーム、色は最後に処理に回したフレーム）
function resample(img: PixelSource, sig: CellSignature): CellSignature | null {
  const faces: CellSignature["faces"] = [];
  for (const f of sig.faces) {
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return null;
    faces.push({ ...f, rgb });
  }
  return { faces };
}

// 精密に処理したフレームの面（3×3 の面だけ）の、マスの色の手がかり
function signatureOf(img: PixelSource, faces: { H: Mat3; held?: boolean; layer?: FaceLayer }[]): CellSignature | null {
  const out: CellSignature = { faces: [] };
  for (const f of faces) {
    if (f.held) continue;
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return null;
    out.faces.push({ H: f.H, layer: f.layer, rgb });
  }
  return out.faces.length ? out : null;
}

// img のマスの色が、基準 sig と同じか
export function sameCells(img: PixelSource, sig: CellSignature): boolean {
  for (const f of sig.faces) {
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return false;
    for (let k = 0; k < 27; k++) if (Math.abs(rgb[k] - f.rgb[k]) > CHECK_DIFF) return false;
  }
  return true;
}

export interface RefinedMove {
  move: number;
  orient: number;
  start: number; // 回し始め（ms）
  end: number; // 回し終わり（ms）
  inferred?: boolean;
  exact: boolean; // フレームから開始・終了を決められた
}

export interface RefineResult {
  moves: RefinedMove[];
  solved: boolean; // 最後に完成状態にたどり着いた
  start: number | null; // 最初の手の開始
  end: number | null; // 最後の手の終了
  frames: number;
  status: TrackStatus;
  inferred: number;
  forced: number; // 完成にたどり着くために最後に足した手の数（直接は見えていない）
  method?: string; // 再構成の方法（meet = 前後からつないだ / backward = 後ろ向きだけ / forward-finish / forward）
  // 始まりの状態が渡されたものと違っていた（スクランブルを間違えて回していた）: 完成から後ろ向きにたどり着いた始まりの状態。
  // moves はこの状態から完成まで
  startState?: number[];
  // 完成までつながらなかった（solved = false）が、終わりの時刻は後ろ向きに追えた最後の手から決めた（タイムは出せる）
  gapped?: boolean;
  // 「時刻が分からない」と「手が分からない」は別: 端の手が inferred でも、その層の動きがフレームから分かれば時刻は確か（edgeTiming）
  startUncertain: boolean; // 開始時刻をフレームから決められなかった（最初の手の層が見えない・解析の範囲より前に回し始めていた…）
  endUncertain: boolean; // 終了時刻をフレームから決められなかった
  startMoveInferred: boolean; // 最初の手がどの手か決まらなかった（inferred）
  endMoveInferred: boolean; // 最後の手がどの手か決まらなかった
  // 止めた時刻（RefineInput.stop）で手順を打ち切った（src/track/stopCut.ts）。how = prefix（手順の途中の揃いで切った）/ decode（止めると
  // 決めたフレームまでの観測で解き直した）、dropped = 止めた時刻より後に回し終わる手として外した手の数（まとめる前）。打ち切らなければ無い
  stopCut?: { how: "prefix" | "decode"; dropped: number };
  // 打ち切った最後の手の回し終わりをフレームから決められず、回し始めと止めた時刻の真ん中にした（近似。確定のまま）: その間の長さ（ms）
  endApproxMs?: number;
  raw?: { move: number; t0?: number; t: number; start: number; end: number; inferred?: boolean }[]; // まとめる前の手（調査用）
  // 録画を復号した様子と、精密に処理したフレーム（refined）・軽い検査で飛ばしたフレーム（gated）の数（調査用。録画を解析した Worker が足す）
  // stream: ソルブ中から進めた解析のとき、回し始めの知らせ（solvingAt）・止めた知らせ（endAt）が届いたときに最後に来ていたフレームの時刻と、
  // 最後の間引きの境（fullFrom）。手元で同じフレームを同じように処理し直すため（tests/debug/realVideo.debug.test.ts）
  decodeInfo?: DecodeInfo & { refined: number; gated: number; stream?: { solvingAt: number | null; endAt: number | null; fullFrom: number } };
}

const EDGE_NOISE_MAX = 8; // 最初・最後の「それだけで打ち消し合う手の並び」として除く長さの上限
// まとめる前の端の手の観測が、まとめた後の端の手の時刻からこれより外なら、その手の時刻をフレームから決められないときタイムの端を不確かにする
const RAW_SLACK_MS = 100;

// インスペクション中（回し始めの判定より前）の手で、その後これより長く止まったものは、タイムの端にしない（下の isolatedLead）
export const EARLY_GAP_MS = 600;

// 最初の手のうち、インスペクション中（inspectUntil より前）に回し終わり、その後 EARLY_GAP_MS より長く次の手がないもの（の数）。
// 本当に回した手なら、その後止まっている間にリアルタイムが状態の変化を見て回し始めを判定する（startDetect: 350ms・2 観測）ので、
// 回し始めの判定より前に離れて残った手は、インスペクション中の読み違い（持ち替え）か、案内と違うスクランブルを最初の観測で
// 手として説明したもの（1.5Mbps の実物のソルブで、回し始めの 0.7 秒前の確定の L'。スクランブルを間違えた合成の動画で、最初の観測の
// 確定の 4 手）。タイムの端にすると、タイムがインスペクションの分だけ長くなる。回し始めの判定の少し前から続けて回した手（リアルタイムが
// 最初の手を取りこぼした）は、次の手まで止まらないので当てはまらない
export function isolatedLead(moves: readonly { start: number; end: number }[], inspectUntil: number, gapMs = EARLY_GAP_MS): number {
  let lead = 0;
  for (let i = 0; i + 1 < moves.length && moves[i].end < inspectUntil; i++) if (moves[i + 1].start - moves[i].end >= gapMs) lead = i + 1;
  return lead;
}

// タイムの始まりの時刻をフレームから決められなかった最初の手は、回し始めの手がかり（t0）がインスペクション中の読みのもの（まとめた
// 手の前の方: 確定の L' と後の inferred の L2 が 1 つの L になったときの L' の t0）でありうる。不確かな開始はインスペクションの終わり
// （inspectUntil）より前にしない（タイマーは不確かな開始がリアルタイムより早いと解析の方を使う: タイムがインスペクションの分だけ延びる）
export function clampEarlyStart(start: number, end: number, exact: boolean, inspectUntil: number): number {
  if (exact || !(start < inspectUntil)) return start;
  return Math.min(end, inspectUntil);
}

// 止めた時刻で打ち切った最後の手の回し終わりを、回し始めとライブが揃いを見た時刻の間で決めるとき、その間の長さの上限
const STOP_END_SPAN_MS = 150;
// 止めると決めたフレームまでの観測で解き直すのは、止めた時刻のこれだけ前から（ソルブ全体を解き直すと Node で 8 秒ほど延びた）
const STOP_TAIL_MS = 3000;

// 後ろ向きだけでたどり着いた始まりの状態を照らすのは、その答えの最初の手のこれだけ前までのフレーム（回し始めの動きを含めない）
const START_GUARD_MS = 100;

// 反対の面の層の動きを、タイムの端として採る範囲（それより離れた動きは別の手）
const OPPOSITE_WINDOW_MS = 250;

// 最初の版の設定（答えの確かめの値など）を表の AND 版にも渡す。調査用の onStep は版ごとに形が違うので除く
function withoutStep(o?: Partial<PiecesDecodeOptions>): Partial<Omit<PiecesDecodeOptions, "onStep">> {
  if (!o) return {};
  const { onStep: _, ...rest } = o;
  return rest;
}

// moves[from] から dir の向きに続く同じ軸の手のまとまりに、両方の面の手があるか
function bothFacesAt(moves: { move: number }[], from: number, dir: 1 | -1): boolean {
  const face = moveFace(moves[from].move);
  for (let i = from + dir; i >= 0 && i < moves.length; i += dir) {
    const f = moveFace(moves[i].move);
    if (f === OPPOSITE[face]) return true;
    if (f !== face) return false;
  }
  return false;
}

// 重い設定: 全フレームを処理するので、1回の観測で起きる手は少ないが、取りこぼしを探し直せるように。見失ったときの探し直しは
// 4 手まで（5 手は手順の木が 65 万節点になり、1 回でメモリを 100MB 近く使っていた。手順は decodeOffline が前後から解き直して決める
// ので、こちらの探し直しは結果にほとんど効かない）
export const REFINE_ENGINE: Partial<EngineOptions> = {
  decoder: { beamWidth: 64, maxMovesPerStep: 4, recoveryDepth: 4 },
  logMs: Infinity,
};

// 精密解析の認識の設定（RefineInput.pipeline で上書きできる）。二値化の窓はライブと同じ 3 通り（5〜15）、読めなかったマスは OpenCV で
// 読み直さずに格子で読む（src/aruco/gridRead.ts）。合成の 10 手 × 10 本（速い回し方）で、手順・タイムの端の誤差は窓 4 通り + 読み直しと
// 同じで、1 フレーム 67 → 42ms（読み直しが 1 フレームの 3 割、4 つ目の窓が 2 割）。1 フレームの色が正しく分かるマスは 65.5 → 64.2%
// （指で半分以上隠れたマスの読み直しの分。手順には効いていなかった）
export const REFINE_PIPELINE: Partial<PipelineConfig> = { arucoReread: 0, arucoGrid: true, arucoFineWindows: false };

// 解き直しの後ろ向きに使う時間の上限（src/track/offline.ts の backwardMs）。実物のソルブを本体の録画の画質（720p・2.5Mbps）にすると、後ろ向きが
// 見失ったまま全観測を探して Node で 8 秒（iPhone では 2〜3 倍）かかった。超えたら、そこまでの後ろ向きでつなぐ・橋渡しする
const BACKWARD_MS = 30000;
// 1 回目の解き直しで前後がつながらなかった（橋渡し・前向きを補った・届かない）ときの 2 回目: 同じ観測を、1 観測 4 手まで・候補 256 で
// 解き直す（観測は残っているのでフレームは処理し直さない）。録画の画質の実物のソルブで、1 回目は 6 手を推定でつなぐ・終わりを補うだけ
// だったものが、どちらも推定 0 手で完成までつながった（88 手は正解と同じ）。4 手まででも候補 64 では前向きが見失って悪くなる。
// Node で 15〜25 秒かかるので、1 回目でつながったときは使わない
const DEEP_DECODER = { beamWidth: 256, maxMovesPerStep: 4, deepHyps: Infinity };
const DEEP_BACKWARD_MS = 60000;
// 後ろ向きだけの答え（始まりの状態が違う）を認めなかった後の 2 回目の時間の上限（Node。iPhone では 2〜3 倍）。届かなければ 1 回目の結果
// （終わりに届かない: タイムの終わりは後ろ向きに追えた手から）で終える。1.5Mbps の IMG_5048 で、2 回目が後ろ向き 60 秒・橋渡し・前向きを補うまで
// 探して 1 本 133 秒かかり、それでも届かなかった
const DEEP_AFTER_REJECT_MS = 30000;

export class Refiner {
  readonly engine: TrackerEngine;
  private memory = {}; // フレームの間で引き継ぐもの（processFrame）
  private config: PipelineConfig;
  // 軽い検査
  private ref: CellSignature | null = null; // 最後に精密に処理したフレームのマスの色
  private lastGateT = -Infinity; // 最後に精密に処理すると決めたフレーム
  private held: { img: PixelSource; t: number } | null = null; // 飛ばした直前のフレーム
  private tail = 0;
  private picked: { img: PixelSource; t: number } | null = null; // 最後に精密な処理に回したフレーム
  gated = 0; // 軽い検査で飛ばしたフレームの数
  readonly patches: PatchFrame[] = [];
  readonly looks: { t: number; solved: boolean }[] = []; // フレームごとの「完成して見えるか」
  frames = 0;
  lastT = 0;
  method = "";
  // 前向きの再構成を観測が出るたびに進めておく（result で後ろ向きとつなぐだけにする）
  private forward: OfflineForward | null;
  private fedObs = 0;
  // ステッカーの動きの方程式の材料（フレームごとの読み: 面・ID・マーカーの向き・外枠。1 フレーム数百バイト）。pieces のときだけ
  private sights: SightFrame[] = [];
  piecesMs = 0; // 調査用: ステッカーの動きの方程式の解き直しにかかった時間（使わなければ 0）
  // 調査用: タイムの端を、inferred の端の手の層の動きで確かにした（startByLayer・endByLayer）。endByLooks: 完成して見え始めたフレームでも
  // 終わりを決められた（前の決まり「端の手が inferred なら時刻も不確か」で何本が「一部推定」だったかを数えるため）
  edgeInfo = { startByLayer: false, endByLayer: false, endByLooks: false };
  // 回し始める前に確かに読めたステッカー（後ろ向きだけでたどり着いた始まりの状態を照らす: src/track/startCheck.ts）
  private sure = new SureLog();
  startVerdict: StartVerdict | null = null; // 調査用: 最後に照らした結果

  constructor(
    private cv: CV,
    private input: RefineInput,
  ) {
    const opts = input.engine ?? {};
    this.engine = new TrackerEngine(Uint8Array.from(input.state), input.refs, {
      ...opts,
      decoder: { ...opts.decoder, ...REFINE_ENGINE.decoder },
      logMs: Infinity,
      keepObservations: true,
      repeatMs: 0,
    }, input.orients);
    this.forward = input.keepPatchesMs === undefined ? new OfflineForward(Uint8Array.from(input.state), this.offlineOptions()) : null;
    // ソルブ後の解析は時間をかけてよいので、二値化の窓を細かく試し、読めなかったマスは全部読み直す。
    // 直前のフレームのマーカーの周りだけで検出する（縁の近くに見つかったら全体でやり直す）
    this.config = { ...DEFAULT_PIPELINE, ...REFINE_PIPELINE, ...input.pipeline, arucoThorough: true, arucoRegion: true };
  }

  // インスペクションの終わり（リアルタイムが回し始めたと判定した少し前）。それより前のフレームは間引いて渡されている
  // （vision.worker.ts の INSPECT_*）ので、その間に読めた「打ち消し合って消えた手」（持ち替えの読み違い）はタイムの端に使わない。
  // 打ち消されずに残った最初の手がその間にあれば、リアルタイムが回し始めを遅く判定しただけなので、その手の回し始めをそのまま使う
  // （実物のソルブで、最初の F は本当にリアルタイムの開始の 0.7 秒前に回していた。以前はその後の手の回し始めに直して不確かにしていた）
  private inspectUntil = -Infinity;
  setInspectUntil(t: number): void {
    this.inspectUntil = t;
  }

  // 解析する範囲の終わりを決める（ソルブ中から解析していて、止めた時刻が分かったとき）
  setEnd(to: number): void {
    this.input.to = to;
  }

  // ライブが揃ったと判断して止めた時刻（RefineInput.stop）
  setStop(stop: LiveStop | undefined): void {
    this.input.stop = stop;
  }

  private offlineOptions(): OfflineOptions {
    return { decoder: { ...this.input.engine?.decoder, ...DEFAULT_OFFLINE.decoder }, personal: this.input.engine?.personal, backwardMs: BACKWARD_MS, startCheck: (s, until) => this.checkBackwardStart(s, until) };
  }

  // 後ろ向きだけでたどり着いた始まりの状態を、回し始める前（その答えの最初の手の START_GUARD_MS 前まで。インスペクションの終わりが
  // 分かっていればそこまで）の確かな読みと照らす。食い違う・確かな読みが足りなければ認めない（完成にしない）
  private checkBackwardStart(state: CubeState, until: number): boolean {
    const end = Math.min(until, this.inspectUntil > Number.NEGATIVE_INFINITY ? this.inspectUntil : Number.POSITIVE_INFINITY) - START_GUARD_MS;
    const v = judgeBackwardStart(state, Uint8Array.from(this.input.state), this.sure.stable(this.input.from, end));
    this.startVerdict = v;
    return v.ok;
  }

  // 途中結果: 前向きにここまで解いた最良の仮説（遅れの表示用。ライブの追跡には反映しない）
  partial(): { t: number; state: number[]; orient: number; moves: DecodedMove[]; status: string } {
    const dec = this.engine.decoder;
    const best = dec.best();
    return { t: this.lastT, state: Array.from(best.state), orient: best.orient, moves: dec.bestMoves(), status: dec.status };
  }

  push(img: PixelSource, t: number): void {
    for (const f of this.gate(img, t)) this.full(f.img, f.t);
  }

  // 軽い検査: このフレームで精密に処理するもの（0〜2 枚。時刻順）。飛ばすフレームは取っておく（変わったときに直前の 1 枚として処理する）。
  // 検出を別の Worker で並列にするときは、返ったフレームを検出してから順に full に渡す（基準は最後に処理し終えたフレーム）
  gate(img: PixelSource, t: number): { img: PixelSource; t: number }[] {
    if (t < this.input.from || t > this.input.to) return [];
    if (this.input.gate === false) return [{ img, t }];
    const forced = !this.ref || this.tail > 0 || t - this.lastGateT >= GATE_KEEP_MS;
    const changed = !this.ref || !sameCells(img, this.ref);
    if (!forced && !changed) {
      this.held = { img: copyImage(img, this.held?.img), t };
      this.gated++;
      return [];
    }
    // 変わった: 変わる前の最後の 1 枚から精密に処理する
    const out = changed && this.held ? [this.held] : [];
    this.held = null;
    out.push({ img, t });
    this.tail = changed ? GATE_TAIL : Math.max(0, this.tail - 1);
    this.lastGateT = t;
    // 検出を並列にすると、処理し終える前に次のフレームが来る。基準の色を、処理に回したこのフレームのものにしておく
    // （古いフレームの色と比べると、変わった後の数枚が「変わった」と出続けて、止まっていても飛ばせなかった）
    this.picked = { img, t };
    if (this.ref) this.ref = resample(img, this.ref);
    return out;
  }

  get pipelineConfig(): PipelineConfig {
    return this.config;
  }

  // 精密に処理したフレームの結果（調査用: tests/debug/realVideo.debug.test.ts。止めた後の画面の知らせ: src/vision/showFeed.ts）
  onFrame?: (t: number, r: FrameResult) => void;
  // 解き直しの観測ごとの 1 歩（止めた後の画面の知らせ: src/vision/showFeed.ts）。read = 録画を読みながら進めた前向き
  onSearch?: (stage: SearchStage | "read", e: SearchStep) => void;
  private searchHook(stage: SearchStage): Pick<OfflineOptions, "onSearch"> {
    const f = this.onSearch;
    return f ? { onSearch: (e) => f(stage, e) } : {};
  }

  // 次に検出するフレームの切り出し（別の Worker で検出するとき。最後に処理し終えたフレームのマーカーの範囲から）
  detectHint(img: PixelSource, t: number): DetectHint | null {
    return this.config.arucoRegion ? detectHint(this.memory, img, t) : null;
  }

  // 精密に処理する。detected: 別の Worker で検出しておいたマーカー
  full(img: PixelSource, t: number, detected?: Marker[]): void {
    const r = processFrame(this.cv, img, t, this.config, this.memory, detected);
    this.onFrame?.(t, r);
    if (this.input.pieces && r.faces.length) this.sights.push(sightFrame(t, r));
    this.sure.push(t, r.faces.map((f) => ({ slot: f.slot, ids: f.ids, w: f.weight })));
    // 基準: この格子で、処理に回したいちばん新しいフレームの色（1 か所で処理するときは、このフレーム）
    const latest = this.picked && this.picked.t > t ? this.picked.img : img;
    // 見えている面が減ったフレーム（回している途中・指）の後は、続けて精密に処理する: 残った面だけを基準にすると、回している面
    // そのもの（揃った面は回しても真ん中あたりの色が変わらない）だけが残ったとき、回している間のフレームを「同じ」とみて飛ばす
    const before = this.ref?.faces.length ?? 0;
    this.ref = signatureOf(latest, r.faces);
    if ((this.ref?.faces.length ?? 0) < before) this.tail = Math.max(this.tail, GATE_TAIL);
    const reading = frameReading(t, r);
    this.engine.push(reading);
    if (this.forward) {
      const log = this.engine.observationLog;
      for (; this.fedObs < log.length; this.fedObs++) {
        const n = this.forward.F.length;
        this.forward.feed(log[this.fedObs]);
        // 止めた後の画面: 録画を読みながら進めた前向きの様子（送らずに数えるだけ）
        if (this.onSearch && this.forward.F.length > n) this.onSearch("read", { dir: "f", t: log[this.fedObs].t, hyps: this.forward.F[n].hyps });
      }
    }
    this.looks.push({ t, solved: reading.faces.length > 0 && this.engine.looksSolved(reading) });
    this.patches.push({ t, faces: r.faces.map((f) => facePatch(img, { ...f, labs: f.labs })) });
    this.prunePatches(t);
    this.frames++;
    this.lastT = t;
  }

  // 画素のパッチ（1フレーム 10KB 程度）は、最初の手の前後と、直近の数秒（最後の手の前後）だけ残す
  private prunePatches(t: number): void {
    const hint = this.input.startHint;
    const P = this.patches;
    if (hint === undefined) {
      const keep = this.input.keepPatchesMs;
      if (keep !== undefined) {
        let k = 0;
        while (k < P.length && P[k].t < t - keep) k++;
        if (k > 30) P.splice(0, k);
      }
      return;
    }
    let i = 0;
    while (i < P.length && P[i].t <= hint + 1500) i++;
    let j = i;
    while (j < P.length && P[j].t < t - 3000) j++;
    if (j - i > 30) P.splice(i, j - i);
  }

  // m と同じ時刻・姿勢で、同じ軸の反対の面を回す手（その層の動きを調べるため）
  private opposite(m: { move: number; t0?: number; t: number; orient: number }) {
    return { move: OPPOSITE[moveFace(m.move)] * 3, t0: m.t0, t: m.t, orient: m.orient };
  }

  // ステッカーの動きの方程式（src/track/pieces）で解き直す。完成までつながらなければ null。tick: 進み具合の知らせ（STALL_MS の見張り）
  private decodeByPieces(target: CubeState, tick?: () => void): OfflineResult | null {
    const began = performance.now();
    const table = buildTable(this.sights, this.input.piecesOptions?.table);
    const o = this.input.piecesOptions;
    const start = Uint8Array.from(this.input.state);
    const r = this.input.pieces === "v1" ? decodePieces(table, start, target, { ...o?.decode, tick }) : solvePieces(table, start, target, { ...withoutStep(o?.decode), ...o?.solve, tick });
    this.piecesMs = performance.now() - began;
    if (!r.reachedEnd) return null;
    const frames = table.frames;
    // 回し始めの手がかり（t0）: 見え方の境目は粗いので、回す層のピースが回す前の位置に最後に見えたフレームまで詰める
    // （手の時刻の判定 timing.ts は t0 から遡って動き出しを探す。早すぎると見つけられず、タイムの端が不確かになる）
    let pos = piecesOf(Uint8Array.from(this.input.state));
    let prevT = -Infinity;
    const t0s = r.moves.map((m) => {
      const bit = 1 << m.move;
      let t0 = m.t0;
      for (let g = frames.length - 1; g >= 0; g--) {
        const fr = frames[g];
        if (fr.t >= m.t) continue;
        if (fr.t <= Math.max(m.t0, prevT)) break;
        let seen = false;
        for (const gr of fr.groups) {
          if (gr.mode !== 0) continue;
          for (let i = 0; i < gr.n && !seen; i++) {
            const k = gr.P[i];
            if (k < 20 && TOUCH[pos[k]] & bit && gr.A[i] === pos[k]) seen = true;
          }
        }
        if (seen) {
          t0 = fr.t;
          break;
        }
      }
      const P = PERM[m.move];
      pos = Uint8Array.from(pos, (x) => P[x]);
      prevT = t0;
      return t0;
    });
    // 手のときの姿勢（認識のスロットと合うもの。手の時刻の判定がスロットで層を見る）: その手の後、いちばん近いフレーム
    let orient = this.engine.decoder.best().orient;
    for (const fr of frames)
      if (fr.orient >= 0) {
        orient = fr.orient;
        break;
      }
    let f = 0;
    const moves: DecodedMove[] = r.moves.map((m, i) => {
      while (f < frames.length && frames[f].t < m.t) f++;
      for (let k = f; k < frames.length && frames[k].t - m.t <= 500; k++)
        if (frames[k].orient >= 0) {
          orient = frames[k].orient;
          break;
        }
      return { move: m.move, t0: t0s[i], t: m.t, orient, ...(m.inferred ? { inferred: true } : {}) };
    });
    return { moves, method: "meet", meetAt: -1, cost: r.cost, reachedEnd: true };
  }

  // target: 最後の状態が分かっていれば（タイマーなら完成）、それにたどり着く仮説を選ぶ
  // onPhase: 段階を知らせる（解き直しの後に "timing"。落ちたときにどこで落ちたかを残すため: src/app/crashGuard.ts）。解き直しの間も
  // "decode" をときどき（呼ぶ側で間引く）: 本体は知らせが届かないと止まったとみなしてやり直す（controller.endAnalysis の STALL_MS）
  deepUsed = false; // 調査用: 2 回目の深い解き直しの結果を使った
  stopTried = ""; // 調査用: 止めた時刻での打ち切りを試した結果（"" = 試さない・prefix・decode・decode-rejected: 理由）
  deepTimedOut = false; // 調査用: 2 回目が時間の上限で打ち切られた
  result(target: CubeState | null = solvedState(), onPhase?: (phase: "decode" | "timing") => void): RefineResult {
    const dec = this.engine.decoder;
    const tick = onPhase ? () => onPhase("decode") : undefined;
    this.piecesMs = 0;
    this.startVerdict = null;
    this.deepTimedOut = false;
    // 前向き（スクランブル後から）と後ろ向き（完成から）の両方で解き直し、辻褄の合う所でつなぐ
    // ステッカーの動きの方程式（RefineInput.pieces）: 完成までつながらなければ、これまでの解き直しに戻す
    const pieces = target && this.input.pieces ? this.decodeByPieces(target, tick) : null;
    let off: OfflineResult = pieces ?? decodeOffline(this.engine.observationLog, Uint8Array.from(this.input.state), target, this.lastT, { ...this.offlineOptions(), tick, ...this.searchHook("first") }, this.forward ?? undefined);
    if (!pieces && target && off.method !== "meet" && off.method !== "backward") {
      const base = this.offlineOptions();
      const verdict = this.startVerdict as StartVerdict | null; // 1 回目の解き直しの中で書き換わる
      const rejected = verdict !== null && !verdict.ok;
      const deep = decodeOffline(this.engine.observationLog, Uint8Array.from(this.input.state), target, this.lastT, { ...base, decoder: { ...base.decoder, ...DEEP_DECODER }, backwardMs: DEEP_BACKWARD_MS, tick, ...this.searchHook("deep"), ...(rejected ? { deadline: performance.now() + DEEP_AFTER_REJECT_MS } : {}) });
      this.deepTimedOut = !!deep.timedOut;
      const guessed = (r: typeof off) => r.moves.filter((m) => m.inferred).length;
      if (deep.reachedEnd && (!off.reachedEnd || guessed(deep) < guessed(off) || (guessed(deep) === guessed(off) && deep.method === "meet"))) off = deep;
      this.deepUsed = off === deep;
    }
    let moves = off.moves;
    let solved = target ? off.reachedEnd && isSolved(target) : isSolved(dec.best().state);
    let forced = off.method === "forward-finish" ? off.moves.filter((m) => m.inferred && m.t === this.lastT).length : 0;
    if (!off.reachedEnd) {
      // 再構成で終わりに届かなければ、リアルタイムと同じ前向きの結果に戻す
      moves = dec.bestMoves();
      solved = isSolved(dec.best().state);
      forced = 0;
      if (target && !statesEqual(dec.best().state, target)) {
        const fixed = finishDeep(dec, target, this.lastT, tick);
        if (fixed) {
          forced = fixed.filter((m) => m.inferred && m.t === this.lastT).length;
          moves = fixed;
          solved = isSolved(target);
        }
      }
    }
    // ライブが揃ったと判断して止めた時刻より後の手は数えない（WCA と同じ: 止めた時点でタイムが決まる）。完成までつながり、止めた後に
    // 回し終わる手があるときだけ（src/track/stopCut.ts）:
    //   1) 手順の途中で、止めた時点の前後に揃いがあれば、そこで切る
    //   2) なければ、止めると決めたフレームまで（揃って見えていた所まで）の観測だけで、完成を終わりとして解き直す。止めた後の往復
    //      （IMG_5049 の上の層の D'・D）を、前の手とまとめて最後の手として読んでいると、手順の途中に揃いが出てこない。前後がつながり、
    //      推定の手が増えず、最後の手が止めた時点の近くで回し終わるときだけ使う
    //   どちらもだめなら今のまま（ライブの誤判定に引きずられない）
    let stopCutInfo: RefineResult["stopCut"];
    this.stopTried = "";
    const stop = this.input.stop;
    if (solved && target && isSolved(target) && stop && moves.length) {
      const timesOf = (ms: DecodedMove[]) => {
        const cache = new Map<number, { start: number; end: number }>();
        return (i: number) => {
          let r = cache.get(i);
          if (!r) {
            const tm = this.engine.timing(ms[i]);
            cache.set(i, (r = { start: tm?.start ?? ms[i].t0 ?? ms[i].t, end: tm?.end ?? ms[i].t }));
          }
          return r;
        };
      };
      const at = timesOf(moves);
      const after = moves.filter((_, i) => at(i).end > stop.at + STOP_AFTER_MS).length;
      if (after > 0) {
        const startState = off.reachedEnd && off.startState ? off.startState : Uint8Array.from(this.input.state);
        const cut = stopCut(startState, moves, stop.at, at);
        if (cut) {
          stopCutInfo = { how: "prefix", dropped: moves.length - cut.keep };
          this.stopTried = "prefix";
          moves = moves.slice(0, cut.keep);
          forced = moves.filter((m) => m.inferred && m.t === this.lastT).length;
        } else {
          // 解き直すのは止めた時刻の STOP_TAIL_MS 前から（それより前の手は今の答えのまま。その時刻の状態から始める）
          const until = Math.max(stop.at, stop.until);
          const from = stop.at - STOP_TAIL_MS;
          let k = moves.findIndex((m) => m.t > from);
          if (k < 0) k = moves.length;
          const head = moves.slice(0, k);
          let s0: CubeState = startState;
          for (const m of head) s0 = applyMove(s0, m.move);
          const obs = this.engine.observationLog.filter((o) => o.t > from && o.t <= until);
          const again = decodeOffline(obs, s0, target, until, { ...this.offlineOptions(), startCheck: undefined, tick, ...this.searchHook("stop") });
          const guessed = (ms: DecodedMove[]) => ms.filter((m) => m.inferred).length;
          this.stopTried = `decode-rejected: ${again.method}${again.reachedEnd ? "" : "・届かない"}${again.startState ? "・始まりが違う" : ""}・推定 ${guessed(again.moves)}/${guessed(moves.slice(k))}`;
          if (again.reachedEnd && again.method === "meet" && !again.startState && again.moves.length && guessed(again.moves) <= guessed(moves.slice(k))) {
            const a2 = timesOf(again.moves);
            const end = a2(again.moves.length - 1).end;
            if (end <= stop.at + STOP_AFTER_MS && end >= stop.at - STOP_BEFORE_MS) {
              stopCutInfo = { how: "decode", dropped: after };
              this.stopTried = "decode";
              moves = [...head, ...again.moves];
              forced = 0;
            }
          }
        }
      }
    }
    this.method = pieces ? (this.input.pieces === "v1" ? "pieces-v1" : "pieces") : off.method;
    // 届かなかったとき、後ろ向きが終わりから追えていた最後の手（タイムの終わりに使う）
    const tailLast = !solved && off.tail?.length ? off.tail[off.tail.length - 1] : null;
    onPhase?.("timing");
    const timeOf = <T extends DecodedMove>(m: T) => {
      const tm = this.engine.timing(m);
      return { ...m, start: tm?.start ?? m.t0 ?? m.t, end: tm?.end ?? m.t, exact: !!tm?.exact, endExact: !!tm?.endExact, moved: !!tm?.moved };
    };
    // 分かれて読まれた手をまとめ、打ち消し合う手（回転途中の見え方・指の誤読から出た雑音）を除く。状態は変わらない。
    // ただし、どちらも層が動いたのを見つけていて間で止まっていた 2 手は、本当に回した手（無駄な動きも）として残す（separateMotions）
    // 最初・最後にある、それだけで打ち消し合って消える手の並び（U U' など）は、回し始める前・完成した後の読み違い（持ち替えを
    // 手として読んだ）なので除く: 回し始める前は始まりの状態のまま、完成した後は完成のまま。残すと、どちらも「層が動いたのを見た」
    // ときに本当に回した無駄な動きとして残り、タイムの端がそこまで延びる（実物のソルブで、完成した後にキューブを持ち替えた所まで
    // 終わりが 0.25 秒延びた。認識が少し変わるだけで出たり出なかったりした）
    const cancels = (ms: DecodedMove[]) => ms.length > 0 && simplifyMoves(ms).length === 0;
    let lead = 0;
    for (let j = Math.min(moves.length, EDGE_NOISE_MAX); j >= 2 && !lead; j--) if (cancels(moves.slice(0, j))) lead = j;
    let trail = 0;
    for (let j = Math.min(moves.length - lead, EDGE_NOISE_MAX); j >= 2 && !trail; j--) if (cancels(moves.slice(moves.length - j))) trail = j;
    if (lead || trail) moves = moves.slice(lead, moves.length - trail);
    const raw = moves;
    const timings = new Map<DecodedMove, ReturnType<typeof timeOf>>();
    const timed0 = (m: DecodedMove) => {
      let r = timings.get(m);
      if (!r) timings.set(m, (r = timeOf(m)));
      return r;
    };
    moves = simplifyMoves(moves, (a, b) => separateMotions(timed0(a), timed0(b)));
    const timed = moves.map(timeOf);
    // インスペクション中に離れて残った最初の手はタイムの端にしない: 手順には残す（状態がつながるように）が inferred にし、時刻は
    // タイムの始まり（次の手の回し始め）に寄せる
    const lead0 = timed.length > 1 ? isolatedLead(timed, this.inspectUntil) : 0;
    // タイムの両端は画素の差で詰める（色の読みより早く動きを拾える）
    const first = timed[lead0];
    const last = timed[timed.length - 1];
    // まとめる前の端の手: 打ち消し合って消えた手（F2 B2 F2 → B2 の最後の F2）も実際に回しているので、タイムはその手の端まで。
    // 層が見えて動いたのをフレームから見つけた手だけ（そうでなければ誤読の雑音かもしれないので、まとめた後の端の手のまま。
    // インスペクション中・完成した後の誤読を打ち消し合う 2 手で説明した仮説の手で、タイムが長くなっていた）
    let rawStart = false;
    let rawEnd = false;
    // まとめる前の端の手の時刻をフレームから決められず、まとめた後の端の手より RAW_SLACK_MS より外にありそうなら、タイムの端は
    // 不確か（F2 B2 F2 → B2 で、最後の F2 を回している間は正面が読めなかった: B2 の終わりを「確定」にすると 276ms 短かった）
    let rawStartUnsure = false;
    let rawEndUnsure = false;
    if (first && !lead0 && raw[0] && raw[0] !== moves[0] && !raw[0].inferred && raw[0].t >= this.inspectUntil) {
      const r = timeOf(raw[0]);
      if (r.exact && r.moved && r.start < first.start) {
        Object.assign(first, { start: refineStart(this.patches, r, r.start, this.engine.colors.refs) ?? r.start, exact: true });
        rawStart = true;
      } else if (!(r.exact && r.moved) && (raw[0].t0 ?? raw[0].t) < first.start - RAW_SLACK_MS) rawStartUnsure = true;
    }
    if (last && raw.length && raw[raw.length - 1] !== moves[moves.length - 1] && !raw[raw.length - 1].inferred) {
      const r = timeOf(raw[raw.length - 1]);
      if (r.exact && r.endExact && r.moved && r.end > last.end) {
        Object.assign(last, { end: refineEnd(this.patches, r, r.end, this.engine.colors.refs) ?? r.end, endExact: true });
        rawEnd = true;
      } else if (!(r.endExact && r.moved) && raw[raw.length - 1].t > last.end + RAW_SLACK_MS) {
        rawEndUnsure = true;
        last.end = Math.max(last.end, raw[raw.length - 1].t);
      }
    }
    let endUncertain = !!last?.inferred;
    // 最初の観測から既にスクランブルの状態と違う（解析の範囲より前に回し始めていた）: 開始は録画から決められない
    const firstObs = this.engine.observationLog.find((o) => o.faces.length);
    const beforeWindow = !!first && !!firstObs && (first.t0 ?? first.t) <= firstObs.t;
    const refs = this.engine.colors.refs;
    // 「どの手か」と「いつか」を分ける: 端の手が inferred（手順を 1 つに決められない: 回す量・見えない区間の並び）でも、その手の層が
    // 動き出して止まったのがフレームから分かれば、その端の時刻は確か（edgeTiming。別の面の手と取り違えていれば層は動かず確かにならない）
    const timingOf = (x: DecodedMove) => this.engine.timing(x);
    let startByLayer = false;
    let endByLayer = false;
    if (first?.inferred && !rawStart) {
      const e = edgeTiming(first, "start", timingOf);
      if (e.sure && e.tm) {
        Object.assign(first, { start: refineStart(this.patches, first, e.tm.start, refs) ?? e.tm.start, exact: true, moved: true });
        startByLayer = true;
      }
    }
    if (last?.inferred && !rawEnd) {
      const e = edgeTiming(last, "end", timingOf);
      if (e.sure && e.tm) {
        Object.assign(last, { end: refineEnd(this.patches, last, e.tm.end, refs) ?? e.tm.end, endExact: true, moved: true });
        endByLayer = true;
        endUncertain = false;
      }
    }
    // 色の読みで静止フレームが見つからなかった（指で層が隠れていた）ときも、観測の時刻を手がかりに画素の差で探す
    if (first && !first.inferred && !rawStart) {
      const s = refineStart(this.patches, first, first.start, refs);
      if (s !== null) Object.assign(first, { start: s, exact: true });
    }
    if (last && !last.inferred && !rawEnd) {
      const e = refineEnd(this.patches, last, last.end, refs);
      if (e !== null) Object.assign(last, { end: e, endExact: true });
    }
    // 最初（最後）にある同じ軸の手のまとまりに両方の面の手があれば（D' U' など）、反対の面の層の動きも見る。
    // 同じ軸の手は順番を入れ替えても同じ状態になるので、間の状態が見えない（速い・指で隠れた）と「U D' U2」が
    // 「D' U'」と読まれ、本当は先に動いた U の層を見落とす。まとまりに反対の面の手がなければ、その層は動いていない
    if (first && !first.inferred && !rawStart && bothFacesAt(timed, lead0, 1)) {
      const o = this.opposite(first);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const s = refineStart(this.patches, o, tm.start, refs) ?? tm.start;
        if (s < first.start && s > first.start - OPPOSITE_WINDOW_MS) Object.assign(first, { start: s, exact: true });
      }
    }
    if (last && !last.inferred && !rawEnd && bothFacesAt(timed, timed.length - 1, -1)) {
      const o = this.opposite(last);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const e = refineEnd(this.patches, o, tm.end, refs) ?? tm.end;
        if (e > last.end && e < last.end + OPPOSITE_WINDOW_MS) Object.assign(last, { end: e, endExact: true });
      }
    }
    let endByLooks = false;
    if (last?.inferred && solved) {
      // 最後の手が見えていない（完成にたどり着くために足した手）: 直接見えた最後の手の後で、
      // 完成して見え始めたフレームを回し終わりとする（層の動きで決まっていればそちら）
      const seen = [...timed].reverse().find((m) => !m.inferred);
      const after = seen ? seen.end : this.input.from;
      const i = this.looks.findIndex((x, k) => x.t > after && x.solved && this.looks[k + 1]?.solved !== false);
      endByLooks = i > 0;
      if (i > 0 && !endByLayer) {
        last.end = (this.looks[i - 1].t + this.looks[i].t) / 2;
        last.start = Math.min(last.start, last.end);
        endUncertain = false;
      }
    }
    // 止めた時刻で打ち切った（stopCut）のに、最後の手の回し終わりが層の動きから決まらない（IMG_5049: 上の層が見えにくい向きで、
    // 回し終わりの後のフレームはほとんど読めない）: 回し始めがフレームから決まっていて、ライブが揃いを見た時刻（stop.at）がその
    // STOP_END_SPAN_MS 以内なら、回し終わりはその間にある。間の真ん中にする（誤差は間の半分まで）
    let endApproxMs: number | undefined;
    if (stopCutInfo && stop && last && !last.inferred && !last.endExact && last.exact && solved) {
      const from = Math.max(last.start, timed.length > 1 ? timed[timed.length - 2].end : last.start);
      if (stop.at >= from && stop.at - from <= STOP_END_SPAN_MS) {
        last.end = (from + stop.at) / 2;
        last.endExact = true;
        endApproxMs = Math.round(stop.at - from);
        endByLooks = true;
      }
    }
    // 完成までつながらなかった: 終わりの時刻は、後ろ向きに追えた最後の手の回し終わり（フレームから決まったときだけ確か）
    let gapEnd: number | null = null;
    let gapEndSure = false;
    if (tailLast) {
      const r = timeOf(tailLast);
      const e = tailLast.inferred ? null : refineEnd(this.patches, tailLast, r.end, refs);
      gapEnd = e ?? r.end;
      gapEndSure = !tailLast.inferred && (e !== null || r.endExact);
    }
    if (first) first.start = clampEarlyStart(first.start, first.end, first.exact, this.inspectUntil);
    this.edgeInfo = { startByLayer, endByLayer, endByLooks };
    for (let i = 0; i < lead0; i++) Object.assign(timed[i], { inferred: true, start: first.start, end: first.start, exact: false });
    const merged = mergeQuickRepeats(timed, undefined, undefined, separateMotions).map((m) => ({ move: m.move, orient: m.orient, start: m.start, end: Math.max(m.start, m.end), exact: m.exact, ...(m.inferred ? { inferred: true } : {}) }));
    return {
      moves: merged,
      solved,
      start: merged.length ? (lead0 ? first.start : merged[0].start) : null,
      end: gapEnd ?? (merged.length ? merged[merged.length - 1].end : null),
      ...(gapEnd !== null ? { gapped: true } : {}),
      ...(off.startState ? { startState: Array.from(off.startState) } : {}),
      frames: this.frames,
      status: dec.status,
      inferred: merged.filter((m) => m.inferred).length,
      forced,
      method: this.method,
      // 端の手の層が見えず、時刻をフレームから決められなかった（観測の時刻のまま）ときも不確か。見えない層（低く構えて U・B が
      // 写らないなど）の手は、観測の時刻が数百 ms ずれることがある
      startUncertain: (!!first?.inferred && !startByLayer) || beforeWindow || !first?.exact || rawStartUnsure,
      endUncertain: gapEnd !== null ? !gapEndSure : endUncertain || (!!last && !last.inferred && !last.endExact) || rawEndUnsure,
      startMoveInferred: !!first?.inferred,
      endMoveInferred: !!last?.inferred,
      ...(stopCutInfo ? { stopCut: stopCutInfo } : {}),
      ...(endApproxMs !== undefined ? { endApproxMs } : {}),
      raw: timed.map((m) => ({ move: m.move, t0: m.t0, t: m.t, start: m.start, end: m.end, inferred: m.inferred })),
    };
  }
}

// 画素を写す（飛ばしたフレームを取っておく。古いものの入れ物を使い回す）
function copyImage(img: PixelSource, reuse?: PixelSource): PixelSource {
  const data = reuse && reuse.data.length === img.data.length ? (reuse.data as Uint8ClampedArray) : new Uint8ClampedArray(img.data.length);
  data.set(img.data);
  return { data, width: img.width, height: img.height } as PixelSource;
}
