// 確かな所から埋める手順の再構成（精密解析の解き直し。anchors.ts の作り直し）。
//
// 考え方（数独のように、確かな所から埋める）:
// - フレームの読みを「どのステッカーがいつカメラのどのマスに見えたか」として使う。状態は「キューブの各 facelet にあるステッカー」で
//   持ち、姿勢はフレームごとに自由（読めたセンターに合う姿勢のうち一番合うもの）。面の割り当てが 1 枚だけ入れ替わっても困らない。
// - 使う読みは、マーカーを直接読んだマス（引き継いだ ID は使わない）で、4 マス以上読めた面だけ（1〜3 マスの欠片はどの面かを
//   取り違える: tests/debug/misread.debug.test.ts）。
// - アンカー: 続いた 2 枚のフレームの両方で同じマスに読めたステッカー（5 枚以上）。1 枚のフレームの中で同時に見えた読みなので、
//   回す前と後の読みが混ざらない。アンカーからアンカーへは、読みと食い違わない手順を残す。捨てるのは証拠があるときだけ:
//   ・アンカーの読みと合わない
//   ・間のフレームの読みと、許容（tolerance）を超えて食い違う。止まっている区間は状態どおり、回している途中のフレームは動かない
//     マスはそのまま・動くマスは回す前か後のどちらか。同じマスに同じ読みが続いたら 1 つの証拠（続いた枚数で割る: 読み違いも続く）
//   ・毎フレーム途切れずに同じマスに読めたステッカーのある面は回っていない（その面の手は探さない）
//   ・間の時間に入らない手数
// - 仮定: アンカーの間の手順は、読みに合う一番短いものと、その +extra 手まで（もっと長い手順は無数にある）。
// - アンカーは絶対ではない: 原画質でも 15% ほどは正解の状態と合わない（面を別のスロットに割り当てた・回している層の途中の読み:
//   tests/debug/anchorCheck.debug.test.ts）。どの候補も合わないアンカーは飛ばす。
// - 始まりから前向き、終わり（完成）から後ろ向きに同じことをして、同じアンカーで同じ状態になる所でつなぐ。手の数 + 食い違いが
//   一番小さい道を出し、それと altSlack 以内の別の道があれば、違う所の手は推定（inferred）にする（1 通りに決まっていない）。
// - 前後が出会わなければ、両側の状態を一番短い手順でつないで推定にする。それもできなければ「届かない」。
// 悪い画質（1.5Mbps 以下）では、2 枚続けて同じに読み違えたアンカーに間違った手順だけが合い、正解が候補から落ちる。本体からは
// 使わない（確認役 verifyMoves は外した）。正解づくり（tests/debug/buildTruth.debug.test.ts）と比較のベンチで使う。
//
// カメラも DOM も知らない（Node で動く）。
import { type CubeState, MOVE_DEST, NORMAL, NUM_MOVES, OPPOSITE, VIEW, faceletGeometry, inverseMove, moveFace } from "../cube/model";
import { stickerIds } from "../cube/stickers";
import type { DecodedMove } from "./types";

export interface Sighting {
  t: number;
  // w: マスごとの読みの確からしさ（FrameReading.weight）。マーカーを直接読んだマスは 0.9〜1、前のフレームから引き継いだ ID は 0.7 以下
  faces: { slot: number; ids?: ArrayLike<number> | null; w?: ArrayLike<number> | null }[];
}

export interface ExactOptions {
  minWeight: number; // 使う読みの確からしさ（引き継いだ ID は使わない）
  minFace: number; // 使う面の、読めたマスの数（1〜3 マスの欠片はどの面かを取り違える）
  minIds: number; // アンカーにする、2 枚続けて読めたステッカー（センター以外）の数
  pairMs: number; // アンカーのフレームの間
  anchorFrames: number; // アンカーにする、続けて同じに読めたフレームの数
  hardFrames: number; // これだけ続けて同じに読めた読みは、アンカーでなくても絶対の条件にする（0 = しない。正解づくり用）
  lockMs: number; // 回っていないとみなすのに、フレームの間がこれ以下であること
  msPerMove: number; // 間の時間から手の数の上限を決める（間 / msPerMove + 1 手まで）
  maxDepth: number; // アンカーの間の手の数の上限
  extra: number; // 一番短い手順より何手長いものまで残すか
  extraMax: number; // extra を足して探す長さの上限
  tolerance: number; // 1 つのつなぎで許す読みの食い違い（これに、つなぎの間の読みの量 × misreadRate を足す）
  misreadRate: number; // 読み違いの割合の見込み（0 = 足さない。0.03 にすると、読み違いを手で説明する道も残って原画質のソルブで間違えた）
  turnFrameCost: number; // 回している途中に割り当てたフレーム 1 枚のコスト
  frameCap: number; // 1 フレームの食い違いの上限
  maxSet: number; // アンカーごとに残す状態の上限（超えたら、手の数 + 食い違いの小さい順に残す。256 では 2 倍遅く、正しさは同じ）
  slack: number; // つながった仮説より、手の数 + 食い違いがこれを超えて大きくなる深い探索はしない
  altSlack: number; // 別の道の手の数 + 食い違いが、選んだ道よりこれ以内なら「1 通りに決まらない」とみる
  deepHyps: number; // どの仮説も浅くはつながらないとき、深く探す仮説の数
  maxNodes: number; // 1 回の探索で作る節点の上限
  maxSkip: number; // 続けて通り過ぎてよいアンカーの数
  skipCost: number; // アンカーを通り過ぎるコスト（Infinity = 通り過ぎない。1 にすると候補が増えすぎ、原画質のソルブでも 120 秒で終わらなかった）
  bridgeDepth: number; // 前向きと後ろ向きが出会わないとき、両側の状態をつなぐ手の数の上限
  budgetMs: number; // 全体の時間の上限
  tick?: () => void;
  debug?: (msg: string) => void;
  // 調べ用: 本当の手順（キューブ固定の手）。正解の状態が候補から落ちたアンカーで、どの決まりで落ちたかを debug に出す
  truth?: number[];
  // 調べ用: アンカーごとに残った仮説（キューブ固定の状態・手の数・食い違い）
  onAnchor?: (info: { backward: boolean; index: number; t: number; stickers: number; hyps: { state: CubeState; moves: number[]; viol: number }[] }) => void;
}

export const DEFAULT_EXACT: ExactOptions = {
  minWeight: 0.85,
  minFace: 4,
  minIds: 5,
  pairMs: 260,
  anchorFrames: 2,
  hardFrames: 0,
  lockMs: 40,
  msPerMove: 45,
  maxDepth: 8,
  extra: 1,
  extraMax: 6,
  tolerance: 4,
  misreadRate: 0,
  turnFrameCost: 0.3,
  frameCap: 4,
  maxSet: 128,
  slack: 5,
  altSlack: 2,
  deepHyps: 32,
  maxNodes: 1500000,
  maxSkip: 3,
  skipCost: Infinity,
  bridgeDepth: 10,
  budgetMs: 120000,
};

