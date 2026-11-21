// ステッカーの動きの方程式（精密解析の解き直し: decode.ts）の材料。フレームごとの読み（sight.ts の SightFrame）を
// 「時刻 t に、ピース k の代表が facelet x にある」という式の並びに直す。
//
// マスの位置はカメラのスロット（正面・上・右）では書かず、キューブに固定した座標で書く（認識の出すスロットと格子の向きには頼らない。
// 実物の動画で、キューブを傾けたとき・層を回している途中に「面の中身は正しいのに、スロットや格子の向きだけが狂う」フレームが
// 読みの誤りの大半だった）。面の置き方（キューブのどの面か・90° ごとの向き）は次の 2 つだけで決める:
//   - センターの ID = その面がキューブのどの面か
//   - 面どうしが画像の上でどの辺で接しているか（外枠の辺が重なる）。センターが 1 つ読めて 2 面以上つながっていれば、置き方は 1 つに決まる
// センターが 1 つだけで向きが決まらないつながり（1 面だけ見えている）は、その面の法線まわりの 4 通りを候補にし、前後の置き方の
// 決まったフレーム（と、そこから続けて選んだフレーム）から画像の上の向きの続くものを既定にする（ほかの 3 通りはコストつき）。
// 仮説がセンターの向きを知っていれば、センターのマーカーの向きで 4 通りのどれかが決まる（KIND_CENTER）。センターが 1 つも読めない
// つながりは、24 通りの置き方のうち前後で見えていたピースの位置といちばん合うもの、それも決まらなければ近くの置き方の決まった
// フレームのカメラの姿勢と認識のスロットから既定にする。既定と違う置き方のコストは、同じ形で続いた間で 1 回（枚数で割る）。
// 1 列・1 枚の面（外枠が推定）は、同じフレームの置き方の決まった面から分かるカメラの姿勢と、認識のスロットで置く。
//
// 1 つの式の重み（ビット）は、その読みの種類と「同じマスに続いた同じ読み」の長さごとに測った読み違いの割合 ε から
// log2((1 − ε)·23 / ε)（その位置が正しいときに読む確率と、読み違えて 23 通りのほかの位置のどれかに見える確率の比）。
// 止まっている間に同じマスに続いた同じ読みは 1 つの証拠: 重みを枚数で割って、続いた全部で 1 本ぶんにする。
// DOM もカメラも知らない
import { VIEW } from "../../cube/model";
import { CELL_TURN, type SightFace, type SightFrame, isCenter, placeAll, touching } from "../sight";
import { EXPECT_ROT, NUM_PIECES, PIECE_OF, REF_AT, WHOLE } from "./model";

// 読みの種類
export const KIND_DIRECT = 0; // マーカーを直接読んだ・4 マス以上直接読めた面
export const KIND_FRAGMENT = 1; // マーカーを直接読んだ・1〜3 マスの欠片（1 列・1 枚の面も）
export const KIND_CARRIED = 2; // 前のフレームから引き継いだ ID（このフレームではマーカーを読んでいない）
// センターのマーカーの向き。センターは動かないが、その面を回すと 90° ずつ回る: 格子に対する向き cr と面の置き方 r から、その面の
// センターの向き φ = (cr − r) mod 4（= 最初の向き + その面を回した回数）が分かる。状態に φ を持たせると、仮説ごとに r が決まる
// （1 面だけ見えているとき、その面を回したのかキューブを回したのかを、向きの続きに頼らずに分けられる）。式では「ピース 20 + 面 が φ にある」
export const KIND_CENTER = 3;
export const NUM_KINDS = 4;
export const CENTER_SLOT = NUM_PIECES; // 状態の中のセンターの向きの場所（20〜25）
// 続いた長さの区切り（1・2・3〜4・5〜9・10 以上）
export const LEN_BUCKETS = [1, 2, 3, 5, 10];
export const lenBucket = (n: number): number => {
  let b = 0;
  while (b + 1 < LEN_BUCKETS.length && n >= LEN_BUCKETS[b + 1]) b++;
  return b;
};

