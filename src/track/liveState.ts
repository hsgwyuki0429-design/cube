// ライブの状態の推定（ライブ 2 の後半。ソルブ中だけ: TrackerEngine の EngineOptions.pieces）。DOM もカメラも知らない。
//
// 精密解析のピース方式（src/track/pieces）と同じ表で、フレームごとにキューブの状態を推定する:
//   - 状態 = ピース 20 個の位置（キューブ固定の座標: 代表のステッカーのある facelet）と、センターの向き 6 つ（その面を回した回数 mod 4）
//   - 面の置き方はセンターの ID と面どうしの接し方だけで決める（スロットに頼らない: sight.ts の placeAll）。センターが 1 つだけの面は、
//     仮説のセンターの向きと、読んだセンターのマーカーの向きで置き方が決まる。センターの見えない面は、前のフレームで置いた同じ面
//     （同じステッカーの ID・外枠の近さ）の続き（画像の上の向きがいちばん近い置き方。ほかの 3 通りはコストつき）
//   - フレームの間（読めたフレームから次の読めたフレームまで）の手は 0〜2 手が多い。仮説ごとに、冗長でない k 手（k = 0〜2、合わなければ 3）の
//     手順を全部、表（tables.ts の seqTable）の行き先で照らし、読めたピースの式「x にいたピースは y へ」を満たすかを数える
//   - 合う状態を全部持つ（上位何個で切らない）。一番よい仮説から keepBits より悪いものだけ落とす。手を足しても読みとよく合わない子
//     （隠れた層の手を足しただけ）は作らない
//   - 見えていないピースは「分からない」のまま持てる: ピースごとに取り得る位置のビット（24 通り）。仮説が膨らんで上限（maxHyps）を超えたら、
//     仮説をまとめてピースごとの取り得る位置の和にする（近似）。読めたピースはその場で 1 つに決まる。3D は決まったピースだけを動かす
//
// 点数（ビット）: k 手の手順 1 つ = −log2(ポアソン(k; rate·Δt) / 冗長でない k 手の数)（Δt = 前の読めたフレームから）。
// 読みとの食い違い = 読み違いの割合 ε（MEASURED_EPS: 種類 × 続いた長さ）から log2((1 − ε)·23 / ε)。同じピースの食い違いが続いた分は、
// 続いた長さの ε で 1 本ぶんになるように差分だけ足す（1 枚だけの食い違い 9.5 ビット・10 枚続いても 13 ビット）
import { type CubeState, NUM_ORIENTATIONS, VIEW, isSolved, solvedState } from "../cube/model";
import { CORNER_FACELETS, EDGE_FACELETS } from "../cube/pattern";
import { PARTNERS } from "../cube/stickers";
import { IS_CORNER, NUM_PIECES, PIECE_OF, PIECE_REF, REF_AT, EXPECT_ROT, toCubeState } from "./pieces/model";
import { CLS, IDX, positionOf, seqTable, solveExact, type CenterEq, type Eq } from "./pieces/tables";
import { MEASURED_EPS, bitsOf, lenBucket } from "./pieces/table";
import { CELL_TURN, type Placed, type SightFace, type SightFrame, isCenter, placeAll, touching } from "./sight";
import type { DecodedMove } from "./types";

export interface LiveStateOptions {
  rate: number; // 1 秒あたりの手の数の見込み（手数のコストのポアソン分布）
  maxK: number; // ふだん照らす手数（0〜maxK）
  deepK: number; // 一番よい子でも食い違うとき、上位 deepHyps 個の仮説で照らす手数
  deepHyps: number;
  deepAbove: number; // 一番よい子のこのフレームの食い違いがこれ（ビット）以上なら深く照らす
  deepMax: number; // 深く照らした子がこれより多ければ（読みが少なくて決まらない）、足さずに次の読みを待つ
  keepBits: number; // 一番よい仮説からこれより悪い仮説は落とす
  childBits: number; // 1 つの仮説の子のうち、一番よい子からこれより悪いものは作らない
  maxHyps: number; // 仮説の上限（超えたら点数の悪い方から落とす）
  tieBits: number; // 一番よい仮説からこれ以内の仮説だけで上限を超えたら、ピースごとの取り得る位置にまとめる
  agreeBits: number; // 3D で回して見せてよい手: 一番よい仮説からこれ以内の仮説がどれも同じ手順のとき
  // 3D で、候補の状態がどれも同じ手順になるまで手を回して見せるのを待つ（TrackUpdate.agreed を出す。既定は待たない: 3D の一致が下がり、
  // 回して見せる本当の手が減った。docs/history.md の「ソルブ中のライブの状態を表の AND で推定する」）
  agreeWait: boolean;
  touch: number; // 面どうしの接し方（table.ts の touch）
  minDt: number; // 手数のコストの Δt の下限（ms）
  contMs: number; // センターの見えない面を、これ以内に置いた同じ面の続きとして置く
  contBits: number; // そのとき、続きと違う置き方のコスト
  chainBits: number; // センター 1 つの面で、仮説のセンターの向きから決まる置き方が、画像の上の向きの続き（前のフレーム）と違うときのコスト
  chainRefresh: boolean; // センター 1 つの面の続きを、仮説の置き方が続きと同じだったフレームでも延ばす
  chainMs: number; // その続きに使う、前に置いた同じ面の古さの上限
  contCap: number; // そのまとまりの食い違いの上限（面の取り違え: 手を足す理由にはしない）
  held: boolean; // 1 列・1 枚の面（外枠が推定）を、同じフレームの置き方の決まった面から分かるカメラの姿勢で置く
  // 見失ったところからの復帰: 錨（食い違いのない最後の仮説）から、読めたピースが全部合う手順を表で探す
  recoverK: number; // 探す手数の上限（5 以上は前後から突き合わせる）
  recoverMin: number; // 探すのに要る、確かに読めたピースの数
  recoverMs: number; // 錨から探す時間の上限
  recoverGapMs: number; // 探す間隔
  budgetMs: number; // 深く照らす・復帰で、5 手より長い手順（前後の突き合わせ）を探し始めてよい時間（1 フレームの中で）
  solvedMin: number; // 揃った状態にしてよい、揃った位置に読めたピースの数（preferSolved）
  lostAll: boolean; // 見失ったとき、読めていないピースは全部「分からない」にする（false: 食い違いの続いていたピースだけ）
  lostBits: number; // 食い違いがこれ（ビット）以上続いたら、読めたピースをその場で読みの位置にする（見えていないピースは分からないまま）
  // 1 つのピースだけが、置き方の決まった読みで同じ位置に fixRun 回続けて読めたのに仮説と食い違うなら、そのピースをその位置に置き直す
  // （そこにいたはずのピースは「分からない」。0 = しない）。食い違いの点数は続いた分だけ差分で足すので 1 つのピースでは lostBits に届かず、
  // ほかの仮説もないと、読みと食い違ったまま最後まで戻らなかった（docs/history.md の「ソルブ中に 3D が一度外れると戻らない」）
  fixRun: number;
  fixChain: boolean; // センター 1 つのまとまりの読みも置き直しに数える（ほかの読みが fixAgree 以上合い、食い違うのが 1 つだけのとき）
  fixAgree: number;
}

export const DEFAULT_LIVE_STATE: LiveStateOptions = {
  rate: 5,
  maxK: 2,
  deepK: 6,
  deepHyps: 4,
  deepAbove: 6,
  deepMax: 24,
  keepBits: 14,
  childBits: 6,
  maxHyps: 48,
  tieBits: 1,
  agreeBits: 6,
  agreeWait: false,
  touch: 0.45,
  minDt: 16,
  contMs: 300,
  contBits: 4.5,
  contCap: 5,
  chainBits: 4.5,
  chainMs: 500,
  chainRefresh: false,
  held: true,
  recoverK: 8,
  recoverMin: 6,
  recoverMs: 2500,
  recoverGapMs: 150,
  budgetMs: Infinity,
  lostBits: 20,
  lostAll: false,
  solvedMin: 8,
  fixRun: 3,
  fixChain: false,
  fixAgree: 3,
};