export interface ExactResult {
  moves: DecodedMove[];
  reachedEnd: boolean;
  method: "meet" | "bridge" | "none";
  anchors: number;
  forwardTo: number | null; // 前向きで決められた最後のアンカーの時刻
  backwardTo: number | null; // 後ろ向きで決められた最初のアンカーの時刻
  reason: string;
  ms: number;
}

// ---- カメラの座標での置換 ----

const NUM_ROT = 24;
// LAYERS[f]: facelet f のピースが乗っている層（面のビット）
const LAYERS: Uint8Array = Uint8Array.from({ length: 54 }, (_, p) => {
  const { pos } = faceletGeometry(p);
  let m = 0;
  for (let f = 0; f < 6; f++) if (pos[0] * NORMAL[f][0] + pos[1] * NORMAL[f][1] + pos[2] * NORMAL[f][2] === 1) m |= 1 << f;
  return m;
});
const isCenterPos = (p: number) => p % 9 === 4;
const ALL_FACES = 63;

const ALL_ORIENTS = Uint8Array.from({ length: NUM_ROT }, (_, o) => o);

function applyDest(C: Int8Array, d: ArrayLike<number>): Int8Array {
  const out = new Int8Array(54);
  for (let p = 0; p < 54; p++) out[d[p]] = C[p];
  return out;
}
// ステッカーの並び → 色の状態
function cubeState(C: Int8Array): CubeState {
  const s = new Uint8Array(54);
  for (let f = 0; f < 54; f++) s[f] = Math.floor(C[f] / 9);
  return s;
}
const keyOf = (C: Int8Array) => String.fromCharCode(...C);
const redundant = (last: number, m: number) => {
  if (last < 0) return false;
  const fa = moveFace(last);
  const fb = moveFace(m);
  return fa === fb || (OPPOSITE[fa] === fb && fa > fb);
};

// ---- フレームとアンカー ----

interface Frame {
  t: number;
  pos: Uint8Array; // カメラのマス（面 * 9 + セル）
  id: Int8Array;
  hard: Uint8Array; // 絶対の条件にする読み（hardFrames 枚続けて同じマスに同じステッカー。破る候補は落とす）
  wt: Float32Array; // 食い違ったときの重み: 同じマスに同じ読みが続いた枚数の逆数（続いた読みは 1 つの証拠。読み違いも続く）
  ors: Uint8Array; // 読めたセンターに合う姿勢（センターが読めなければ 24 通り）
}

// 読めたセンターに合う姿勢。センターの ID をセンターでないマスに読んでいたら null（その読みは使えない）
function orientsOf(pos: ArrayLike<number>, id: ArrayLike<number>): Uint8Array | null {
  let ors: number[] | null = null;
  for (let i = 0; i < pos.length; i++) {
    const c = id[i] % 9 === 4;
    if (c !== isCenterPos(pos[i])) return null;
    if (!c) continue;
    ors = (ors ?? Array.from(ALL_ORIENTS)).filter((o) => VIEW[o * 54 + pos[i]] === id[i]);
  }
  return ors ? Uint8Array.from(ors) : ALL_ORIENTS;
}

function toFrames(sightings: Sighting[], o: ExactOptions): Frame[] {
  const out: Frame[] = [];
  for (const s of sightings) {
    const pos: number[] = [];
    const id: number[] = [];
    for (const f of s.faces) {
      if (!f.ids) continue;
      let n = 0;
      for (let c = 0; c < 9; c++) if (f.ids[c] >= 0 && (f.w?.[c] ?? 1) >= o.minWeight) n++;
      if (n < o.minFace) continue;
      for (let c = 0; c < 9; c++)
        if (f.ids[c] >= 0 && (f.w?.[c] ?? 1) >= o.minWeight) {
          pos.push(f.slot * 9 + c);
          id.push(f.ids[c]);
        }
    }
    // 同じステッカーを 2 か所に読んだフレームは、その読みを使わない
    const seen = new Map<number, number>();
    for (const x of id) seen.set(x, (seen.get(x) ?? 0) + 1);
    const keep = id.map((x) => seen.get(x) === 1);
    const fp = pos.filter((_, i) => keep[i]);
    const fi = id.filter((_, i) => keep[i]);
    const ors = orientsOf(fp, fi);
    // センターの読みがどの姿勢とも合わないフレームは、読みなしとして残す（時刻の並びは保つ）
    if (!ors || !ors.length) out.push({ t: s.t, pos: new Uint8Array(0), id: new Int8Array(0), hard: new Uint8Array(0), wt: new Float32Array(0), ors: ALL_ORIENTS });
    else out.push({ t: s.t, pos: Uint8Array.from(fp), id: Int8Array.from(fi), hard: new Uint8Array(fp.length), wt: new Float32Array(fp.length).fill(1), ors });
  }
  out.sort((a, b) => a.t - b.t);
  // 同じマスに同じ読みが続いた（間が RUN_GAP_MS まで）まとまりごとに、重みを 1 / 枚数にする
  const open = new Map<number, { lastT: number; members: [number, number][] }>();
  const flush = (g: { members: [number, number][] }) => {
    for (const [f, i] of g.members) out[f].wt[i] = 1 / g.members.length;
  };
  for (let f = 0; f < out.length; f++) {
    const fr = out[f];
    for (let i = 0; i < fr.pos.length; i++) {
      const k = fr.pos[i] * 64 + fr.id[i];
      const g = open.get(k);
      if (g && fr.t - g.lastT <= RUN_GAP_MS) {
        g.members.push([f, i]);
        g.lastT = fr.t;
      } else {
        if (g) flush(g);
        open.set(k, { lastT: fr.t, members: [[f, i]] });
      }
    }
  }
  for (const g of open.values()) flush(g);
  // 絶対の条件: 前後 h 枚（並んだフレーム。読めなかったフレームも数える）のどれでも同じマスに同じステッカーが読めた
  if (o.hardFrames > 1) {
    const h = Math.floor(o.hardFrames / 2);
    const has = (f: number, p: number, x: number) => {
      const fr = out[f];
      for (let j = 0; j < fr.pos.length; j++) if (fr.pos[j] === p) return fr.id[j] === x;
      return false;
    };
    for (let f = h; f + h < out.length; f++)
      for (let i = 0; i < out[f].pos.length; i++) {
        let ok = true;
        for (let d = -h; d <= h && ok; d++) if (d && !has(f + d, out[f].pos[i], out[f].id[i])) ok = false;
        if (ok) out[f].hard[i] = 1;
      }
  }
  return out;
}
const RUN_GAP_MS = 150;
const HARD = 1e6;