// 読み違いの割合 ε（種類 × 続いた長さ）。tests/debug/piecesBench.debug.test.ts の PB_EPS=1 で、実物 5 本（IMG_4972・IMG_5046〜5049）×
// 原画質・5Mbps・2.5Mbps・1.5Mbps の本体の条件（ソルブだけ・止まったフレームを飛ばす）の読みを、新しい正解（buildTruth の BT_OUT）の
// 状態と照らして測った（下の MEASURED_EPS のコメント）。
export interface TableOptions {
  touch: number; // 2 つの面の外枠の辺がこれ（辺の長さに対する割合）より近ければ、その辺で接している
  orientMs: number; // 面の向きを前後の置き方の決まったフレームから引き継ぐ時間
  runGapMs: number; // 同じ読みの続きとみなす、読めなかった間の長さの上限
  eps: number[][]; // ε[種類][長さの区切り]
  twistBits: number; // センターが 1 つだけのつながりで、既定（向きの続くもの）と違う置き方を選ぶコスト
  blindBits: number; // センターのないつながりで、既定と違う置き方を選ぶコスト
  faceBits: number; // 置き方の決まったつながりの中の 1 面だけが違う置き方（その面の格子の向きの誤り。9 本ばらばらに数えず 1 回のコスト）
  blindCells: number; // センターのないつながりは、これだけ読めたマスがなければ使わない
  blindMs: number; // センターのないつながりの既定を決めるのに使う、前後のピースの位置の古さ
  blindMargin: number; // 既定にするのは、2 番目より これだけ多く合う置き方
  debug?: boolean; // 続いた読みの一覧を返す（調査用）
  chainUpdate: boolean; // センター 1 つのつながりの向きの基準を、続きで選んだ置き方からも更新する
  chainMaxTurn: number; // そのとき、基準からこれ（ラジアン）より回っていたら更新しない
  // 向きの続き・前後のピースから既定の決まらないまとまりは、これ（ms）以内の置き方の決まったフレームのカメラの姿勢と、認識のスロットで
  // 既定を決める（0 = 使わない）
  slotMs: number;
  blindKeep: number; // センターのないまとまりで比べる置き方の数
}

// 測った ε（MEASURED_EPS）。行 = 種類（直接・欠片・引き継いだ ID・センターの向き）、列 = 続いた長さ（1・2・3〜4・5〜9・10 以上）。
// 2026-11-20、tests/debug/piecesBench.debug.test.ts の PB_EPS=1: 実物 4 本（IMG_4972・5046・5048・5049。IMG_5047 は正解が作れない）×
// 原画質・5Mbps・2.5Mbps・1.5Mbps の本体の条件の読みを、新しい正解（BT_OUT）の前後 150ms の状態と、正解にいちばん合う置き方で照らした
// （置き方の誤りは下の twistBits など。続いた読みは半分より多くのフレームが合わなければ誤り）:
//   直接・4 マス以上の面: 1 枚 3.66%（1860 本）・2 枚 0.80%（1874）・3〜4 枚 0.63%（2375）・5〜9 枚 0.75%（3594）・10 枚以上 0.24%（3772）
//   直接・1〜3 マスの欠片: 1 枚 6.0%（934）・2 枚 1.4%（279）・3〜4 枚 0.7%（142）・5 枚以上 2/45
//   引き継いだ ID: 1 枚 20%（472）・2 枚 15%（52）・3 枚以上 3/19（長さによらず 15〜20%）
//   センターの向き: 1 枚 13%（238）・2 枚 1.7%（181）・3〜4 枚 1.6%（257）・5〜9 枚 0.26%（386）・10 枚以上 0/438
// 数の少ない所はまとめ、0 の所は 0.2% にした
export const MEASURED_EPS: number[][] = [
  [0.037, 0.008, 0.0065, 0.0065, 0.0025],
  [0.06, 0.015, 0.011, 0.011, 0.011],
  [0.2, 0.155, 0.155, 0.155, 0.155],
  [0.13, 0.017, 0.016, 0.003, 0.002],
];

// 置き方の既定の誤り（同じ測り方、1 面ずつ）: センター 1 つで向きの続きから選んだ既定 986/8686 = 11.4%、センターなしで前後のピースから選んだ
// 既定 1168/2667 = 44%、置き方の決まった面 21/7086 = 0.3%。ほかの候補 1 つを選ぶコスト = log2((1 − 誤り) / (誤り / 候補の数 − 1)):
// センター 1 つ 4.5 ビット（続いた間で 1 回）・センターなし 4.9 ビット（同じ）・置き方の決まった面 10 ビット（1 フレームごと）
export const DEFAULT_TABLE: TableOptions = { touch: 0.45, orientMs: 1500, runGapMs: 300, eps: MEASURED_EPS, twistBits: 4.5, blindBits: 4.9, faceBits: 10, blindCells: 3, blindMs: 400, blindMargin: 2, chainUpdate: true, chainMaxTurn: 0.6, slotMs: 2000, blindKeep: 24 };