const KIND_DIRECT = 0;
const KIND_FRAGMENT = 1;
const KIND_CENTER = 3;
const W = MEASURED_EPS.map((row) => row.map(bitsOf));
// 食い違いが m 枚続いたときに、m 枚目で足す分（続いた全部で 1 本ぶん）
const MISS_INC = W.map((row) => {
  const out = new Float32Array(256);
  for (let m = 1; m < 256; m++) out[m] = m === 1 ? row[lenBucket(1)] : Math.max(0, row[lenBucket(m)] - row[lenBucket(m - 1)]);
  return out;
});
// 冗長でない k 手の手順の数（5 手からは 1 手ごとにほぼ 13.35 倍）
const NSEQ = [1, 18, 243, 3240, 43254, 43254 * 13.35, 43254 * 13.35 ** 2, 43254 * 13.35 ** 3, 43254 * 13.35 ** 4];
const LOG2_NSEQ = NSEQ.map((n) => Math.log2(n));
const MAX_DEEP = 8;
const FULL24 = (1 << 24) - 1;
// 種類 c の番号 b の位置が占める「場所」（同じキュービーの向き違い）のビット
const PLACE = [0, 1].map((c) => {
  const out = new Uint32Array(24);
  for (let b = 0; b < 24; b++) {
    const x = positionOf(c, b);
    let m = 1 << b;
    for (const q of PARTNERS[x]) m |= 1 << IDX[q];
    out[b] = m;
  }
  return out;
});
const clsOf = (p: number): number => (IS_CORNER[p] ? 0 : 1);
const single = (m: number): boolean => m !== 0 && (m & (m - 1)) === 0;
const bitIndex = (m: number): number => 31 - Math.clz32(m);

// ---- 1 フレームの読み → 式 ----
// 読みのまとまり（面 1 つか、接してつながった面）。mode:
//   0 = 置き方が決まった（センターと面の接し方。1 列・1 枚の面はカメラの姿勢で）
//   1 = センター 1 つ（置き方 r は仮説のセンターの向きで決まる: r = センターのマーカーの向き − φ）
//   2 = センターなし（前のフレームの同じ面の続き。r ごとのコスト prior）
// マーカーを直接読んでいないマス（前のフレームから引き継いだ ID）は使わない
export interface LiveGroup {
  mode: 0 | 1 | 2;
  face: number; // mode 1: センターの面
  cr: number; // mode 1: センターのマーカーの格子に対する向き
  prior: number[]; // mode 2: r ごとのコスト
  from: number; // 読みの範囲
  to: number;
  faces: SightFace[];
  placed: ((Placed | null)[] | null)[]; // r ごとの面の置き方（mode 0 は 0 番だけ）
}

export interface LiveFrame {
  t: number;
  n: number; // ピースの読みの数
  piece: Int8Array; // ピース（0〜19）
  cls: Uint8Array; // 0 = コーナー・1 = エッジ
  kind: Uint8Array;
  ys: Int16Array; // 置き方 r ごとの位置（種類の中の番号 0〜23。ありえない読みは -1）: ys[j * 4 + r]。mode 0 は 4 つとも同じ
  groups: LiveGroup[];
  centers: { f: number; phi: number }[]; // 置き方の決まった面のセンターの向き（φ = 最初の向き + 回した回数 mod 4）
  orient: number; // 置き方の決まった面と認識のスロットが合うカメラの姿勢（-1 = 分からない）
  pieces: number; // 読めたピースの数（重なりなし）
}

// 置き方（面 F・向き r）で、面 f の読みを式にする。センターは φ = (cr − r) mod 4
function eqsOfFace(f: SightFace, face: number, r: number, cb: (s: number, c: number, x: number) => void): void {
  for (let c = 0; c < 9; c++) {
    const s = f.ids[c];
    if (s < 0 || f.rot[c] < 0) continue;
    if (isCenter(s)) {
      if (c !== 4) continue;
      cb(s, c, Math.floor(s / 9) === face ? (f.rot[4] - r + 4) & 3 : -1);
      continue;
    }
    const q = face * 9 + CELL_TURN[r * 9 + c];
    const x = REF_AT[s * 54 + q];
    cb(s, c, x >= 0 && EXPECT_ROT[s * 54 + q] === ((f.rot[c] - r + 4) & 3) ? IDX[x] : -1);
  }
}