interface Anchor {
  f0: number; // 続いたフレーム f0〜f1
  f1: number;
  pos: Uint8Array; // 両方のフレームで読めたステッカー（センター以外）のカメラのマス
  id: Int8Array;
  n: number;
  ors: Uint8Array; // 両方のフレームのセンターに合う姿勢
}

function commonOf(a: Frame, b: Frame): { pos: number[]; id: number[]; n: number; ors: Uint8Array } {
  const pos: number[] = [];
  const id: number[] = [];
  for (let i = 0; i < a.pos.length; i++)
    for (let j = 0; j < b.pos.length; j++)
      if (a.pos[i] === b.pos[j] && a.id[i] === b.id[j] && !isCenterPos(a.pos[i])) {
        pos.push(a.pos[i]);
        id.push(a.id[i]);
      }
  return { pos, id, n: pos.length, ors: a.ors.filter((o) => b.ors.includes(o)) };
}

// 読みが食い違わずに続いた区間ごとに、いちばん多く読めた 2 枚組と、それにないステッカーが 3 枚以上ある 2 枚組をアンカーにする
function anchorsOf(frames: Frame[], o: ExactOptions): Anchor[] {
  const out: Anchor[] = [];
  let run: Anchor[] = [];
  let at = new Map<number, number>(); // マス → ID
  let where = new Map<number, number>(); // ID → マス
  let lastT = -Infinity;
  const close = () => {
    if (!run.length) return;
    const picked: Anchor[] = [];
    const have = new Set<number>();
    const order = [...run].sort((a, b) => b.n - a.n || a.f0 - b.f0);
    for (const a of order) {
      let fresh = 0;
      for (let i = 0; i < a.id.length; i++) if (!have.has(a.id[i])) fresh++;
      if (picked.length && fresh < 3) continue;
      picked.push(a);
      for (const x of a.id) have.add(x);
    }
    out.push(...picked.sort((a, b) => a.f0 - b.f0));
    run = [];
    at = new Map();
    where = new Map();
  };
  const m = o.anchorFrames;
  for (let i = 0; i + m - 1 < frames.length; i++) {
    if (frames[i + m - 1].t - frames[i].t > o.pairMs * (m - 1)) continue;
    let c = commonOf(frames[i], frames[i + 1]);
    for (let k = 2; k < m && c.n >= o.minIds; k++) {
      const fk = frames[i + k];
      const keep = c.pos.map((p, j) => fk.pos.some((q, l) => q === p && fk.id[l] === c.id[j]));
      c = { pos: c.pos.filter((_, j) => keep[j]), id: c.id.filter((_, j) => keep[j]), n: keep.filter(Boolean).length, ors: c.ors.filter((x) => fk.ors.includes(x)) };
    }
    if (c.n < o.minIds || !c.ors.length) continue;
    let ok = frames[i].t - lastT <= 300;
    for (let k = 0; k < c.pos.length && ok; k++) {
      const had = at.get(c.pos[k]);
      const was = where.get(c.id[k]);
      if ((had !== undefined && had !== c.id[k]) || (was !== undefined && was !== c.pos[k])) ok = false;
    }
    if (!ok) close();
    for (let k = 0; k < c.pos.length; k++) {
      at.set(c.pos[k], c.id[k]);
      where.set(c.id[k], c.pos[k]);
    }
    lastT = frames[i + m - 1].t;
    run.push({ f0: i, f1: i + m - 1, pos: Uint8Array.from(c.pos), id: Int8Array.from(c.id), n: c.n, ors: c.ors });
  }
  close();
  return out;
}

// フレーム from〜to の間ずっと（lockMs より長く途切れずに）カメラの同じマスに読め続けたステッカー。そのピースの乗っている面は
// 回っていない（where: 仮説でのステッカーの場所）
function lockedFaces(frames: Frame[], from: number, to: number, lockMs: number, where: Uint8Array): number {
  if (to <= from) return 0;
  let locked = 0;
  const a = frames[from];
  for (let i = 0; i < a.pos.length; i++) {
    const p = a.pos[i];
    const x = a.id[i];
    if (isCenterPos(p) || (LAYERS[where[x]] & ~locked) === 0) continue;
    // 速い回転は読めないフレーム 2〜3 枚の間に終わるので、途切れたら回っていないとは言えない（lockMs: フレームの間がそれより
    // 開いていたら、その間は分からない）
    let ok = true;
    for (let f = from + 1; f <= to && ok; f++) {
      const fr = frames[f];
      if (fr.t - frames[f - 1].t > lockMs) ok = false;
      let seen = false;
      for (let j = 0; j < fr.pos.length && !seen; j++) if (fr.pos[j] === p && fr.id[j] === x) seen = true;
      if (!seen) ok = false;
    }
    if (ok) locked |= LAYERS[where[x]];
  }
  return locked;
}

// ---- 手順の探索（ステッカーの位置の組を、両側から探して突き合わせる） ----

interface Layer {
  index?: Map<number, number | number[]>;
  keys: Float64Array;
  codes: Float64Array; // 手順（19 進で 1 手ずつ、手 + 1）
  n: number;
}

const seqOf = (code: number): number[] => {
  const out: number[] = [];
  for (; code > 0; code = Math.floor(code / 19)) out.push((code % 19) - 1);
  return out.reverse();
};

function hashTuple(t: Uint8Array, k: number): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x1234567;
  for (let i = 0; i < k; i++) {
    h1 = Math.imul(h1 ^ t[i], 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 131) + t[i] + 7) >>> 0;
  }
  return h1 * 2097152 + (h2 & 0x1fffff);
}

// 組 start から、faces の面の手だけで depth 手までに届く組（深さごと）。inverse: 終わりの組から逆にたどる（手順は前に足す）
class Reach {
  layers: Layer[] = [];
  overflow = false;
  private k: number;
  constructor(
    private start: Uint8Array,
    private faces: number,
    private inverse: boolean,
    private maxNodes: number,
  ) {
    this.k = start.length;
  }
  at(depth: number): Layer | null {
    if (this.layers.length <= depth && !this.overflow) this.build(depth);
    return this.layers[depth] ?? null;
  }
  private build(depth: number): void {
    const k = this.k;
    const moves: number[] = [];
    for (let m = 0; m < NUM_MOVES; m++) if (this.faces & (1 << moveFace(m))) moves.push(m);
    const bufs: { keys: number[]; codes: number[] }[] = Array.from({ length: depth + 1 }, () => ({ keys: [], codes: [] }));
    const stack: Uint8Array[] = Array.from({ length: depth + 1 }, () => new Uint8Array(k));
    stack[0].set(this.start);
    let nodes = 0;
    const pow: number[] = [1];
    for (let i = 1; i <= depth; i++) pow.push(pow[i - 1] * 19);
    const visit = (d: number, edge: number, code: number): boolean => {
      bufs[d].keys.push(hashTuple(stack[d], k));
      bufs[d].codes.push(code);
      if (d >= depth) return true;
      if (++nodes > this.maxNodes) return false;
      const cur = stack[d];
      const next = stack[d + 1];
      for (const m of moves) {
        // 前向き: 最後の手 edge の後に m。後ろ向き: 最初の手 edge の前に m
        if (edge >= 0 && (this.inverse ? redundant(m, edge) : redundant(edge, m))) continue;
        const dest = MOVE_DEST[this.inverse ? inverseMove(m) : m];
        for (let i = 0; i < k; i++) next[i] = dest[cur[i]];
        if (!visit(d + 1, m, this.inverse ? (m + 1) * pow[d] + code : code * 19 + m + 1)) return false;
      }
      return true;
    };
    if (!visit(0, -1, 0)) {
      this.overflow = true;
      return;
    }
    this.layers = bufs.map((b) => ({ keys: Float64Array.from(b.keys), codes: Float64Array.from(b.codes), n: b.keys.length }));
  }
}