export const bitsOf = (eps: number): number => Math.log2(((1 - eps) * 23) / eps);
// ステッカー → 状態の中の場所（ピース 0〜19・センターの向き 20〜25）
export const slotOf = (s: number): number => (isCenter(s) ? CENTER_SLOT + Math.floor(s / 9) : PIECE_OF[s]);
const MODES = { sure: 0, chain: 1, blind: 2, held: 3 } as const;

// 1 つのまとまり（面 1 つか、つながった面）の読み。置き方の候補ごとに、読みが式にする位置
export interface Group {
  n: number; // 読みの数
  P: Uint8Array; // ピース（n）
  S: Uint8Array; // ステッカー（n）
  kind: Uint8Array; // 種類（n）
  A: Uint8Array; // 候補 c の読み i の位置 = A[c * n + i]（その置き方ではありえない読みは 255）
  prior: Float32Array; // 候補ごとのコスト（ビット）。0 番目が既定（0）
  W: Float32Array; // 読みの重み（ビット、続いた枚数で割ったもの）
  R: Float32Array; // その読みが入っている続いた読み全体の重み（割らない。答えの確かめで、見え方が状態を決めているかを測る）
  mode: number; // 0 = 置き方が決まった面・1 = センター 1 つ（4 通り）・2 = センターなし（24 通り）・3 = スロットで置いた欠片
}

export interface FrameEq {
  t: number;
  groups: Group[];
  orient: number; // 置き方の決まった面と認識のスロットが合う姿勢（手の時刻の判定: timing.ts。分からなければ -1）
  sure: boolean; // 置き方がセンターと面の接し方で決まった面がある
}

// 調査用（TableOptions.debug）: 続いた読みごとの、ステッカー・位置・種類・各フレームの時刻
export interface RunInfo {
  sticker: number;
  piece: number;
  x: number;
  kind: number;
  times: number[];
  weight: number; // 続いた全部の重み（ビット）
}

export interface PieceTable {
  frames: FrameEq[];
  runs?: RunInfo[];
  stats: { frames: number; used: number; sure: number; chained: number; free: number; blind: number; held: number; dropped: number; readings: number; runs: number; slotted: number };
}

interface Face0 {
  f: SightFace;
  count: number; // 読めた ID（直接 + 引き継ぎ）の数
  direct: number;
  center: number; // センターの読み（キューブの面）。なければ -1
}

// 面の決まった並びの「上」（格子の辺 r）が画像で向く角度
function upAngle(q: number[], r: number): number {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const i = (r & 3) * 2;
  const j = ((r + 1) & 3) * 2;
  return Math.atan2((q[i + 1] + q[j + 1]) / 2 - cy, (q[i] + q[j]) / 2 - cx);
}

// カメラの姿勢 o で、認識のスロット slot の面の置き方（キューブの面と、決まった並びの上の辺が格子のどの辺にあるか）
export function slotPlacement(o: number, slot: number): { face: number; r: number } | null {
  const face = Math.floor(VIEW[o * 54 + slot * 9 + 4] / 9);
  for (let r = 0; r < 4; r++) if (face * 9 + CELL_TURN[r * 9 + 1] === VIEW[o * 54 + slot * 9 + 1]) return { face, r };
  return null;
}

// 置き方（面 F・向き r）で、面 f の読みを式にする。ありえない読みは 255。センター（向きを直接読んだもの）は φ = (cr − r) mod 4
function equations(f: SightFace, face: number, r: number, out: number[]): void {
  for (let c = 0; c < 9; c++) {
    const s = f.ids[c];
    if (s < 0) continue;
    if (isCenter(s)) {
      if (c !== 4 || f.rot[4] < 0) continue;
      out.push(Math.floor(s / 9) === face ? (f.rot[4] - r + 4) & 3 : 255);
      continue;
    }
    const q = face * 9 + CELL_TURN[r * 9 + c];
    let x = REF_AT[s * 54 + q];
    if (x >= 0 && f.rot[c] >= 0 && EXPECT_ROT[s * 54 + q] !== ((f.rot[c] - r + 4) & 3)) x = -1;
    out.push(x < 0 ? 255 : x);
  }
}

function readingsOf(f: SightFace, kindOf: number): { S: number[]; K: number[] } {
  const S: number[] = [];
  const K: number[] = [];
  for (let c = 0; c < 9; c++) {
    const s = f.ids[c];
    if (s < 0) continue;
    if (isCenter(s)) {
      if (c !== 4 || f.rot[4] < 0) continue;
      S.push(s);
      K.push(KIND_CENTER);
      continue;
    }
    S.push(s);
    K.push(f.rot[c] >= 0 ? kindOf : KIND_CARRIED);
  }
  return { S, K };
}