// 面の決まった並びの「上」（格子の辺 r）が画像で向く角度
function upAngle(q: number[], r: number): number {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const i = (r & 3) * 2;
  const j = ((r + 1) & 3) * 2;
  return Math.atan2((q[i + 1] + q[j + 1]) / 2 - cy, (q[i] + q[j]) / 2 - cx);
}
const quadCenter = (q: number[]): [number, number] => [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
const quadSize = (q: number[]): number => (Math.hypot(q[2] - q[0], q[3] - q[1]) + Math.hypot(q[4] - q[2], q[5] - q[3]) + Math.hypot(q[6] - q[4], q[7] - q[5]) + Math.hypot(q[0] - q[6], q[1] - q[7])) / 4;

// 面の置き方の記憶（キューブの面ごと）: センターの見えない面を、前のフレームで置いた同じ面の続きとして置く
export interface FaceMemory {
  // ang: 置き方の決まった面の続き（センターのない面に使う）。sure: 置き方がほかの面との接し方で決まったときだけの向きと時刻（センター 1 つの
  // 面の続きに使う。その面だけで置いた向きは、その面を回している途中の格子に付いていくので使わない）
  faces: ({ t: number; c: [number, number]; size: number; ang: number; ids: number[]; sure: { t: number; ang: number } | null } | null)[];
}
// 表を先に作っておく（初めて深く探すフレームで 4 手の表を作ると 70ms ほどかかる。11MB）
export function warmLiveTables(): void {
  for (let k = 0; k <= 4; k++) seqTable(k);
}

export const newFaceMemory = (): FaceMemory => ({ faces: new Array(6).fill(null) });

export function liveFrame(sight: SightFrame, mem: FaceMemory | null = null, opts: Pick<LiveStateOptions, "touch" | "contMs" | "contBits" | "held" | "chainBits" | "chainMs"> = DEFAULT_LIVE_STATE): LiveFrame {
  const piece: number[] = [];
  const cls: number[] = [];
  const kind: number[] = [];
  const ys: number[] = [];
  const groups: LiveGroup[] = [];
  const centers: { f: number; phi: number }[] = [];
  const main = sight.faces.filter((f) => !f.held && f.quad?.length === 8 && f.ids.some((id, c) => id >= 0 && f.rot[c] >= 0));
  const links: number[][] = [];
  for (let a = 0; a < main.length; a++)
    for (let b = a + 1; b < main.length; b++) {
      let best = Infinity;
      let bi = 0;
      let bj = 0;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const d = touching(main[a].quad, main[b].quad, i, j);
          if (d < best) {
            best = d;
            bi = i;
            bj = j;
          }
        }
      if (best < opts.touch) links.push([a, b, bi, bj]);
    }
  const comp = main.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  for (const [a, b] of links) comp[find(a)] = find(b);
  const surePlaced: { slot: number; face: number; r: number }[] = [];
  const usedFaces = new Set<number>();
  const centerOf = (f: SightFace) => (f.ids[4] >= 0 && isCenter(f.ids[4]) && f.rot[4] >= 0 ? Math.floor(f.ids[4] / 9) : -1);
  const directOf = (f: SightFace) => f.ids.filter((x, c) => x >= 0 && !isCenter(x) && f.rot[c] >= 0).length;
  // 置き方 r ごとの面の置き方から、まとまりの読みを足す（r ごとの位置。センターは mode 0 のときだけ）
  const addGroup = (g: Omit<LiveGroup, "from" | "to">, fs: SightFace[], rs: number[]) => {
    const from = piece.length;
    const per = new Map<number, number[]>();
    const meta = new Map<number, { s: number; kd: number }>();
    for (const r of rs) {
      const placed = g.placed[r];
      if (!placed) continue;
      fs.forEach((f, k) => {
        const pl = placed[k];
        if (!pl) return;
        const kd = directOf(f) >= 4 && !f.held ? KIND_DIRECT : KIND_FRAGMENT;
        eqsOfFace(f, pl.face, pl.r, (s, c, x) => {
          if (isCenter(s)) {
            if (g.mode === 0 && x >= 0) centers.push({ f: Math.floor(s / 9), phi: x });
            return;
          }
          const key = k * 9 + c;
          let a = per.get(key);
          if (!a) per.set(key, (a = [-1, -1, -1, -1]));
          a[r] = x;
          meta.set(key, { s, kd });
        });
      });
    }
    for (const [key, a] of per) {
      const { s, kd } = meta.get(key)!;
      if (a.every((v) => v < 0)) continue;
      piece.push(PIECE_OF[s]);
      cls.push(clsOf(PIECE_OF[s]));
      kind.push(kd);
      if (g.mode === 0) ys.push(a[0], a[0], a[0], a[0]);
      else ys.push(...a);
    }
    if (piece.length > from) groups.push({ ...g, from, to: piece.length });
  };
  const pending: { fs: SightFace[]; sub: number[][] }[] = [];
  for (const root0 of new Set(main.map((_, i) => find(i)))) {
    const idx = main.map((_, i) => i).filter((i) => find(i) === root0);
    const fs = idx.map((i) => main[i]);
    const sub = links.filter(([a, b]) => find(a) === root0 && find(b) === root0).map(([a, b, i, j]) => [idx.indexOf(a), idx.indexOf(b), i, j]);
    let root = -1;
    let rootCount = -1;
    fs.forEach((f, k) => {
      const n = f.ids.filter((x) => x >= 0).length;
      if (centerOf(f) >= 0 && n > rootCount) {
        root = k;
        rootCount = n;
      }
    });
    if (root < 0) {
      pending.push({ fs, sub });
      continue;
    }
    const face0 = centerOf(fs[root]);
    const options = [0, 1, 2, 3].map((r) => placeAll(fs, sub, root, face0, r));
    const valid = [0, 1, 2, 3].filter((r) => options[r]);
    if (valid.length === 1) {
      const placed = options[valid[0]]!;
      fs.forEach((f, k) => {
        const pl = placed[k];
        if (!pl) return;
        surePlaced.push({ slot: f.slot, face: pl.face, r: pl.r });
        usedFaces.add(pl.face);
      });
      addGroup({ mode: 0, face: face0, cr: 0, prior: [0, 0, 0, 0], faces: fs, placed: [placed, null, null, null] }, fs, [0]);
      continue;
    }
    if (valid.length > 1) {
      for (const r of valid) for (const pl of options[r]!) if (pl) usedFaces.add(pl.face);
      // 画像の上の向きの続き: 前のフレームで置いた同じ面の「上」の向きにいちばん近い置き方は 0、ほかは chainBits（その面だけが見えて
      // いるとき、その面を回したのか、キューブ全体をその面のまわりに回したのかを分ける。キューブ全体は 1 フレームで 90° は回らない）
      const m = mem?.faces[face0]?.sure;
      const prior = [0, 0, 0, 0];
      if (m && sight.t - m.t <= opts.chainMs && opts.chainBits > 0) {
        let r0 = valid[0];
        for (const r of valid) if (Math.cos(upAngle(fs[root].quad, options[r]![root]!.r) - m.ang) > Math.cos(upAngle(fs[root].quad, options[r0]![root]!.r) - m.ang)) r0 = r;
        for (const r of valid) prior[r] = r === r0 ? 0 : opts.chainBits;
      }
      addGroup({ mode: 1, face: face0, cr: fs[root].rot[4], prior, faces: fs, placed: options }, fs, valid);
    }
  }
  let orient = -1;
  let bestOk = 0;
  if (surePlaced.length)
    for (let o = 0; o < NUM_ORIENTATIONS; o++) {
      let ok = 0;
      for (const p of surePlaced) if (VIEW[o * 54 + p.slot * 9 + 4] === p.face * 9 + 4 && VIEW[o * 54 + p.slot * 9 + 1] === p.face * 9 + CELL_TURN[p.r * 9 + 1]) ok++;
      if (ok > bestOk) {
        bestOk = ok;
        orient = o;
      }
    }
  // センターのない面: 前のフレームで置いた同じ面（同じステッカーの ID が 2 つ以上・外枠の真ん中が近い）の続き
  if (mem)
    for (const { fs, sub } of pending) {
      let big = 0;
      for (let k = 1; k < fs.length; k++) if (directOf(fs[k]) > directOf(fs[big])) big = k;
      const f0 = fs[big];
      const c0 = quadCenter(f0.quad);
      const size = quadSize(f0.quad);
      let face = -1;
      let score = -Infinity;
      for (let F = 0; F < 6; F++) {
        const m = mem.faces[F];
        if (!m || usedFaces.has(F) || sight.t - m.t > opts.contMs) continue;
        const shared = f0.ids.filter((x) => x >= 0 && m.ids.includes(x)).length;
        const d = Math.hypot(c0[0] - m.c[0], c0[1] - m.c[1]) / Math.max(1, size);
        if (shared < 2 && d > 0.6) continue;
        const sc = shared * 2 - d;
        if (sc > score) {
          score = sc;
          face = F;
        }
      }
      if (face < 0) continue;
      const m = mem.faces[face]!;
      let r0 = 0;
      for (let r = 1; r < 4; r++) if (Math.cos(upAngle(f0.quad, r) - m.ang) > Math.cos(upAngle(f0.quad, r0) - m.ang)) r0 = r;
      const options = [0, 1, 2, 3].map((r) => placeAll(fs, sub, big, face, r));
      const valid = [0, 1, 2, 3].filter((r) => options[r]);
      if (!options[r0]) continue;
      usedFaces.add(face);
      addGroup({ mode: 2, face, cr: 0, prior: [0, 1, 2, 3].map((r) => (r === r0 ? 0 : options[r] ? opts.contBits : Infinity)), faces: fs, placed: options }, fs, valid);
    }
  // 1 列・1 枚の面: 同じフレームの置き方の決まった面から分かるカメラの姿勢とスロットで置く
  if (opts.held && orient >= 0)
    for (const f of sight.faces) {
      if (!f.held) continue;
      const face = Math.floor(VIEW[orient * 54 + f.slot * 9 + 4] / 9);
      if (usedFaces.has(face)) continue;
      let r = -1;
      for (let k = 0; k < 4; k++) if (face * 9 + CELL_TURN[k * 9 + 1] === VIEW[orient * 54 + f.slot * 9 + 1]) r = k;
      if (r < 0) continue;
      addGroup({ mode: 0, face, cr: 0, prior: [0, 0, 0, 0], faces: [f], placed: [[{ face, r }], null, null, null] }, [f], [0]);
    }
  return {
    t: sight.t,
    n: piece.length,
    piece: Int8Array.from(piece),
    cls: Uint8Array.from(cls),
    kind: Uint8Array.from(kind),
    ys: Int16Array.from(ys),
    groups,
    centers,
    orient,
    pieces: new Set(piece).size,
  };
}

// ---- 仮説 ----
interface MoveNode {
  move: number;
  t0: number;
  t: number;
  orient: number;
  inferred: boolean;
  prev: MoveNode | null;
  len: number;
}

export interface LiveBase {
  n: number;
  at: number;
  state: number[];
  t: number;
}

export interface LiveHyp {
  mask: Uint32Array; // ピースごとの取り得る位置（種類の中の番号のビット）。1 つだけなら決まっている
  guess: Uint8Array; // 3D に出す位置の見込み（決まらないピースも手に合わせて動かす。式には使わない）
  phi: Int8Array; // センターの向き（-1 = 分からない）
  miss: Uint8Array; // ピース（0〜19）・センター（20〜25）ごとの、読みと食い違い続けている枚数
  odd: Int8Array; // ピースごとの、置き方の決まった読みで仮説と食い違った位置（-1 = なし）
  oddN: Uint8Array; // その位置に続けて読めた回数（仮説と合う読みがあれば 0 に戻す）
  cost: number;
  last: number; // このフレームの食い違い（ビット）
  rs: Int8Array | null; // このフレームのまとまりごとの置き方（面の置き方の記憶に使う）
  tail: MoveNode | null;
  base: LiveBase | null; // 手順のつながらない所（見失い）。moves の at 番目より前の手を当てても base.state にならない
}

function keyOf(h: LiveHyp): string {
  let s = "";
  for (let k = 0; k < NUM_PIECES; k++) s += h.mask[k].toString(36) + ",";
  for (let f = 0; f < 6; f++) s += h.phi[f];
  return s;
}

// 状態 → ピースごとの位置のビット（色の組から同じピースを探す。ありえない色の組のピースは分からない）
export function hypOf(state: ArrayLike<number>): Uint32Array {
  const mask = new Uint32Array(NUM_PIECES);
  for (let k = 0; k < NUM_PIECES; k++) {
    const ref = PIECE_REF[k];
    let pos = -1;
    for (let x = 0; x < 54 && pos < 0; x++) if (CLS[x] === CLS[ref] && sameColors(state, ref, x)) pos = x;
    mask[k] = pos >= 0 ? 1 << IDX[pos] : FULL24;
  }
  return mask;
}

// facelet x とその相手の色が、揃った状態の ref とその相手の色と同じ並びか
function sameColors(state: ArrayLike<number>, ref: number, x: number): boolean {
  const home = [ref, ...PARTNERS[ref]];
  const at = [x, ...PARTNERS[x]];
  if (home.length !== at.length) return false;
  for (let j = 0; j < home.length; j++) if (state[at[j]] !== Math.floor(home[j] / 9)) return false;
  return true;
}