// 長さちょうど L の手順（前向き f 手 + 後ろ向き L - f 手）。null = 探し切れない
function sequencesOfLength(F: Reach, B: Reach, L: number, limit: number): number[][] | null {
  const f = Math.ceil(L / 2);
  const fl = F.at(f);
  const bl = B.at(L - f);
  if (!fl || !bl) return null;
  let index = bl.index;
  if (!index) {
    index = bl.index = new Map<number, number | number[]>();
    for (let i = 0; i < bl.n; i++) {
      const had = index.get(bl.keys[i]);
      if (had === undefined) index.set(bl.keys[i], i);
      else if (typeof had === "number") index.set(bl.keys[i], [had, i]);
      else had.push(i);
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < fl.n; i++) {
    const hit = index.get(fl.keys[i]);
    if (hit === undefined) continue;
    const head = seqOf(fl.codes[i]);
    for (const j of typeof hit === "number" ? [hit] : hit) {
      const tail = seqOf(bl.codes[j]);
      if (head.length && tail.length && redundant(head[head.length - 1], tail[0])) continue;
      out.push([...head, ...tail]);
      if (out.length > limit) return null;
    }
  }
  return out;
}

// ---- 仮説 ----

// 手。進む向き（前向きなら時間の向き、後ろ向きなら逆）に並べた連結リスト
interface Ev {
  prev: Ev | null;
  n: number; // ここまでの手の数
  cube: number; // キューブ固定の手
  orient: number; // 手の後のアンカーの姿勢
  t0: number;
  t: number;
  inferred: boolean;
  a0: number; // このつなぎの前のアンカー（-1 = 始まり）と後のアンカー（片道の中の番号）
  a1: number;
}

interface Hyp {
  C: Int8Array;
  key: string;
  ev: Ev | null;
  viol: number; // ここまでの読みの食い違い
  done: number; // 確かめ終えた最後のフレーム
  at: number; // 最後につながったアンカー（-1 = 始まり）
  prev: Hyp | null; // 前のアンカーでの仮説
  pen: number; // アンカーを通り過ぎたコスト
  skips: number; // 続けて通り過ぎたアンカーの数
}

const movesOf = (ev: Ev | null): Ev[] => {
  const out: Ev[] = [];
  for (let e = ev; e; e = e.prev) out.push(e);
  return out.reverse();
};

// 同じ面をまとめ、隣り合う反対の面の手を面の番号の順に並べる（rescore.ts の canonical と同じ）
export function canonicalMoves(ms: number[]): number[] {
  const merge = (xs: number[]) => {
    const out: number[] = [];
    for (const m of xs) {
      const last = out[out.length - 1];
      if (last !== undefined && moveFace(last) === moveFace(m)) {
        out.pop();
        const amt = ((last % 3) + 1 + (m % 3) + 1) % 4;
        if (amt) out.push(moveFace(m) * 3 + amt - 1);
      } else out.push(m);
    }
    return out;
  };
  let cur = merge(ms);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = moveFace(cur[i]);
      const b = moveFace(cur[i + 1]);
      if (a !== b && a % 3 === b % 3 && a > b) {
        [cur[i], cur[i + 1]] = [cur[i + 1], cur[i]];
        changed = true;
      }
    }
    if (changed) cur = merge(cur);
  }
  return cur;
}

// 同じ状態に着いた 2 つの道: 手順が違えば（並べ替えただけの違いを除く）、違う所の手を推定にする
function markDifference(keep: Ev | null, other: Ev | null): void {
  if (keep === other) return;
  const a = movesOf(keep);
  const b = movesOf(other);
  // 共通の先祖までは同じ
  let head = 0;
  while (head < a.length && head < b.length && (a[head] === b[head] || a[head].cube === b[head].cube)) head++;
  const ca = canonicalMoves(a.slice(head).map((e) => e.cube));
  const cb = canonicalMoves(b.slice(head).map((e) => e.cube));
  if (ca.length === cb.length && ca.every((m, i) => m === cb[i])) {
    // 手順は同じ。相手の道で推定だった所は引き継がない（同じ手順をどちらの道でも説明できた）
    return;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].cube === b[b.length - 1 - tail].cube) tail++;
  for (let i = head; i < a.length - tail; i++) a[i].inferred = true;
  // 手の数だけが違う（片方が 0 手）ときは、境目の手を推定にする
  if (a.length - tail <= head) {
    if (head < a.length) a[head].inferred = true;
    else if (a.length) a[a.length - 1].inferred = true;
  }
}

// ---- 間のフレームでの確かめ ----
//
// 区間: S0, T1, S1, …, Tn, Sn（S = 止まっている、T = 出来事の途中）。フレームを時刻の順に区間へ割り当てる。
// S のフレームはその状態どおりに読めること。T のフレームは、その出来事で動かないマスだけ照らす。最後のフレームは Sn。
interface Scored {
  cost: number;
  starts: number[];
  ends: number[];
}

// つなぎ（フレーム from〜to）で許す食い違い
function toleranceOf(frames: Frame[], from: number, to: number, o: ExactOptions): number {
  let w = 0;
  for (let f = Math.max(0, from); f <= to; f++) for (const x of frames[f].wt) w += x;
  return o.tolerance + o.misreadRate * w;
}