interface PreGroup {
  faces: SightFace[];
  S: number[];
  K: number[];
  cands: { prior: number; A: number[] }[];
  mode: "sure" | "chain" | "blind" | "held";
  root?: { face: number; idx: number; placed: ({ face: number; r: number } | null)[][] }; // chain: 4 通りの置き方
  blind?: { placed: number[][]; big: number }; // blind: 24 通りの位置（big = 基準にした面）
}

export function buildTable(frames: SightFrame[], options: Partial<TableOptions> = {}): PieceTable {
  const opt = { ...DEFAULT_TABLE, ...options };
  const stats = { frames: frames.length, used: 0, sure: 0, chained: 0, free: 0, blind: 0, held: 0, dropped: 0, readings: 0, runs: 0, slotted: 0 };
  const W = opt.eps.map((row) => row.map(bitsOf));

  // 1) フレームごとに、面のつながり・置き方の候補を作る
  interface Pre {
    t: number;
    groups: PreGroup[];
    orient: number;
    // 置き方の決まった面の、決まった並びの「上」の角度（キューブの面ごと）: センターが 1 つのつながりの向きを引き継ぐ基準
    angles: { face: number; angle: number; w: number }[];
  }
  const pres: Pre[] = [];
  for (const fr of frames) {
    const all: Face0[] = [];
    for (const f of fr.faces) {
      let count = 0;
      let direct = 0;
      for (let c = 0; c < 9; c++)
        if (f.ids[c] >= 0 && !isCenter(f.ids[c])) {
          count++;
          if (f.rot[c] >= 0) direct++;
        }
      const c4 = f.ids[4];
      const center = c4 >= 0 && isCenter(c4) && !f.held ? Math.floor(c4 / 9) : -1;
      if (!count && center < 0) continue;
      all.push({ f, count, direct, center });
    }
    const main = all.filter((x) => !x.f.held && x.f.quad?.length === 8);
    const held = all.filter((x) => x.f.held || x.f.quad?.length !== 8);
    // 面どうしの接し方（a, b, a の辺, b の辺）
    const links: number[][] = [];
    for (let a = 0; a < main.length; a++)
      for (let b = a + 1; b < main.length; b++) {
        let best = Infinity;
        let bi = 0;
        let bj = 0;
        for (let i = 0; i < 4; i++)
          for (let j = 0; j < 4; j++) {
            const d = touching(main[a].f.quad, main[b].f.quad, i, j);
            if (d < best) {
              best = d;
              bi = i;
              bj = j;
            }
          }
        if (best < opt.touch) links.push([a, b, bi, bj]);
      }
    // つながり（連結成分）
    const comp = main.map((_, i) => i);
    const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
    for (const [a, b] of links) comp[find(a)] = find(b);
    const groups: PreGroup[] = [];
    const angles: Pre["angles"] = [];
    const surePlaced: { slot: number; face: number; r: number }[] = [];
    const roots = [...new Set(main.map((_, i) => find(i)))];
    for (const root0 of roots) {
      const idx = main.map((_, i) => i).filter((i) => find(i) === root0);
      const fs = idx.map((i) => main[i].f);
      const sub = links.filter(([a, b]) => find(a) === root0 && find(b) === root0).map(([a, b, i, j]) => [idx.indexOf(a), idx.indexOf(b), i, j]);
      const infos = idx.map((i) => main[i]);
      // 基準の面: センターの読めた面のうち、読めたマスのいちばん多いもの
      let root = -1;
      for (let k = 0; k < infos.length; k++) if (infos[k].center >= 0 && (root < 0 || infos[k].count > infos[root].count)) root = k;
      const nread = infos.reduce((n, x) => n + x.count, 0);
      if (!nread) continue;
      // 面ごとの読み
      const per = infos.map((x) => readingsOf(x.f, x.direct >= 4 ? KIND_DIRECT : KIND_FRAGMENT));
      const S = per.flatMap((p) => p.S);
      const K = per.flatMap((p) => p.K);
      const eqOf = (placed: ({ face: number; r: number } | null)[]): number[] => {
        const A: number[] = [];
        fs.forEach((f, k) => {
          const pl = placed[k];
          if (pl) equations(f, pl.face, pl.r, A);
          else for (let i = 0; i < per[k].S.length; i++) A.push(255);
        });
        return A;
      };
      if (root >= 0) {
        const face0 = infos[root].center;
        const options = [0, 1, 2, 3].map((r) => placeAll(fs, sub, root, face0, r));
        const valid = [0, 1, 2, 3].filter((r) => options[r]);
        if (valid.length === 1) {
          // 置き方が決まった: 面ごとのまとまりにする（1 面だけ格子の向きが狂ったフレームを、その面の置き方の誤り 1 回で数える）
          const placed = options[valid[0]]!;
          fs.forEach((f, k) => {
            const pl = placed[k];
            if (!pl || !per[k].S.length) return;
            surePlaced.push({ slot: f.slot, face: pl.face, r: pl.r });
            angles.push({ face: pl.face, angle: upAngle(f.quad, pl.r), w: infos[k].count + 1 });
            const cands: PreGroup["cands"] = [];
            for (let d = 0; d < 4; d++) {
              const A: number[] = [];
              equations(f, pl.face, (pl.r + d) & 3, A);
              cands.push({ prior: d ? opt.faceBits : 0, A });
            }
            groups.push({ faces: [f], S: per[k].S, K: per[k].K, cands, mode: "sure" });
          });
          continue;
        }
        if (valid.length > 1) {
          // 向きが決まらない（センター 1 つ）: 4 通り。既定は後で向きの続きから決める
          const placed = [0, 1, 2, 3].map((r) => options[r] ?? []);
          groups.push({ faces: fs, S, K, cands: [0, 1, 2, 3].map((r) => ({ prior: options[r] ? 0 : Infinity, A: options[r] ? eqOf(options[r]!) : S.map(() => 255) })), mode: "chain", root: { face: face0, idx: root, placed } });
          continue;
        }
        // センターと接し方が食い違う: つながりを使わず、センターのある面を 1 面ずつ（向きは後で決める）
        fs.forEach((f, k) => {
          if (infos[k].center < 0 || !per[k].S.length) {
            stats.dropped += per[k].S.length;
            return;
          }
          const placed = [0, 1, 2, 3].map((r) => fs.map((_, j) => (j === k ? { face: infos[k].center, r } : null)));
          groups.push({ faces: [f], S: per[k].S, K: per[k].K, cands: [0, 1, 2, 3].map((r) => ({ prior: 0, A: (() => { const A: number[] = []; equations(f, infos[k].center, r, A); return A; })() })), mode: "chain", root: { face: infos[k].center, idx: 0, placed: placed.map((p) => [p[k]]) } });
        });
        continue;
      }
      // センターがない: 24 通り（どの面の、どの向きか）。読めたマスが少なければ使わない
      if (nread < opt.blindCells) {
        stats.dropped += nread;
        continue;
      }
      let big = 0;
      for (let k = 1; k < infos.length; k++) if (infos[k].count > infos[big].count) big = k;
      const placedAll: number[][] = [];
      for (let k = 0; k < 24; k++) {
        const p = placeAll(fs, sub, big, k >> 2, k & 3);
        placedAll.push(p ? eqOf(p) : S.map(() => 255));
      }
      groups.push({ faces: fs, S, K, cands: placedAll.map((A) => ({ prior: 0, A })), mode: "blind", blind: { placed: placedAll, big } });
    }
    // 認識のスロットと合う姿勢
    let orient = -1;
    let bestOk = 0;
    if (surePlaced.length)
      for (let o = 0; o < 24; o++) {
        let ok = 0;
        for (const p of surePlaced) if (VIEW[o * 54 + p.slot * 9 + 4] === p.face * 9 + 4 && VIEW[o * 54 + p.slot * 9 + 1] === p.face * 9 + CELL_TURN[p.r * 9 + 1]) ok++;
        if (ok > bestOk) {
          bestOk = ok;
          orient = o;
        }
      }
    // 1 列・1 枚の面: その姿勢とスロットで置く
    for (const h of held) {
      const rd = readingsOf(h.f, KIND_FRAGMENT);
      if (!rd.S.length) continue;
      if (orient < 0) {
        stats.dropped += rd.S.length;
        continue;
      }
      const A: number[] = [];
      for (let c = 0; c < 9; c++) {
        const s = h.f.ids[c];
        if (s < 0 || isCenter(s)) continue;
        const q = VIEW[orient * 54 + h.f.slot * 9 + c];
        const x = REF_AT[s * 54 + q];
        A.push(x < 0 ? 255 : x);
      }
      groups.push({ faces: [h.f], S: rd.S, K: rd.S.map(() => KIND_FRAGMENT), cands: [{ prior: 0, A }], mode: "held" });
      stats.held++;
    }
    if (!groups.length) continue;
    pres.push({ t: fr.t, groups, orient, angles });
  }

  // 時刻 t にいちばん近い、置き方の決まった面から分かったカメラの姿勢（slotMs 以内。なければ -1）
  const sureT = pres.filter((p) => p.orient >= 0).map((p) => ({ t: p.t, o: p.orient }));
  const nearOrient = (t: number): number => {
    if (!opt.slotMs) return -1;
    let lo = 0;
    let hi = sureT.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sureT[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bd = opt.slotMs;
    for (const k of [lo - 1, lo]) {
      const x = sureT[k];
      if (x && Math.abs(x.t - t) <= bd) {
        bd = Math.abs(x.t - t);
        best = x.o;
      }
    }
    return best;
  };

  // 2) センターが 1 つだけのつながりの向き: 見えている面の、決まった並びの「上」が画像で向く角度が、近くの置き方の決まった
  // フレームから続くもの（読めたマスの数で重み付け）。前向き・後ろ向きにたどり、時間の近い方。基準は置き方の決まったフレームだけ
  // （1 面だけ見えているときにその面を回すと、面の格子は回る面に付いていく。続きのフレームで基準を更新すると、回したのを
  // 「キューブが回った」と読んでしまう）
  const chain = (order: number[]): Map<PreGroup, { r: number; gap: number }> => {
    const angle = new Float64Array(6).fill(Number.NaN);
    const seen = new Float64Array(6).fill(Number.NaN);
    const out = new Map<PreGroup, { r: number; gap: number }>();
    for (const pi of order) {
      const p = pres[pi];
      for (const g of p.groups) {
        if (g.mode !== "chain") continue;
        let best = -Infinity;
        let r = -1;
        let gap = Infinity;
        for (let c = 0; c < 4; c++) {
          if (!Number.isFinite(g.cands[c].prior)) continue;
          const placed = g.root!.placed[c];
          let score = 0;
          let used = false;
          let gg = Infinity;
          g.faces.forEach((f, k) => {
            const pl = placed[k];
            if (!pl || Number.isNaN(angle[pl.face]) || Math.abs(p.t - seen[pl.face]) > opt.orientMs) return;
            score += (f.ids.filter((x) => x >= 0).length + 1) * Math.cos(upAngle(f.quad, pl.r) - angle[pl.face]);
            gg = Math.min(gg, Math.abs(p.t - seen[pl.face]));
            used = true;
          });
          if (used && score > best) {
            best = score;
            r = c;
            gap = gg;
          }
        }
        if (r >= 0) {
          out.set(g, { r, gap });
          // 向きの基準を、続きで選んだ置き方からも更新する（chainUpdate。基準からの角度のずれが小さいときだけ）
          if (opt.chainUpdate && best > 0) {
            const placed = g.root!.placed[r];
            g.faces.forEach((f, k) => {
              const pl = placed[k];
              if (!pl) return;
              const ang = upAngle(f.quad, pl.r);
              if (!Number.isNaN(angle[pl.face]) && Math.cos(ang - angle[pl.face]) < Math.cos(opt.chainMaxTurn)) return;
              angle[pl.face] = ang;
              seen[pl.face] = p.t;
            });
          }
        }
      }
      for (const a of p.angles) {
        angle[a.face] = a.angle;
        seen[a.face] = p.t;
      }
    }
    return out;
  };
  const idx = pres.map((_, i) => i);
  const fwd = chain(idx);
  const bwd = chain([...idx].reverse());
  for (const p of pres)
    for (const g of p.groups) {
      if (g.mode !== "chain") continue;
      const a = fwd.get(g);
      const b = bwd.get(g);
      const pick = !a ? b : !b ? a : b.gap < a.gap ? b : a;
      if (!pick) {
        // 向きの続きが分からない: 近くの置き方の決まったフレームのカメラの姿勢と、認識のスロットから（slotMs 以内）
        const o = nearOrient(p.t);
        const sp = o < 0 ? null : slotPlacement(o, g.faces[g.root!.idx].slot);
        if (sp && sp.face === g.root!.face && Number.isFinite(g.cands[sp.r].prior)) {
          stats.slotted++;
          const c0 = g.cands[sp.r];
          g.cands = [{ ...c0, prior: 0 }, ...g.cands.filter((_, c) => c !== sp.r).map((c) => ({ ...c, prior: Number.isFinite(c.prior) ? opt.twistBits : c.prior }))];
        } else stats.free++;
        continue;
      }
      stats.chained++;
      // 既定を先頭に
      const c0 = g.cands[pick.r];
      const rest = g.cands.filter((_, c) => c !== pick.r).map((c) => ({ ...c, prior: Number.isFinite(c.prior) ? opt.twistBits : c.prior }));
      g.cands = [{ ...c0, prior: 0 }, ...rest];
    }

  // 3) センターのないつながり: 24 通りのうち、前後 blindMs 以内に置き方の決まった読みで見えていたピースの位置といちばん合うもの
  {
    const lastPos = new Int16Array(NUM_PIECES).fill(-1);
    const lastT = new Float64Array(NUM_PIECES).fill(-Infinity);
    const before: { pos: Int16Array; t: Float64Array }[] = [];
    const solid = (g: PreGroup) => g.mode === "sure" || (g.mode === "chain" && g.cands[0].prior === 0 && g.cands.slice(1).every((c) => c.prior > 0));
    for (const p of pres) {
      before.push({ pos: lastPos.slice(), t: lastT.slice() });
      for (const g of p.groups) {
        if (!solid(g)) continue;
        g.S.forEach((s, i) => {
          const x = g.cands[0].A[i];
          if (x === 255 || PIECE_OF[s] < 0) return;
          lastPos[PIECE_OF[s]] = x;
          lastT[PIECE_OF[s]] = p.t;
        });
      }
    }
    lastPos.fill(-1);
    lastT.fill(Infinity);
    for (let pi = pres.length - 1; pi >= 0; pi--) {
      const p = pres[pi];
      for (const g of p.groups) {
        if (g.mode !== "blind") continue;
        const score = g.cands.map((c) => {
          let n = 0;
          g.S.forEach((s, i) => {
            const k = PIECE_OF[s];
            const x = c.A[i];
            if (x === 255 || k < 0) return;
            if ((before[pi].pos[k] === x && p.t - before[pi].t[k] <= opt.blindMs) || (lastPos[k] === x && lastT[k] - p.t <= opt.blindMs)) n++;
          });
          return n;
        });
        let b0 = 0;
        for (let c = 1; c < 24; c++) if (score[c] > score[b0]) b0 = c;
        const second = Math.max(...score.filter((_, c) => c !== b0));
        if (score[b0] >= second + opt.blindMargin) {
          const c0 = g.cands[b0];
          g.cands = [c0, ...g.cands.filter((_, c) => c !== b0).map((c) => ({ ...c, prior: opt.blindBits }))];
          stats.blind++;
        } else {
          // 前後のピースから決まらない: 近くのカメラの姿勢と認識のスロットから
          const o = nearOrient(p.t);
          const sp = o < 0 ? null : slotPlacement(o, g.faces[g.blind!.big].slot);
          if (sp) {
            const k0 = sp.face * 4 + sp.r;
            const c0 = g.cands[k0];
            g.cands = [c0, ...g.cands.filter((_, c) => c !== k0).map((c) => ({ ...c, prior: opt.blindBits }))];
            stats.slotted++;
          } else stats.free++;
        }
        // 候補を絞る: 既定と、前後のピースの位置によく合う方から blindKeep 個（ありえない置き方・同じ式になる置き方は除く）。
        // 24 通り全部を毎回比べると、解き直しの時間の半分ほどがこのまとまりの点数付けになった
        const head = g.cands[0];
        const rest = g.cands
          .slice(1)
          .map((c) => ({ c, sc: score[g.blind!.placed.indexOf(c.A)] ?? 0 }))
          .filter((x) => x.c.A.some((v) => v !== 255))
          .sort((a, b) => b.sc - a.sc);
        const seenA = new Set<string>([head.A.join()]);
        const kept = [head];
        for (const x of rest) {
          if (kept.length >= opt.blindKeep) break;
          const k = x.c.A.join();
          if (seenA.has(k)) continue;
          seenA.add(k);
          kept.push(x.c);
        }
        g.cands = kept;
      }
      for (const g of p.groups) {
        if (!solid(g)) continue;
        g.S.forEach((s, i) => {
          const x = g.cands[0].A[i];
          if (x === 255 || PIECE_OF[s] < 0) return;
          lastPos[PIECE_OF[s]] = x;
          lastT[PIECE_OF[s]] = p.t;
        });
      }
    }
  }

  // 3b) 置き方の既定（向きの続き・前後のピースから選んだもの）の誤りは、続いた間で 1 回: ほかの置き方のコストを、同じ面が続けて
  // その形（センター 1 つ・センターなし）で見えた枚数で割る（1 フレームごとに数えると、続きの既定が外れた区間で、正しい手順の方が
  // 何十ビットも払い、別の手を入れて既定に合わせる手順が選ばれた）
  {
    const open = new Map<string, { t: number; members: PreGroup[] }>();
    const all: { members: PreGroup[] }[] = [];
    for (const p of pres)
      for (const g of p.groups) {
        if (g.mode !== "chain" && g.mode !== "blind") continue;
        const key = g.mode === "chain" ? `c${g.root!.face}` : "b";
        let run = open.get(key);
        if (!run || p.t - run.t > opt.runGapMs) {
          run = { t: p.t, members: [] };
          open.set(key, run);
          all.push(run);
        }
        run.t = p.t;
        run.members.push(g);
      }
    for (const run of all) for (const g of run.members) for (const c of g.cands) if (Number.isFinite(c.prior) && c.prior > 0) c.prior /= run.members.length;
  }

  // 4) 続いた読み（同じステッカーが、既定の置き方で同じ位置に続けて見えた）と重み
  // ステッカーごとに、最後の続き（位置・最後の時刻・読み）
  interface Run {
    s: number;
    x: number;
    t: number;
    kind: number;
    members: { g: PreGroup; i: number; t: number }[];
  }
  const runs: Run[] = [];
  const open: (Run | null)[] = new Array(54).fill(null);
  for (const p of pres)
    for (const g of p.groups)
      g.S.forEach((s, i) => {
        const x = g.cands[0].A[i];
        let run = open[s];
        if (!run || run.x !== x || p.t - run.t > opt.runGapMs) {
          run = { s, x, t: p.t, kind: g.K[i], members: [] };
          open[s] = run;
          runs.push(run);
        }
        run.t = p.t;
        run.kind = Math.min(run.kind, g.K[i]);
        run.members.push({ g, i, t: p.t });
      });
  const weight = new Map<PreGroup, Float32Array>();
  const runWeight = new Map<PreGroup, Float32Array>();
  for (const p of pres)
    for (const g of p.groups) {
      weight.set(g, new Float32Array(g.S.length));
      runWeight.set(g, new Float32Array(g.S.length));
    }
  for (const run of runs) {
    const n = run.members.length;
    const w = W[run.kind][lenBucket(n)];
    for (const m of run.members) {
      weight.get(m.g)![m.i] = w / n;
      runWeight.get(m.g)![m.i] = w;
    }
  }
  stats.runs = runs.length;
  const runInfo = opt.debug ? runs.map((r) => ({ sticker: r.s, piece: slotOf(r.s), x: r.x, kind: r.kind, times: r.members.map((m) => m.t), weight: W[r.kind][lenBucket(r.members.length)] })) : undefined;

  // 5) 出力
  const out: FrameEq[] = [];
  for (const p of pres) {
    const groups: Group[] = [];
    let sure = false;
    for (const g of p.groups) {
      const n = g.S.length;
      if (!n) continue;
      // どの置き方でもありえない読み（マーカーの向きがどれとも合わない・コーナーのステッカーがエッジのマスに見えた）は、どの仮説にも
      // 同じだけ食い違うので手がかりにならない: 除く
      const keep: number[] = [];
      for (let i = 0; i < n; i++) if (g.cands.some((c) => Number.isFinite(c.prior) && c.A[i] !== 255)) keep.push(i);
      stats.dropped += n - keep.length;
      if (!keep.length) continue;
      const nc = g.cands.length;
      const m = keep.length;
      const A = new Uint8Array(nc * m);
      g.cands.forEach((c, k) => keep.forEach((i, j) => (A[k * m + j] = c.A[i])));
      const w = weight.get(g)!;
      const rw = runWeight.get(g)!;
      groups.push({ n: m, P: Uint8Array.from(keep, (i) => slotOf(g.S[i])), S: Uint8Array.from(keep, (i) => g.S[i]), kind: Uint8Array.from(keep, (i) => g.K[i]), A, prior: Float32Array.from(g.cands, (c) => c.prior), W: Float32Array.from(keep, (i) => w[i]), R: Float32Array.from(keep, (i) => rw[i]), mode: MODES[g.mode] });
      stats.readings += m;
      if (g.mode === "sure") sure = true;
    }
    if (!groups.length) continue;
    if (sure) stats.sure++;
    out.push({ t: p.t, groups, orient: p.orient, sure });
  }
  stats.used = out.length;
  return { frames: out, stats, ...(runInfo ? { runs: runInfo } : {}) };
}

// 置き方の候補 c で、まとまり g の読み i が「ピース P[i] が A[c * n + i] にある」と読める（調査用）
export function groupPositions(g: Group, c: number): Uint8Array {
  return g.A.subarray(c * g.n, (c + 1) * g.n);
}

// キューブ全体を面 x の法線のまわりに d × 90° 回した位置（ほかの置き方を作るときに使う）
export const turnedPosition = (x: number, d: number, p: number): number => WHOLE[(x * 4 + d) * 54 + p];