// 取り得る位置のビットを、表の行き先 img（base からの 24 個）で移す
function moveMask(img: Uint8Array, base: number, m: number): number {
  if (single(m)) return 1 << img[base + bitIndex(m)];
  if (m === FULL24) return FULL24;
  let out = 0;
  for (let x = m; x; x &= x - 1) out |= 1 << img[base + bitIndex(x & -x)];
  return out;
}

// 手順を当てる（ピースの取り得る位置・センターの向き。その場で書き換える）
const T1 = () => seqTable(1);
function applyMoves(mask: Uint32Array, phi: Int8Array, seq: readonly number[], guess?: Uint8Array): void {
  const tb = T1();
  for (const m of seq) {
    for (let p = 0; p < NUM_PIECES; p++) mask[p] = moveMask(tb.img, (m * 2 + clsOf(p)) * 24, mask[p]);
    if (guess) for (let p = 0; p < NUM_PIECES; p++) guess[p] = tb.img[(m * 2 + clsOf(p)) * 24 + guess[p]];
    const f = (m / 3) | 0;
    if (phi[f] >= 0) phi[f] = (phi[f] + (m % 3) + 1) & 3;
  }
}

// 決まったピースの場所を、同じ種類のほかのピースの取り得る位置から除く（同じ場所に 2 つはない）
function propagate(mask: Uint32Array): void {
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (let c = 0; c < 2; c++) {
      let taken = 0;
      for (let k = 0; k < NUM_PIECES; k++) if (clsOf(k) === c && single(mask[k])) taken |= PLACE[c][bitIndex(mask[k])];
      for (let k = 0; k < NUM_PIECES; k++) {
        if (clsOf(k) !== c || single(mask[k])) continue;
        const m = mask[k] & ~taken;
        if (m !== mask[k] && m) {
          mask[k] = m;
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

// 置き直した直後（relocate）: 決まらないピースが少ない（DEDUCE_MAX 個まで）とき、物理的にありえる状態（コーナーのねじれ・エッジの反転の和・偶奇）が 1 つしかなければ
// そこに決める（推測ではなく、ありえる置き方がほかにない）。2 つのコーナーだけが分からないとき、偶奇で入れ替わりが・ねじれの和で向きが決まる
// ピース p が位置 b（種類の中の番号）にあるときの場所（コーナー 0〜7・エッジ 0〜11）と向き（analyzeState と同じ決め方）。
// physical: 物理的にありえる = コーナーの向きの和 ≡ 0（mod 3）・エッジの向きの和 ≡ 0（mod 2）・場所の並べ替えの偶奇がコーナーとエッジで揃った状態と同じ
let ORI: { slot: Int8Array; ori: Int8Array; parity0: number } | null = null;
function oriTables(): NonNullable<typeof ORI> {
  if (ORI) return ORI;
  const slot = new Int8Array(NUM_PIECES * 24);
  const ori = new Int8Array(NUM_PIECES * 24);
  for (let p = 0; p < NUM_PIECES; p++) {
    const c = clsOf(p);
    const ref = PIECE_REF[p];
    const home = [ref, ...PARTNERS[ref]];
    const colors = home.map((x) => Math.floor(x / 9));
    const list = c === 0 ? CORNER_FACELETS : EDGE_FACELETS;
    for (let b = 0; b < 24; b++) {
      const x = positionOf(c, b);
      const at = [x, ...PARTNERS[x]];
      const colorAt = (q: number) => colors[at.indexOf(q)];
      const s = list.findIndex((fl) => fl.length === at.length && fl.every((q) => at.includes(q)));
      slot[p * 24 + b] = s;
      if (c === 0) ori[p * 24 + b] = list[s].findIndex((q) => colorAt(q) === 0 || colorAt(q) === 3);
      else {
        // エッジの最初の色: U/D の色があればそれ、なければ F/B の色
        const first = colors.find((f) => f === 0 || f === 3) ?? colors.find((f) => f === 2 || f === 5)!;
        ori[p * 24 + b] = colorAt(list[s][0]) === first ? 0 : 1;
      }
    }
  }
  ORI = { slot, ori, parity0: 0 };
  ORI.parity0 = physics(Array.from({ length: NUM_PIECES }, (_, p) => IDX[PIECE_REF[p]])).parity;
  return ORI;
}
function permParity(perm: number[]): number {
  let swaps = 0;
  const seen = new Array(perm.length).fill(false);
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = perm[j]) {
      seen[j] = true;
      len++;
    }
    swaps += len - 1;
  }
  return swaps & 1;
}
function physics(pos: ArrayLike<number>): { twist: number; flip: number; parity: number } {
  const t = ORI!;
  let twist = 0;
  let flip = 0;
  const pc: number[] = [];
  const pe: number[] = [];
  for (let p = 0; p < NUM_PIECES; p++) {
    const k = p * 24 + pos[p];
    if (clsOf(p) === 0) {
      twist += t.ori[k];
      pc.push(t.slot[k]);
    } else {
      flip += t.ori[k];
      pe.push(t.slot[k]);
    }
  }
  return { twist: twist % 3, flip: flip & 1, parity: (permParity(pc) + permParity(pe)) & 1 };
}
export const physical = (pos: ArrayLike<number>): boolean => {
  const t = oriTables();
  const v = physics(pos);
  return v.twist === 0 && v.flip === 0 && v.parity === t.parity0;
};

const DEDUCE_MAX = 3;
const DEDUCE_COMBOS = 216;
function deduce(mask: Uint32Array): void {
  const unk: number[] = [];
  for (let p = 0; p < NUM_PIECES; p++) if (!single(mask[p])) unk.push(p);
  if (!unk.length || unk.length > DEDUCE_MAX) return;
  let combos = 1;
  for (const p of unk) {
    let n = 0;
    for (let x = mask[p]; x; x &= x - 1) n++;
    combos *= n;
  }
  if (combos > DEDUCE_COMBOS) return;
  const pos = Array.from(mask, (m) => (single(m) ? bitIndex(m) : -1));
  const used = [0, 0];
  for (let p = 0; p < NUM_PIECES; p++) if (single(mask[p])) used[clsOf(p)] |= PLACE[clsOf(p)][bitIndex(mask[p])];
  let found: number[] | null = null;
  let count = 0;
  const walk = (k: number): void => {
    if (count > 1) return;
    if (k === unk.length) {
      if (physical(pos)) {
        count++;
        found = unk.map((p) => pos[p]);
      }
      return;
    }
    const p = unk[k];
    const c = clsOf(p);
    for (let x = mask[p] & ~used[c]; x; x &= x - 1) {
      const b = bitIndex(x & -x);
      used[c] |= PLACE[c][b];
      pos[p] = b;
      walk(k + 1);
      used[c] &= ~PLACE[c][b];
    }
    pos[p] = -1;
  };
  walk(0);
  if (count !== 1 || !found) return;
  const got: number[] = found;
  unk.forEach((p, k) => {
    mask[p] = 1 << got[k];
  });
}

export interface LiveStats {
  frames: number;
  steps: number;
  deep: number;
  deepSkipped: number;
  recovered: number;
  recoverTries: number;
  lost: number;
  relocated: number;
  merged: number;
  maxHyps: number;
  evals: number;
  timedOut: number; // 時間切れで長い手順を探さなかった回数
  ms: { pick: number; deep: number; child: number; recover: number; maxDeep: number; maxRecover: number };
  over: { pick: number; deep: number; child: number; recover: number }; // 2ms を超えたフレームの数（調査用）
}

interface Child {
  h: LiveHyp;
  hp: Int8Array;
  k: number;
  i: number; // 表の手順の番号（-1 = seq）
  seq?: number[];
  cost: number;
  last: number;
}

export class LiveState {
  readonly options: LiveStateOptions;
  hyps: LiveHyp[] = [];
  private lastT: number;
  orient: number; // カメラの姿勢（置き方の決まった面から。分からない間は前のまま）
  readonly memory = newFaceMemory();
  // 錨: 食い違いのない最後の仮説（見失ったところからの復帰の始まり）
  private anchor: { h: LiveHyp; t: number } | null = null;
  private lastRecover = -Infinity;
  readonly stats: LiveStats = { frames: 0, steps: 0, deep: 0, deepSkipped: 0, recovered: 0, recoverTries: 0, lost: 0, relocated: 0, merged: 0, maxHyps: 0, evals: 0, timedOut: 0, ms: { pick: 0, deep: 0, child: 0, recover: 0, maxDeep: 0, maxRecover: 0 }, over: { pick: 0, deep: 0, child: 0, recover: 0 } };
  private nBase = 0;

  // phi: センターの向きの初め（分からない面は -1。TrackerEngine が切り替える前のフレームで見たセンターの向きから）
  constructor(state: CubeState, orient: number, t: number, moves: DecodedMove[], base: LiveBase | null, options: Partial<LiveStateOptions> = {}, phi?: ArrayLike<number>) {
    this.options = { ...DEFAULT_LIVE_STATE, ...options };
    this.lastT = t;
    this.orient = orient;
    let tail: MoveNode | null = null;
    for (const m of moves) {
      const len: number = (tail?.len ?? 0) + 1;
      tail = { move: m.move, t0: m.t0 ?? m.t, t: m.t, orient: m.orient, inferred: !!m.inferred, prev: tail, len };
    }
    this.nBase = base?.n ?? 0;
    const mask0 = hypOf(state);
    const h: LiveHyp = { mask: mask0, guess: Uint8Array.from(mask0, (m) => (single(m) ? bitIndex(m) : 0)), phi: phi ? Int8Array.from(phi) : new Int8Array(6).fill(-1), miss: new Uint8Array(26), odd: new Int8Array(NUM_PIECES).fill(-1), oddN: new Uint8Array(NUM_PIECES), cost: 0, last: 0, rs: null, tail, base };
    this.hyps = [h];
    this.anchor = { h, t };
  }

  best(): LiveHyp {
    return this.hyps[0];
  }

  // 1 フレームの見え方（読みの式は liveFrame で。面の置き方の記憶はこの中で更新する）
  pushSight(sight: SightFrame): boolean {
    return this.push(liveFrame(sight, this.memory, this.options));
  }

  // 1 フレームの読み（式がなければ何もしない）
  push(fr: LiveFrame): boolean {
    this.stats.frames++;
    if (fr.orient >= 0) this.orient = fr.orient;
    if (!fr.n && !fr.centers.length) return false;
    this.stats.steps++;
    const o = this.options;
    const dt = Math.max(o.minDt, fr.t - this.lastT) / 1000;
    const lam = o.rate * dt;
    // k 手の手順 1 つのコスト: −log2(e^-λ λ^k / k!) + log2(N_k)。0 手を 0 にそろえる（どの仮説にも同じだけ足すもの）
    const moveBits: number[] = [];
    let logFact = 0;
    for (let k = 0; k <= MAX_DEEP; k++) {
      if (k) logFact += Math.log2(k);
      moveBits.push((lam - k * Math.log(lam)) / Math.LN2 + logFact + LOG2_NSEQ[k]);
    }
    for (let k = MAX_DEEP; k >= 0; k--) moveBits[k] -= moveBits[0];
    const parents = this.hyps;
    const children: Child[] = [];
    const glob = { best: Infinity };
    const bestOf: number[] = [];
    const tA = performance.now();
    for (const h of parents) bestOf.push(this.pick(h, fr, 0, o.maxK, moveBits, glob, children));
    // 深く照らす: 一番よい子でもこのフレームの読みと食い違う（3 手以上を 1 つの間に回した）
    let bestLast = Infinity;
    for (const c of children) if (c.cost <= glob.best + 1e-9) bestLast = Math.min(bestLast, c.last);
    const tB = performance.now();
    this.stats.ms.pick += tB - tA;
    if (bestLast >= o.deepAbove && o.deepK > o.maxK) {
      this.stats.deep++;
      const order = parents.map((h, i) => ({ h, c: bestOf[i] })).sort((a, b) => a.h.cost - b.h.cost).slice(0, o.deepHyps);
      const deadline = performance.now() + o.budgetMs;
      for (const { h } of order) {
        const hp = this.learnPhi(h, fr);
        const found = this.exact(h, hp, fr, o.maxK + 1, o.deepK, deadline);
        // 読みが少なくて深い手順が決まらない: 足さずに次の読みを待つ（食い違いのまま）
        if (!found || found.seqs.length > o.deepMax) {
          if (found) this.stats.deepSkipped++;
          continue;
        }
        for (const seq of found.seqs) {
          const last = this.scoreSeq(h, hp, fr, seq);
          const cost = h.cost + moveBits[seq.length] + last;
          if (cost > glob.best + o.keepBits) continue;
          children.push({ h, hp, k: seq.length, i: -1, seq, cost, last });
          if (cost < glob.best) glob.best = cost;
        }
      }
    }
    const tC = performance.now();
    this.stats.ms.deep += tC - tB;
    this.stats.ms.maxDeep = Math.max(this.stats.ms.maxDeep, tC - tB);
    // 子を作る
    const made = new Map<string, LiveHyp>();
    const t0 = this.lastT;
    for (const ch of children) {
      if (ch.cost > glob.best + o.keepBits) continue;
      const h = this.child(ch, fr, t0);
      const key = keyOf(h);
      const have = made.get(key);
      if (!have || h.cost < have.cost) made.set(key, h);
    }
    let next = [...made.values()].sort((a, b) => a.cost - b.cost);
    if (!next.length) next = parents;
    const off = next[0].cost;
    for (const h of next) h.cost -= off;
    next = next.filter((h) => h.cost <= o.keepBits);
    if (next.length > o.maxHyps) {
      // 膨らんだ: 一番よい仮説とほとんど同じ点数の仮説だけで上限を超えるなら（読みで決まらない）、ピースごとの取り得る位置の和に
      // まとめる（手順は一番よい仮説のもの）。そうでなければ点数の悪い方から落とす
      const ties = next.filter((h) => h.cost <= o.tieBits).length;
      if (ties > o.maxHyps) {
        this.stats.merged++;
        next = [this.mergeAll(next.slice(0, ties))];
      } else next = next.slice(0, o.maxHyps);
    }
    this.stats.maxHyps = Math.max(this.stats.maxHyps, next.length);
    this.hyps = next;
    this.lastT = fr.t;
    this.remember(fr);
    const tD = performance.now();
    this.stats.ms.child += tD - tC;
    this.afterStep(fr);
    const tE = performance.now();
    this.stats.ms.recover += tE - tD;
    const ov = this.stats.over;
    if (tB - tA > 2) ov.pick++;
    if (tC - tB > 2) ov.deep++;
    if (tD - tC > 2) ov.child++;
    if (tE - tD > 2) ov.recover++;
    this.stats.ms.maxRecover = Math.max(this.stats.ms.maxRecover, tE - tD);
    return true;
  }

  // センターの向きの分からない面がセンター 1 つで見えたら、仮説の今の状態（手なし）といちばん合う置き方から向きを決める
  // （置き方の決まった面でそのセンターを見るまで、その面の読みが使えないままになる）。3 枚以上合い、2 番目より 2 枚以上多いときだけ
  private learnPhi(h: LiveHyp, fr: LiveFrame): Int8Array {
    let hp = h.phi;
    for (const g of fr.groups) {
      if (g.mode !== 1 || hp[g.face] >= 0) continue;
      const score = [0, 0, 0, 0];
      for (let q = g.from; q < g.to; q++) {
        const m = h.mask[fr.piece[q]];
        if (!single(m)) continue;
        for (let r = 0; r < 4; r++) if (fr.ys[q * 4 + r] >= 0 && (m >>> fr.ys[q * 4 + r]) & 1) score[r]++;
      }
      let br = 0;
      for (let r = 1; r < 4; r++) if (score[r] > score[br]) br = r;
      const second = Math.max(...score.filter((_, r) => r !== br));
      if (score[br] >= 3 && score[br] >= second + 2) {
        if (hp === h.phi) hp = h.phi.slice();
        hp[g.face] = (g.cr - br + 8) & 3;
      }
    }
    return hp;
  }

  // 仮説 h の、k0〜k1 手の子を照らす。返すのは一番よい子のコスト
  private pick(h: LiveHyp, fr: LiveFrame, k0: number, k1: number, moveBits: number[], glob: { best: number }, out: Child[]): number {
    const o = this.options;
    const hp = this.learnPhi(h, fr);
    const inc = new Float32Array(fr.n);
    for (let j = 0; j < fr.n; j++) inc[j] = MISS_INC[fr.kind[j]][Math.min(255, h.miss[fr.piece[j]] + 1)];
    const cinc = fr.centers.map((ce) => (hp[ce.f] < 0 ? 0 : MISS_INC[KIND_CENTER][Math.min(255, h.miss[20 + ce.f] + 1)]));
    const local: { k: number; i: number; cost: number; last: number }[] = [];
    let localBest = Infinity;
    const G = fr.groups.length;
    const v = new Float64Array(4);
    for (let k = k0; k <= k1; k++) {
      const tb = seqTable(k);
      const mb = moveBits[k];
      const inv = tb.inv;
      const amt = tb.amount;
      for (let i = 0; i < tb.n; i++) {
        const limit = Math.min(localBest + o.childBits, glob.best + o.keepBits);
        const c0 = h.cost + mb;
        if (c0 > limit) break;
        let last = 0;
        for (let gi = 0; gi < G && c0 + last <= limit; gi++) {
          const g = fr.groups[gi];
          if (g.mode === 2) {
            v[0] = g.prior[0];
            v[1] = g.prior[1];
            v[2] = g.prior[2];
            v[3] = g.prior[3];
            for (let j = g.from; j < g.to; j++) {
              const base = (i * 2 + fr.cls[j]) * 24;
              const m = h.mask[fr.piece[j]];
              for (let r = 0; r < 4; r++) {
                const y = fr.ys[j * 4 + r];
                if (y < 0 || !((m >>> inv[base + y]) & 1)) v[r] += inc[j];
              }
            }
            last += Math.min(v[0], v[1], v[2], v[3], o.contCap);
            continue;
          }
          let r = 0;
          if (g.mode === 1) {
            const ph = hp[g.face];
            if (ph < 0) continue;
            r = (g.cr - ph - amt[i * 6 + g.face] + 8) & 3;
            last += g.prior[r];
          }
          for (let j = g.from; j < g.to; j++) {
            const y = fr.ys[j * 4 + r];
            if (y < 0 || !((h.mask[fr.piece[j]] >>> inv[(i * 2 + fr.cls[j]) * 24 + y]) & 1)) last += inc[j];
          }
        }
        for (let j = 0; j < fr.centers.length; j++) {
          const ce = fr.centers[j];
          const ph = hp[ce.f];
          if (ph >= 0 && ((ph + amt[i * 6 + ce.f]) & 3) !== ce.phi) last += cinc[j];
        }
        this.stats.evals++;
        const c = c0 + last;
        if (c > limit) continue;
        local.push({ k, i, cost: c, last });
        if (c < localBest) localBest = c;
        if (c < glob.best) glob.best = c;
      }
    }
    // 子に残すのは、一番よい子から childBits 以内で、手の少ない子より読みとよく合うもの（隠れた層の手を足しただけの子は作らない。
    // その手が後で見えたら、そのときに足す）
    let fewer = Infinity;
    let curK = -1;
    let atK = Infinity;
    for (const x of local) {
      if (x.k !== curK) {
        fewer = Math.min(fewer, atK);
        atK = Infinity;
        curK = x.k;
      }
      if (x.cost <= localBest + o.childBits && x.last < fewer - 1e-6) out.push({ h, hp, ...x });
      atK = Math.min(atK, x.last);
    }
    return localBest;
  }

  // 読みの式を全部満たす k0〜k1 手の手順（表の AND・5 手からは前後の突き合わせ）。いちばん短いものだけ。センター 1 つの面は、
  // 置き方 r ごとに「その面を回した量 ≡ 読んだ向き − r − φ」を足した式の組。センターのない面（続きの置き方）は使わない
  // deadline（performance.now()）を過ぎたら、それより長い手順は探さない（次の読みでまた探す）
  private exact(h: LiveHyp, hp: Int8Array, fr: LiveFrame, k0: number, k1: number, deadline = Infinity): { seqs: number[][] } | null {
    type PEq = Eq & { p: number; y: number };
    const addEq = (list: PEq[], p: number, y: number) => {
      const m = h.mask[p];
      if (!single(m) || y < 0) return;
      list.push({ from: positionOf(clsOf(p), bitIndex(m)), to: positionOf(clsOf(p), y), w: 1, p, y });
    };
    const base: PEq[] = [];
    const centers: CenterEq[] = [];
    for (const g of fr.groups) if (g.mode === 0) for (let j = g.from; j < g.to; j++) addEq(base, fr.piece[j], fr.ys[j * 4]);
    for (const ce of fr.centers) if (hp[ce.f] >= 0) centers.push({ f: ce.f, d: (ce.phi - hp[ce.f] + 4) & 3, w: 1 });
    const chain = fr.groups.filter((g) => g.mode === 1 && hp[g.face] >= 0).sort((a, b) => b.to - b.from - (a.to - a.from))[0];
    // 同じピースの読みが食い違えば、そのピースは使わない。同じ式は 1 本に
    const clean = (list: PEq[]): Eq[] => {
      const out = new Map<number, PEq>();
      const bad = new Set<number>();
      for (const e of list) {
        const prev = out.get(e.p);
        if (prev && prev.y !== e.y) bad.add(e.p);
        out.set(e.p, e);
      }
      return [...out.values()].filter((e) => !bad.has(e.p));
    };
    const variants: { eqs: Eq[]; centers: CenterEq[] }[] = [];
    if (chain)
      for (let r = 0; r < 4; r++) {
        const eqs: PEq[] = [...base];
        for (let j = chain.from; j < chain.to; j++) addEq(eqs, fr.piece[j], fr.ys[j * 4 + r]);
        variants.push({ eqs: clean(eqs), centers: [...centers, { f: chain.face, d: (chain.cr - r - hp[chain.face] + 8) & 3, w: 1 }] });
      }
    else variants.push({ eqs: clean(base), centers });
    const pieces = Math.max(...variants.map((v) => v.eqs.length));
    if (pieces < this.options.recoverMin) return null;
    for (let k = k0; k <= k1; k++) {
      if (k > 4 && performance.now() > deadline) {
        this.stats.timedOut++;
        return null;
      }
      const out: number[][] = [];
      for (const v of variants) out.push(...solveExact(k, v.eqs, v.centers, this.options.deepMax + 1));
      if (out.length) return { seqs: out };
    }
    // どの手数でも全部は満たせない（読み違いがある）: 式を 1 本外して、表の範囲（4 手まで）で
    if (pieces < this.options.recoverMin + 2) return null;
    for (let k = k0; k <= Math.min(4, k1); k++) {
      const out: number[][] = [];
      for (const v of variants) for (let e = 0; e < v.eqs.length && out.length <= this.options.deepMax; e++) out.push(...solveExact(k, v.eqs.filter((_, q) => q !== e), v.centers, this.options.deepMax + 1));
      if (out.length) {
        const seen = new Set<string>();
        return { seqs: out.filter((x) => !seen.has(x.join()) && !!seen.add(x.join())) };
      }
    }
    return null;
  }

  // 手順 seq を当てたときの、このフレームの読みとの食い違い（ビット）
  private scoreSeq(h: LiveHyp, hp: Int8Array, fr: LiveFrame, seq: number[]): number {
    const mask = h.mask.slice();
    const phi = hp.slice();
    applyMoves(mask, phi, seq);
    let last = 0;
    const inc = (j: number) => MISS_INC[fr.kind[j]][Math.min(255, h.miss[fr.piece[j]] + 1)];
    for (const g of fr.groups) {
      if (g.mode === 2) {
        let best = this.options.contCap;
        for (let r = 0; r < 4; r++) {
          let v = g.prior[r];
          for (let j = g.from; j < g.to; j++) {
            const y = fr.ys[j * 4 + r];
            if (y < 0 || !((mask[fr.piece[j]] >>> y) & 1)) v += inc(j);
          }
          best = Math.min(best, v);
        }
        last += best;
        continue;
      }
      let r = 0;
      if (g.mode === 1) {
        if (phi[g.face] < 0) continue;
        r = (g.cr - phi[g.face] + 8) & 3;
        last += g.prior[r];
      }
      for (let j = g.from; j < g.to; j++) {
        const y = fr.ys[j * 4 + r];
        if (y < 0 || !((mask[fr.piece[j]] >>> y) & 1)) last += inc(j);
      }
    }
    for (const ce of fr.centers) if (phi[ce.f] >= 0 && phi[ce.f] !== ce.phi) last += MISS_INC[KIND_CENTER][Math.min(255, h.miss[20 + ce.f] + 1)];
    return last;
  }

  private child(ch: Child, fr: LiveFrame, t0: number): LiveHyp {
    const { h, k, i } = ch;
    const seq = ch.seq ?? (k ? Array.from(seqTable(k).moves.subarray(i * k, (i + 1) * k)) : []);
    const mask = h.mask.slice();
    const phi = ch.hp.slice();
    const guess = h.guess.slice();
    applyMoves(mask, phi, seq, guess);
    const miss = h.miss.slice();
    const odd = h.odd.slice();
    const oddN = h.oddN.slice();
    const rs = new Int8Array(fr.groups.length).fill(-1);
    let multi = false;
    fr.groups.forEach((g, gi) => {
      let r = 0;
      if (g.mode === 1) {
        if (phi[g.face] < 0) return;
        r = (g.cr - phi[g.face] + 8) & 3;
      } else if (g.mode === 2) {
        // いちばん合う置き方。どれでも合わない（面の取り違え）なら使わない
        let best = Infinity;
        for (let rr = 0; rr < 4; rr++) {
          let v = g.prior[rr];
          for (let j = g.from; j < g.to; j++) {
            const y = fr.ys[j * 4 + rr];
            if (y < 0 || !((mask[fr.piece[j]] >>> y) & 1)) v += MISS_INC[fr.kind[j]][1];
          }
          if (v < best) {
            best = v;
            r = rr;
          }
        }
        if (best >= this.options.contCap) return;
      }
      rs[gi] = r;
      // 置き直しに数える読み: 置き方の決まったまとまり（fixChain ならセンター 1 つのまとまりも、ほかの読みが fixAgree 以上合い、
      // 食い違うのが 1 つだけのとき: 置き方は合っていてそのピースだけが違う）
      let fixable = g.mode === 0;
      if (g.mode === 1 && this.options.fixChain) {
        let ok = 0;
        let bad = 0;
        for (let j = g.from; j < g.to; j++) {
          const y = fr.ys[j * 4 + r];
          if (y >= 0 && (mask[fr.piece[j]] >>> y) & 1) ok++;
          else bad++;
        }
        fixable = bad === 1 && ok >= this.options.fixAgree;
      }
      for (let j = g.from; j < g.to; j++) {
        const p = fr.piece[j];
        const y = fr.ys[j * 4 + r];
        if (y >= 0 && (mask[p] >>> y) & 1) {
          if (!single(mask[p])) {
            mask[p] = 1 << y;
            multi = true;
          }
          guess[p] = y;
          miss[p] = 0;
          oddN[p] = 0;
        } else {
          miss[p] = Math.min(255, miss[p] + 1);
          if (fixable && y >= 0) {
            if (odd[p] === y) oddN[p] = Math.min(255, oddN[p] + 1);
            else {
              odd[p] = y;
              oddN[p] = 1;
            }
          }
        }
      }
    });
    for (const ce of fr.centers) {
      if (phi[ce.f] < 0) {
        phi[ce.f] = ce.phi;
        miss[20 + ce.f] = 0;
      } else if (phi[ce.f] === ce.phi) miss[20 + ce.f] = 0;
      else miss[20 + ce.f] = Math.min(255, miss[20 + ce.f] + 1);
    }
    if (multi) propagate(mask);
    let tail = h.tail;
    for (let j = 0; j < seq.length; j++) {
      const a = t0 + ((fr.t - t0) * j) / seq.length;
      const b = t0 + ((fr.t - t0) * (j + 1)) / seq.length;
      tail = { move: seq[j], t0: a, t: b, orient: this.orient, inferred: false, prev: tail, len: (tail?.len ?? 0) + 1 };
    }
    return { mask, guess, phi, miss, odd, oddN, cost: ch.cost, last: ch.last, rs, tail, base: h.base };
  }

  // 一番よい仮説の置き方で、面の置き方を覚える（センターの見えない面の続きに使う）
  private remember(fr: LiveFrame): void {
    const b = this.hyps[0];
    fr.groups.forEach((g, gi) => {
      const r = b.rs?.[gi] ?? -1;
      if (r < 0) return;
      const placed = g.placed[r];
      if (!placed) return;
      g.faces.forEach((f, k) => {
        const pl = placed[k];
        if (!pl || f.quad?.length !== 8 || f.held) return;
        const ang = upAngle(f.quad, pl.r);
        // センター 1 つの面は、仮説の置き方が続きと同じ（キューブ全体は回っていない）ときだけ続きを延ばす
        const keep = (g.mode === 0 && g.faces.length > 1) || (this.options.chainRefresh && g.mode === 1 && k === 0 && g.prior.some((x) => x > 0) && g.prior[r] === 0);
        const sure = keep ? { t: fr.t, ang } : (this.memory.faces[pl.face]?.sure ?? null);
        this.memory.faces[pl.face] = { t: fr.t, c: quadCenter(f.quad), size: quadSize(f.quad), ang, ids: f.ids.filter((x) => x >= 0), sure };
      });
    });
  }

  // 仮説をまとめる: ピースごとの取り得る位置の和・センターの向きは合っているものだけ
  private mergeAll(hs: LiveHyp[]): LiveHyp {
    const b = hs[0];
    const mask = new Uint32Array(NUM_PIECES);
    const phi = b.phi.slice();
    for (const h of hs) {
      for (let p = 0; p < NUM_PIECES; p++) mask[p] |= h.mask[p];
      for (let f = 0; f < 6; f++) if (h.phi[f] !== phi[f]) phi[f] = -1;
    }
    propagate(mask);
    return { mask, guess: b.guess.slice(), phi, miss: b.miss.slice(), odd: b.odd.slice(), oddN: b.oddN.slice(), cost: 0, last: b.last, rs: b.rs, tail: b.tail, base: b.base };
  }

  private afterStep(fr: LiveFrame): void {
    const o = this.options;
    const b = this.hyps[0];
    // 錨: このフレームの読みと食い違わず、決まったピースだけの仮説
    if (b.last < 1 && fr.pieces >= 4 && b.mask.every(single)) this.anchor = { h: b, t: fr.t };
    // 一番よい仮説でも食い違いが続く: 錨から読めたピースが全部合う手順を探す。見つからなければ、読めたピースを読みの位置にする
    const bad = b.miss.reduce((n, m, k) => n + (m >= 2 && k < 20 ? 1 : 0), 0);
    // 決まらないピースのある仮説（まとめた・見失った）も、錨からつなぎ直せれば決まった仮説に戻す
    if (((b.last >= o.deepAbove && bad >= 1) || !b.mask.every(single)) && this.recover(fr)) return;
    let missBits = 0;
    for (let k = 0; k < 26; k++) if (b.miss[k] >= 2) missBits += W[k < 20 ? KIND_DIRECT : KIND_CENTER][lenBucket(b.miss[k])];
    if (missBits >= o.lostBits) this.teleport(fr);
    else this.relocate(b, fr);
    this.preferSolved(fr);
  }

  // 揃った: 一番よい仮説が揃っていない（見失った後で、見えていないピースが分からない・推測のまま・読みと食い違う）のに、置き方の決まった読みが solvedMin 個
  // 以上あってどれも揃った位置なら、揃った状態の仮説を一番にする（手順はここでつながらない。止める判定にも使う）
  private preferSolved(fr: LiveFrame): void {
    const b = this.hyps[0];
    // 決まった仮説が読みと合っているなら使わない（隠れた面の最後の手の前に揃いにしない: 合成のタイマーで 0.9 秒早く止まった）
    if (this.solved() || (this.known(b) && b.last < this.options.deepAbove)) return;
    const read = this.sureReads(fr, b, [0, 1]);
    if (read.size < this.options.solvedMin) return;
    for (const [p, y] of read) if (y !== IDX[PIECE_REF[p]]) return;
    const mask = Uint32Array.from({ length: NUM_PIECES }, (_, p) => 1 << IDX[PIECE_REF[p]]);
    const h: LiveHyp = { mask, guess: Uint8Array.from(mask, (m) => bitIndex(m)), phi: b.phi.slice(), miss: new Uint8Array(26), odd: new Int8Array(NUM_PIECES).fill(-1), oddN: new Uint8Array(NUM_PIECES), cost: 0, last: 0, rs: b.rs, tail: b.tail, base: { n: ++this.nBase, at: b.tail?.len ?? 0, state: Array.from(solvedState()), t: fr.t } };
    this.stats.lost++;
    this.hyps = [h, ...this.hyps.map((x) => ({ ...x, cost: x.cost + 4 }))].slice(0, this.options.maxHyps);
  }

  // 置き方の決まった読み（一番よい仮説の置き方で）: ピース → 位置
  private sureReads(fr: LiveFrame, h: LiveHyp, modes: number[]): Map<number, number> {
    const read = new Map<number, number>();
    fr.groups.forEach((g, gi) => {
      if (!modes.includes(g.mode)) return;
      const r = g.mode === 0 ? 0 : (h.rs?.[gi] ?? -1);
      if (r < 0) return;
      for (let j = g.from; j < g.to; j++) if (fr.ys[j * 4 + r] >= 0 && !read.has(fr.piece[j])) read.set(fr.piece[j], fr.ys[j * 4 + r]);
    });
    return read;
  }

  // 見失ったところからの復帰（表で）: 錨の状態から、このフレームの読みが全部合う k 手の手順（k = 1〜recoverK）
  private recover(fr: LiveFrame): boolean {
    const o = this.options;
    const a = this.anchor;
    if (!a || fr.t - a.t > o.recoverMs || fr.t - this.lastRecover < o.recoverGapMs) return false;
    this.lastRecover = fr.t;
    this.stats.recoverTries++;
    const found = this.exact(a.h, a.h.phi, fr, 1, o.recoverK, performance.now() + o.budgetMs);
    if (!found || found.seqs.length > 4) return false;
    const added = found.seqs.map((seq) => this.applySeq(a.h, seq, a.t, fr.t));
    this.stats.recovered++;
    this.hyps = [...added, ...this.hyps.map((h) => ({ ...h, cost: h.cost + 2 }))].slice(0, o.maxHyps);
    this.anchor = { h: added[0], t: fr.t };
    return true;
  }

  private applySeq(h: LiveHyp, seq: number[], t0: number, t1: number): LiveHyp {
    const mask = h.mask.slice();
    const phi = h.phi.slice();
    const guess = h.guess.slice();
    let tail = h.tail;
    applyMoves(mask, phi, seq, guess);
    seq.forEach((m, j) => {
      const a = t0 + ((t1 - t0) * j) / seq.length;
      const b = t0 + ((t1 - t0) * (j + 1)) / seq.length;
      tail = { move: m, t0: a, t: b, orient: this.orient, inferred: true, prev: tail, len: (tail?.len ?? 0) + 1 };
    });
    return { mask, guess, phi, miss: new Uint8Array(26), odd: new Int8Array(NUM_PIECES).fill(-1), oddN: new Uint8Array(NUM_PIECES), cost: 0, last: 0, rs: h.rs, tail, base: h.base };
  }

  // 見失った: 一番よい仮説の、食い違い続けているピースを読みの位置にし、そこにいたはずのピースは「分からない」にする
  // （見えていないピースを推測で埋めない）。手順はここでつながらない（base）
  private teleport(fr: LiveFrame): void {
    const b = this.hyps[0];
    const mask = b.mask.slice();
    const phi = b.phi.slice();
    const read = this.sureReads(fr, b, [0, 1, 2]);
    for (const ce of fr.centers) phi[ce.f] = ce.phi;
    for (let c = 0; c < 2; c++) {
      let taken = 0;
      for (const [p, y] of read) if (clsOf(p) === c) taken |= PLACE[c][y];
      for (let p = 0; p < NUM_PIECES; p++) {
        if (clsOf(p) !== c) continue;
        const y = read.get(p);
        if (y !== undefined) mask[p] = 1 << y;
        else if (mask[p] & taken) mask[p] = FULL24 & ~taken;
      }
    }
    // 読めていないピースは分からない（推測で埋めない。3D は前に出した位置のまま: display）
    for (let p = 0; p < NUM_PIECES; p++) if (!read.has(p) && (this.options.lostAll || b.miss[p] >= 2)) mask[p] = FULL24;
    propagate(mask);
    this.stats.lost++;
    const guess = b.guess.slice();
    for (const [p, y] of read) guess[p] = y;
    this.jump(b, mask, phi, guess, fr);
  }

  // 一番よい仮説から、状態を手なしで変えた仮説を作って一番にする（手順はここでつながらない: base。元の仮説も残す）
  private jump(b: LiveHyp, mask: Uint32Array, phi: Int8Array, guess: Uint8Array, fr: LiveFrame): void {
    const h: LiveHyp = { mask, guess, phi, miss: new Uint8Array(26), odd: new Int8Array(NUM_PIECES).fill(-1), oddN: new Uint8Array(NUM_PIECES), cost: 0, last: 0, rs: b.rs, tail: b.tail, base: { n: ++this.nBase, at: b.tail?.len ?? 0, state: [], t: fr.t } };
    h.base!.state = Array.from(this.display(h));
    this.hyps = [h, ...this.hyps.map((x) => ({ ...x, cost: x.cost + 4 }))].slice(0, this.options.maxHyps);
    this.anchor = null;
  }

  // 置き直す: 置き方の決まった読みで fixRun 回続けて同じ位置に読めたのに仮説と食い違うピースを、その位置にする。そこ（同じキュービー）に
  // いたはずのピースは「分からない」（ほかの決まったピースの場所を除く）。読めていないほかのピースはそのまま
  private relocate(b: LiveHyp, fr: LiveFrame): boolean {
    const o = this.options;
    if (!o.fixRun) return false;
    const fix: number[] = [];
    for (let p = 0; p < NUM_PIECES; p++) if (b.oddN[p] >= o.fixRun && b.odd[p] >= 0) fix.push(p);
    if (!fix.length) return false;
    const mask = b.mask.slice();
    const guess = b.guess.slice();
    const freed = [0, 0];
    for (const p of fix) {
      mask[p] = 1 << b.odd[p];
      guess[p] = b.odd[p];
      freed[clsOf(p)] |= PLACE[clsOf(p)][b.odd[p]];
    }
    for (let c = 0; c < 2; c++) {
      if (!freed[c]) continue;
      let taken = 0;
      for (let p = 0; p < NUM_PIECES; p++) if (clsOf(p) === c && single(mask[p]) && (fix.includes(p) || !(mask[p] & freed[c]))) taken |= PLACE[c][bitIndex(mask[p])];
      for (let p = 0; p < NUM_PIECES; p++) {
        if (clsOf(p) !== c || fix.includes(p) || !(mask[p] & freed[c])) continue;
        mask[p] = (single(mask[p]) ? 0 : mask[p] & ~freed[c]) || FULL24 & ~taken;
      }
    }
    propagate(mask);
    // 置き直した直後だけ、物理的にありえる置き方で決まるピースを決める（ふだんの仮説で使うと、決まったピースが間違っているときに、
    // たまたま合っていた 3D の見込みを間違った位置で上書きした: 35 通りの IMG_5046 の 1 秒 6 枚で 52.9 → 34.0%）
    deduce(mask);
    this.stats.relocated++;
    this.jump(b, mask, b.phi.slice(), guess, fr);
    return true;
  }

  // 3D に出す状態: 決まったピースはその位置、決まらないピースは前に出した位置（取り得る位置にあって空いていれば）か、空いている取り得る位置
  private shown: Uint32Array | null = null;
  display(h: LiveHyp = this.hyps[0]): CubeState {
    const prev = this.shown;
    const pos = new Int16Array(NUM_PIECES).fill(-1);
    const used = [0, 0];
    for (let p = 0; p < NUM_PIECES; p++)
      if (single(h.mask[p])) {
        pos[p] = bitIndex(h.mask[p]);
        used[clsOf(p)] |= PLACE[clsOf(p)][pos[p]];
      }
    for (let p = 0; p < NUM_PIECES; p++) {
      if (pos[p] >= 0) continue;
      const c = clsOf(p);
      const free = h.mask[p] & ~used[c];
      let pick = -1;
      if (free & (1 << h.guess[p])) pick = h.guess[p];
      else if (prev && single(prev[p]) && free & prev[p]) pick = bitIndex(prev[p]);
      if (pick < 0) {
        const cand = free || (FULL24 & ~used[c]);
        if (cand) pick = bitIndex(cand & -cand);
      }
      if (pick < 0) pick = bitIndex(h.mask[p] & -h.mask[p]);
      pos[p] = pick;
      used[c] |= PLACE[c][pick];
    }
    this.shown = Uint32Array.from(pos, (x) => 1 << x);
    return toCubeState(Array.from(pos, (x, p) => positionOf(clsOf(p), x)));
  }

  moves(h: LiveHyp = this.hyps[0]): DecodedMove[] {
    const out: DecodedMove[] = [];
    for (let n = h.tail; n; n = n.prev) out.push({ move: n.move, t0: n.t0, t: n.t, orient: n.orient, ...(n.inferred ? { inferred: true } : {}) });
    return out.reverse();
  }

  // 一番よい仮説から agreeBits 以内の仮説がどれも同じ手順になっている手の数（3D で回して見せてよい手）
  agreed(): number {
    const b = this.hyps[0];
    const near = this.hyps.filter((h) => h.cost <= b.cost + this.options.agreeBits);
    const lists = near.map((h) => {
      const arr: MoveNode[] = [];
      for (let n = h.tail; n; n = n.prev) arr.push(n);
      return arr.reverse();
    });
    let n = lists[0].length;
    for (const l of lists) {
      let k = 0;
      while (k < n && k < l.length && (l[k] === lists[0][k] || (l[k].move === lists[0][k].move && Math.abs(l[k].t - lists[0][k].t) < 1))) k++;
      n = k;
    }
    return n;
  }

  solved(): boolean {
    const b = this.hyps[0];
    return this.known(b) && isSolved(this.stateOf(b));
  }

  known(h: LiveHyp = this.hyps[0]): boolean {
    return h.mask.every(single);
  }

  stateOf(h: LiveHyp): CubeState {
    return toCubeState(Array.from(h.mask, (m, p) => positionOf(clsOf(p), single(m) ? bitIndex(m) : 0)));
  }
}