function scoreFrames(frames: Frame[], from: number, to: number, states: Int8Array[], o: ExactOptions, limit: number): Scored | null {
  const n = states.length - 1;
  const P = 2 * n + 1;
  const F = to - from + 1;
  if (F <= 0) return { cost: 0, starts: new Array(n).fill(Number.NaN), ends: new Array(n).fill(Number.NaN) };
  // 食い違い: ふつうの読みは重みの和（1 フレーム frameCap まで）、絶対の条件の読みは 1 つにつき HARD
  const cost = (fr: Frame, p: number): number => {
    const n = fr.pos.length;
    if (!n) return p % 2 === 0 ? 0 : o.turnFrameCost;
    let best = Infinity;
    const still = p % 2 === 0;
    const A = states[still ? p / 2 : (p - 1) / 2];
    const B = still ? A : states[(p + 1) / 2];
    for (const or of fr.ors) {
      const v = or * 54;
      let soft = 0;
      let hard = 0;
      // 止まっている: 状態どおり。回している途中: 動かないマスはそのまま、動くマスは回す前か後のどちらかに読めること
      for (let i = 0; i < n; i++) {
        const q = VIEW[v + fr.pos[i]];
        if (A[q] === fr.id[i] || B[q] === fr.id[i]) continue;
        if (fr.hard[i]) hard++;
        else soft += fr.wt[i];
      }
      const c = Math.min(o.frameCap, soft) + hard * HARD;
      if (c < best) best = c;
      if (!best) break;
    }
    return still ? best : best + o.turnFrameCost;
  };
  const dp = new Float64Array(F * P).fill(Infinity);
  const back = new Int16Array(F * P);
  for (let p = 0; p < P; p++) dp[p] = cost(frames[from], p);
  for (let i = 1; i < F; i++) {
    let run = Infinity;
    let arg = 0;
    let any = false;
    const fr = frames[from + i];
    for (let p = 0; p < P; p++) {
      const prev = dp[(i - 1) * P + p];
      if (prev < run) {
        run = prev;
        arg = p;
      }
      if (run > limit) continue;
      const c = run + cost(fr, p);
      dp[i * P + p] = c;
      back[i * P + p] = arg;
      if (c <= limit) any = true;
    }
    if (!any) return null;
  }
  const total = dp[(F - 1) * P + P - 1];
  if (!(total <= limit)) return null;
  const phase = new Int16Array(F);
  phase[F - 1] = P - 1;
  for (let i = F - 1; i > 0; i--) phase[i - 1] = back[i * P + phase[i]];
  const before = from > 0 ? frames[from - 1].t : frames[from].t;
  // 区間 p に入った最初のフレームの時刻（その前のフレームとの中間）
  const enter = (p: number) => {
    let i = 0;
    while (i < F && phase[i] < p) i++;
    if (i === 0) return (before + frames[from].t) / 2;
    if (i === F) return frames[to].t;
    return (frames[from + i - 1].t + frames[from + i].t) / 2;
  };
  const starts: number[] = [];
  const ends: number[] = [];
  for (let k = 1; k <= n; k++) {
    starts.push(enter(2 * k - 1));
    ends.push(enter(2 * k));
  }
  return { cost: total, starts, ends };
}

// ---- 片道 ----

interface Pass {
  sets: (Hyp[] | null)[]; // アンカーごとに残った仮説（飛ばしたアンカーは null）
  resolved: number; // 決められた最後のアンカー（-1 = なし）
  reason: string;
}

interface Ctx {
  truth?: { C: Int8Array[]; keys: string[]; moves: number[] };
  frames: Frame[];
  anchors: Anchor[];
  o: ExactOptions;
  deadline: number;
  backward: boolean;
}

// 仮説 h から、アンカー a（の 2 枚目のフレーム）までを説明する仮説をすべて out に足す。戻り値: 探し切れなかった理由（"" = 探し切れた）
function advance(ctx: Ctx, h: Hyp, ai: number, out: Map<string, Hyp>, cache: Map<string, Reach>, minL: number, maxL: number): string {
  const a = ctx.anchors[ai];
  const { frames, o } = ctx;
  const from = h.done + 1;
  const to = a.f1;
  const tol = toleranceOf(frames, from, to, o);
  const emit = (seq: number[], states: Int8Array[], sc: Scored, orient: number) => {
    let ev = h.ev;
    for (let k = 0; k < seq.length; k++) ev = { prev: ev, n: (ev?.n ?? 0) + 1, cube: seq[k], orient, t0: sc.starts[k], t: sc.ends[k], inferred: false, a0: h.at, a1: ai };
    const C = states[states.length - 1];
    const key = keyOf(C);
    const next: Hyp = { C, key, ev, viol: h.viol + sc.cost, done: to, at: ai, prev: h, pen: h.pen, skips: 0 };
    const had = out.get(key);
    if (!had) {
      out.set(key, next);
      return;
    }
    const better = rank(next) < rank(had);
    const [keep, other] = better ? [next, had] : [had, next];
    if (rank(other) <= rank(keep) + o.altSlack) markDifference(keep.ev, other.ev);
    out.set(key, keep);
  };
  const matches = (C: Int8Array, or: number) => {
    const v = or * 54;
    for (let i = 0; i < a.pos.length; i++) if (C[VIEW[v + a.pos[i]]] !== a.id[i]) return false;
    return true;
  };
  // 手なし
  for (const or of minL > 0 ? [] : a.ors) {
    if (!matches(h.C, or)) continue;
    const sc = scoreFrames(frames, from, to, [h.C], o, tol);
    if (sc) {
      // 手なしで説明できる: 証拠のない手は足さない（見えない面の手は、動いたステッカーが見えたアンカーで足す）
      emit([], [h.C], sc, or);
      return "";
    }
    break;
  }
  // 手あり: 回っていないと分かる面を除いて探す
  const where = new Uint8Array(54);
  for (let f = 0; f < 54; f++) where[h.C[f]] = f;
  const locked = lockedFaces(frames, Math.max(0, h.done), a.f0, o.lockMs, where);
  const faces = ALL_FACES & ~locked;
  if (!faces) return "";
  // 手の数の上限は、最後の手からの時間で決める（見えなかった手は、後のアンカーで足すことがある）
  const dt = frames[a.f0].t - Math.max(h.ev ? h.ev.t : -Infinity, frames[Math.max(0, h.done)].t - 2000);
  const maxLen = Math.min(o.maxDepth, Math.floor(dt / o.msPerMove) + 1, maxL);
  const F = new Reach(Uint8Array.from(a.id, (x) => where[x]), faces, false, o.maxNodes);
  let firstL = -1;
  let blocked = "";
  for (let L = Math.max(1, minL); L <= maxLen && !blocked; L++) {
    if (firstL >= 0 && L > firstL + o.extra) break;
    if (firstL >= 0 && L > firstL && L > o.extraMax) break;
    for (const or of a.ors) {
      if (performance.now() > ctx.deadline) return "時間切れ";
      o.tick?.();
      const bk = `${or}:${faces}`;
      let B = cache.get(bk);
      if (!B) {
        B = new Reach(Uint8Array.from(a.pos, (p) => VIEW[or * 54 + p]), faces, true, o.maxNodes);
        cache.set(bk, B);
      }
      const seqs = sequencesOfLength(F, B, L, 20000);
      if (!seqs) {
        blocked = "候補が多すぎる";
        break;
      }
      for (const seq of seqs) {
        const states: Int8Array[] = [h.C];
        for (const m of seq) states.push(applyDest(states[states.length - 1], MOVE_DEST[m]));
        // 突き合わせはハッシュなので、アンカーの読みと本当に合うか確かめる
        if (!matches(states[L], or)) continue;
        const sc = scoreFrames(frames, from, to, states, o, tol);
        if (!sc) continue;
        if (firstL < 0) firstL = L;
        emit(seq, states, sc, or);
      }
    }
  }
  // 探した長さでは見つからなかった（もっと長い手順は探していない）
  if (firstL < 0 && !blocked && maxL < Math.min(o.maxDepth, Math.floor(dt / o.msPerMove) + 1)) return "浅い";
  return blocked;
}

// 候補を並べる・上限で切るときの順: 手の数 + 読みの食い違い
const rank = (h: Hyp) => (h.ev?.n ?? 0) + h.viol + h.pen;

function runPass(ctx: Ctx, starts: Hyp[]): Pass {
  const { anchors, o } = ctx;
  let hyps = starts;
  const sets: (Hyp[] | null)[] = [];
  let skipped = 0;
  for (let i = 0; i < anchors.length; i++) {
    if (performance.now() > ctx.deadline) return { sets, resolved: lastSet(sets), reason: "時間切れ" };
    const tA = performance.now();
    const out = new Map<string, Hyp>();
    const cache = new Map<string, Reach>();
    let blocked = "";
    // まず浅く（SHALLOW 手まで）。つながらなかった仮説は、つながった仮説より手の数 + 食い違いが slack を超えない範囲で深く探す
    // （どれもつながらなければ、上位の仮説だけ一番深くまで）
    const shallow: Hyp[] = [];
    for (const h of hyps) {
      const b = advance(ctx, h, i, out, cache, 0, SHALLOW);
      if (b === "浅い") shallow.push(h);
      else if (b) blocked = b;
    }
    if (shallow.length) {
      let bestRank = Infinity;
      for (const h of out.values()) bestRank = Math.min(bestRank, rank(h));
      const deep = Number.isFinite(bestRank) ? shallow : shallow.slice(0, o.deepHyps);
      for (const h of deep) {
        const room = Number.isFinite(bestRank) ? Math.floor(bestRank + o.slack - rank(h)) : o.maxDepth;
        if (room <= SHALLOW) continue;
        const b = advance(ctx, h, i, out, cache, SHALLOW + 1, room);
        if (b && b !== "浅い") blocked = b;
      }
    }
    // アンカーを通り過ぎる: アンカーの読みにも読み違いはある（悪い画質では 2 枚続けて同じに読み違える）。合わなかったことにして
    // 進まずに残す（この間のフレームは次のつなぎで確かめ、アンカーの読みとの食い違いはそこで払う）。続けて maxSkip 個まで
    if (out.size && o.skipCost < Infinity) {
      let bestRank = Infinity;
      for (const x of out.values()) bestRank = Math.min(bestRank, rank(x));
      for (const h of hyps) {
        if (h.skips >= o.maxSkip || rank(h) + o.skipCost > bestRank + o.slack) continue;
        if (out.has(h.key)) continue;
        out.set(h.key, { ...h, pen: h.pen + o.skipCost, skips: h.skips + 1 });
      }
    }
    if (!out.size && ctx.truth) explainLoss(ctx, i, hyps, [], out);
    if (!out.size) {
      // どの仮説もつながらない: 読み違いのアンカーとみて飛ばす（その読みは次のつなぎで確かめるフレームとして使う）
      o.debug?.(`${ctx.backward ? "←" : "→"} アンカー ${i} t=${(Math.abs(ctx.frames[anchors[i].f0].t) / 1000).toFixed(2)} ステッカー ${anchors[i].n} を飛ばす（どの仮説もつながらない${blocked ? `・${blocked}` : ""}）`);
      sets.push(null);
      if (++skipped > o.maxSkip) return { sets, resolved: lastSet(sets), reason: blocked || "つなげない" };
      continue;
    }
    skipped = 0;
    let next = [...out.values()].sort((x, y) => rank(x) - rank(y));
    if (ctx.truth) explainLoss(ctx, i, hyps, next, out);
    if (next.length > o.maxSet) next = next.slice(0, o.maxSet);
    hyps = next;
    sets.push(next);
    o.onAnchor?.({ backward: ctx.backward, index: i, t: ctx.frames[anchors[i].f0].t, stickers: anchors[i].n, hyps: next.map((h) => ({ state: cubeState(h.C), moves: movesOf(h.ev).map((e) => (ctx.backward ? inverseMove(e.cube) : e.cube)), viol: h.viol })) });
    o.debug?.(`${ctx.backward ? "←" : "→"} アンカー ${i} t=${(ctx.frames[anchors[i].f0].t / 1000).toFixed(2)} ステッカー ${anchors[i].n} 仮説 ${next.length} 手 ${next[0].ev?.n ?? 0} 食い違い ${next[0].viol.toFixed(1)} ${(performance.now() - tA).toFixed(0)}ms${blocked ? ` ${blocked}` : ""}`);
  }
  return { sets, resolved: lastSet(sets), reason: "" };
}

const SHALLOW = 3;

// 調べ用: 前の候補にあった正解の状態が、このアンカーの候補（上限で切る前の next）からなくなったとき、正解の手順がなぜ残らなかったか
function explainLoss(ctx: Ctx, ai: number, hyps: Hyp[], next: Hyp[], out: Map<string, Hyp>): void {
  const T = ctx.truth!;
  const { frames, o } = ctx;
  const a = ctx.anchors[ai];
  const kOf = (h: Hyp) => T.keys.indexOf(h.key);
  const before = hyps.map((h) => ({ h, k: kOf(h) })).filter((x) => x.k >= 0);
  if (!before.length) return;
  const nextK = next.map(kOf);
  const pos = nextK.findIndex((k) => k >= 0);
  if (pos >= 0 && pos < o.maxSet) return;
  const tag = `${ctx.backward ? "←" : "→"} ${ai} t=${(Math.abs(frames[a.f0].t) / 1000).toFixed(2)}`;
  if (pos >= 0) {
    o.debug?.(`${tag} 正解は候補 ${next.length} の ${pos} 番目（上限 ${o.maxSet} で切った） rank ${rank(next[pos]).toFixed(1)} / 一番 ${rank(next[0]).toFixed(1)}`);
    return;
  }
  const { h, k: k0 } = before[0];
  const parts: string[] = [];
  const kids = [...out.values()].filter((x) => x.prev === h).map((x) => (x.ev?.n ?? 0) - (h.ev?.n ?? 0));
  parts.push(`前の正解 ${k0} 手目（候補 ${hyps.indexOf(h)} 番目）・その子 ${kids.length}（手 ${kids.length ? Math.min(...kids) : "-"}〜）`);
  const matches = (C: Int8Array) => a.ors.some((or) => a.pos.every((p, i) => C[VIEW[or * 54 + p]] === a.id[i]));
  for (let k1 = k0; k1 <= Math.min(T.C.length - 1, k0 + 14); k1++) {
    if (!matches(T.C[k1])) continue;
    const seq = T.moves.slice(k0, k1);
    const states = [h.C];
    for (const m of seq) states.push(applyDest(states[states.length - 1], MOVE_DEST[m]));
    const where = new Uint8Array(54);
    for (let f = 0; f < 54; f++) where[h.C[f]] = f;
    const locked = lockedFaces(frames, Math.max(0, h.done), a.f0, o.lockMs, where);
    const usedFaces = seq.reduce((m, x) => m | (1 << moveFace(x)), 0);
    const dt = frames[a.f0].t - Math.max(h.ev ? h.ev.t : -Infinity, frames[Math.max(0, h.done)].t - 2000);
    const maxLen = Math.min(o.maxDepth, Math.floor(dt / o.msPerMove) + 1);
    const sc = scoreFrames(frames, h.done + 1, a.f1, states, o, 1e9);
    parts.push(`${k1} 手目まで ${seq.length} 手（上限 ${maxLen}・間 ${dt.toFixed(0)}ms）${locked & usedFaces ? "・回っていないとした面を使う" : ""}・食い違い ${sc ? sc.cost.toFixed(1) : "-"}`);
  }
  o.debug?.(`${tag} 正解が落ちた: ${parts.join(" / ")}`);
}

const lastSet = (sets: (Hyp[] | null)[]) => {
  for (let i = sets.length - 1; i >= 0; i--) if (sets[i]) return i;
  return -1;
};

function startHyp(state: CubeState): Hyp {
  const C = Int8Array.from(stickerIds(state));
  return { C, key: keyOf(C), ev: null, viol: 0, done: -1, at: -1, prev: null, pen: 0, skips: 0 };
}

// ---- 本体 ----

export function decodeExact(sightings: Sighting[], start: CubeState, end: CubeState, options: Partial<ExactOptions> = {}): ExactResult {
  const o = { ...DEFAULT_EXACT, ...options };
  const t00 = performance.now();
  const deadline = t00 + o.budgetMs;
  const frames = toFrames(sightings, o);
  const anchors = anchorsOf(frames, o);
  const N = frames.length;
  const fail = (reason: string, extra: Partial<ExactResult> = {}): ExactResult => ({ moves: [], reachedEnd: false, method: "none", anchors: anchors.length, forwardTo: null, backwardTo: null, reason, ms: performance.now() - t00, ...extra });
  if (!anchors.length) return fail("アンカーがない");
  let truthF: Ctx["truth"];
  let truthB: Ctx["truth"];
  if (o.truth) {
    const mk = (s0: CubeState, ms: number[]) => {
      const C: Int8Array[] = [Int8Array.from(stickerIds(s0))];
      for (const m of ms) C.push(applyDest(C[C.length - 1], MOVE_DEST[m]));
      return { C, keys: C.map(keyOf), moves: ms };
    };
    truthF = mk(start, o.truth);
    const tf = truthF;
    truthB = { C: [...tf.C].reverse(), keys: [...tf.keys].reverse(), moves: [...o.truth].reverse().map(inverseMove) };
  }
  const fwd = runPass({ frames, anchors, o, deadline, backward: false, truth: truthF }, [startHyp(start)]);
  // 後ろ向き: フレームとアンカーを時間の逆に並べる（フレーム i ↔ N - 1 - i）
  const rframes = frames.map((f) => ({ ...f, t: -f.t })).reverse();
  const ranchors = anchors.map((a) => ({ ...a, f0: N - 1 - a.f1, f1: N - 1 - a.f0 })).reverse();
  const bwd = runPass({ frames: rframes, anchors: ranchors, o, deadline, backward: true, truth: truthB }, [startHyp(end)]);
  const A = anchors.length;
  const bset = (i: number) => bwd.sets[A - 1 - i] ?? null; // 前向きの番号で
  const tOf = (i: number) => frames[anchors[i].f0].t;
  const info = { forwardTo: fwd.resolved >= 0 ? tOf(fwd.resolved) : null, backwardTo: bwd.resolved >= 0 ? tOf(A - 1 - bwd.resolved) : null };
  // 前向きの手 + 後ろ向きの手（逆の手を逆の順に）
  const assemble = (f: Hyp, b: Hyp, mid: DecodedMove[] = []): DecodedMove[] => {
    const head: DecodedMove[] = movesOf(f.ev).map((e) => ({ move: e.cube, t0: e.t0, t: e.t, orient: e.orient, ...(e.inferred ? { inferred: true } : {}) }));
    const tail: DecodedMove[] = movesOf(b.ev)
      .reverse()
      .map((e) => ({ move: inverseMove(e.cube), t0: -e.t, t: -e.t0, orient: e.orient, ...(e.inferred ? { inferred: true } : {}) }));
    return [...head, ...mid, ...tail];
  };
  // 同じアンカーで同じ状態になった仮説どうし = 始まりから終わりまで読みと食い違わない道。手の数 + 食い違いが一番小さい道を出す
  type Join = { f: Hyp; b: Hyp; i: number; cost: number };
  const joins: Join[] = [];
  for (let i = 0; i < A; i++) {
    const fs = i < fwd.sets.length ? fwd.sets[i] : null;
    const bs = bset(i);
    if (!fs || !bs) continue;
    const map = new Map(fs.map((h) => [h.key, h]));
    let n = 0;
    for (const b of bs) {
      const f = map.get(b.key);
      if (f && n++ < 64) joins.push({ f, b, i, cost: rank(f) + rank(b) });
    }
  }
  if (joins.length) {
    let best = joins[0];
    for (const j of joins) if (j.cost < best.cost) best = j;
    const moves = assemble(best.f, best.b);
    // ほかの道と手順が違う所（並べ替えただけの違いを除く）は、1 通りに決まっていないので推定
    const mine = moves.map((m) => m.move);
    const canon = canonicalMoves(mine).join(",");
    const seen = new Set<string>();
    for (const j of joins) {
      if (j === best || j.cost > best.cost + o.altSlack) continue;
      const other = [...movesOf(j.f.ev).map((e) => e.cube), ...movesOf(j.b.ev).reverse().map((e) => inverseMove(e.cube))];
      const key = canonicalMoves(other).join(",");
      if (key === canon || seen.has(key)) continue;
      seen.add(key);
      let head = 0;
      while (head < mine.length && head < other.length && mine[head] === other[head]) head++;
      let tail = 0;
      while (tail < mine.length - head && tail < other.length - head && mine[mine.length - 1 - tail] === other[other.length - 1 - tail]) tail++;
      for (let k = head; k < mine.length - tail; k++) moves[k].inferred = true;
      if (mine.length - tail <= head && mine.length) moves[Math.min(head, mine.length - 1)].inferred = true;
      o.debug?.(`別の道（アンカー ${j.i} t=${(tOf(j.i) / 1000).toFixed(2)}）: ${head} 手目〜後ろから ${tail} 手目が違う（${other.length} 手）`);
    }
    return { moves, reachedEnd: true, method: "meet", anchors: A, ...info, reason: "", ms: performance.now() - t00 };
  }
  // 出会わない: 前向きの最後の仮説と後ろ向きの最後の仮説を、一番短い手順でつなぐ（推定）
  const fi = fwd.resolved;
  const bi = bwd.resolved >= 0 ? A - 1 - bwd.resolved : A;
  const fs = fi >= 0 ? fwd.sets[fi]! : [startHyp(start)];
  const bs = bi < A ? bset(bi)! : [startHyp(end)];
  const reason = `前向き ${fwd.reason || "最後まで"}・後ろ向き ${bwd.reason || "最後まで"}`;
  const tA = fi >= 0 ? frames[anchors[fi].f1].t : (frames[0]?.t ?? 0);
  const tB = bi < A ? frames[anchors[bi].f0].t : (frames[N - 1]?.t ?? tA);
  let found: { moves: DecodedMove[]; len: number; viol: number } | null = null;
  const ALL = Array.from({ length: 54 }, (_, x) => x).filter((x) => x % 9 !== 4);
  for (const f of fs.slice(0, 8)) {
    const where = new Uint8Array(54);
    for (let p = 0; p < 54; p++) where[f.C[p]] = p;
    const F = new Reach(Uint8Array.from(ALL, (x) => where[x]), ALL_FACES, false, o.maxNodes);
    for (const b of bs.slice(0, 8)) {
      if (performance.now() > deadline) break;
      o.tick?.();
      const whereB = new Uint8Array(54);
      for (let p = 0; p < 54; p++) whereB[b.C[p]] = p;
      const B = new Reach(Uint8Array.from(ALL, (x) => whereB[x]), ALL_FACES, true, o.maxNodes);
      for (let L = 0; L <= o.bridgeDepth; L++) {
        if (found && L > found.len) break;
        const seqs = sequencesOfLength(F, B, L, 1000);
        if (!seqs) break;
        const seq = seqs[0];
        if (!seq) continue;
        const orient = f.ev?.orient ?? 0;
        const mid: DecodedMove[] = seq.map((m, k) => ({ move: m, t0: tA + ((tB - tA) * k) / L, t: tA + ((tB - tA) * (k + 1)) / L, orient, inferred: true }));
        const viol = f.viol + b.viol;
        if (!found || L < found.len || viol < found.viol) found = { moves: assemble(f, b, mid), len: L, viol };
        break;
      }
    }
  }
  if (found) return { moves: found.moves, reachedEnd: true, method: "bridge", anchors: A, ...info, reason, ms: performance.now() - t00 };
  return fail(reason, info);
}

// 試験・調べ用
export const _internal = { commonOf, toFrames, anchorsOf, lockedFaces, Reach, sequencesOfLength };

// ---- 確認役 ----
//
// 今の解き直し（decodeOffline）の手順を、確かな所から埋めた手順（decodeExact）と照らす。手順は置き換えない。
// - 同じ手順（反対の面の順番だけの違いは同じ）: そのまま。ただし decodeExact で 1 通りに決まらなかった手は推定にする
// - 違う手順: 食い違う手を推定にする（どちらの手順も読みと食い違わない = 1 通りに決まっていない）
// - decodeExact が完成までつながらなかった: 何も言えないので、そのまま
// 間違った手順を「確定」にしないための確認で、確定を増やすことはしない（推定の印は外さない）。

interface Canon {
  m: number;
  idx: number[]; // まとめた元の手の番号
}

// 同じ面をまとめ、隣り合う反対の面の手を面の番号の順に並べる（canonicalMoves と同じ）。元の手の番号も持ち回る
function canonicalWithIndex(ms: number[]): Canon[] {
  const merge = (xs: Canon[]) => {
    const out: Canon[] = [];
    for (const x of xs) {
      const last = out[out.length - 1];
      if (last !== undefined && moveFace(last.m) === moveFace(x.m)) {
        out.pop();
        const amt = ((last.m % 3) + 1 + (x.m % 3) + 1) % 4;
        if (amt) out.push({ m: moveFace(x.m) * 3 + amt - 1, idx: [...last.idx, ...x.idx] });
      } else out.push(x);
    }
    return out;
  };
  let cur = merge(ms.map((m, i) => ({ m, idx: [i] })));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = moveFace(cur[i].m);
      const b = moveFace(cur[i + 1].m);
      if (a !== b && a % 3 === b % 3 && a > b) {
        [cur[i], cur[i + 1]] = [cur[i + 1], cur[i]];
        changed = true;
      }
    }
    if (changed) cur = merge(cur);
  }
  return cur;
}

// 2 つの並びの一番長い共通の部分列（a の番号 → b の番号。共通でなければ -1）
function alignment(a: number[], b: number[]): Int32Array {
  const n = a.length;
  const m = b.length;
  const L = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = a[i] === b[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
  const map = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map[i++] = j++;
    } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return map;
}

export interface VerifyResult<T extends DecodedMove> {
  moves: T[];
  agreed: boolean | null; // 同じ手順だった（null: 確かめられなかった）
  marked: number; // 新しく推定にした手の数
}

export function verifyMoves<T extends DecodedMove>(moves: T[], exact: ExactResult): VerifyResult<T> {
  if (!exact.reachedEnd || exact.method !== "meet") return { moves, agreed: null, marked: 0 };
  const a = canonicalWithIndex(moves.map((m) => m.move));
  const b = canonicalWithIndex(exact.moves.map((m) => m.move));
  const map = alignment(
    a.map((x) => x.m),
    b.map((x) => x.m),
  );
  const unsure = new Set<number>();
  let same = a.length === b.length;
  for (let i = 0; i < a.length; i++) {
    const j = map[i];
    if (j < 0) {
      same = false;
      for (const k of a[i].idx) unsure.add(k);
    } else if (b[j].idx.some((k) => exact.moves[k].inferred)) for (const k of a[i].idx) unsure.add(k);
  }
  // 片方にしかない手が、もう片方の手の間に入る: 前後の手も決まっていない
  if (!same) {
    let j0 = -1;
    for (let i = 0; i < a.length; i++) {
      const j = map[i];
      if (j < 0) continue;
      if (j !== j0 + 1) {
        for (const k of a[i].idx) unsure.add(k);
        if (i > 0) for (const k of a[i - 1].idx) unsure.add(k);
      }
      j0 = j;
    }
    if (j0 !== b.length - 1 && a.length) for (const k of a[a.length - 1].idx) unsure.add(k);
  }
  let marked = 0;
  const out = moves.map((m, k) => {
    if (!unsure.has(k) || m.inferred) return m;
    marked++;
    return { ...m, inferred: true };
  });
  return { moves: out, agreed: same && map.every((j, i) => j === i), marked };
}

// 試験・調べ用
export const _verifyInternal = { canonicalWithIndex, alignment };
