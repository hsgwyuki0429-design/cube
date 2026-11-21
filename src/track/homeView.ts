// 1 フレームの見え方（sight.ts の SightFrame: 面ごとに読んだステッカーの ID・マーカーの向き・面の外枠）を、ある状態と ID で直接照らす。
// 追跡の仮説にもスロットの割り当てにも頼らない（タイマーの開始と停止の判定: src/app/startDetect.ts・src/app/stopDetect.ts）。
//   - solvedView: 読めたステッカーが全部「揃ったときの自分の場所」にいるか。面ごとに、読んだ ID から面（センター）と置き方（格子に対して
//     何度回っているか）が 1 つに決まる（揃っていれば面の 9 枚はその面のステッカーで、並びは決まった並びを回したもの）。面どうしが
//     画像の上で接していれば、その辺がキューブでも接する辺か（sight.ts の placeAll）を確かめる。PLL の途中・AUF は、色は揃って見えても
//     別のステッカーが混ざる・並びが違う・接し方が合わないので揃いにしない
//   - changedFrom: 読めたステッカーが、ある状態（スクランブルの状態）のどこかの置き方でそのまま見えるか。面ごとに 24 通りの置き方の
//     どれかで合えば変わっていない（持ち替え = 全部の ID が一緒に動くだけなら合う）
// DOM もカメラも知らない
import type { CubeState } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
import { EXPECT_ROT } from "./pieces/model";
import { CELL_TURN, type SightFace, type SightFrame, isCenter, placeAll, touching } from "./sight";

const TOUCH = 0.45; // 面どうしが接しているとみる辺の重なりの悪さ（slotCheck.ts と同じ）

export interface HomeOptions {
  // マーカーを直接読んだマスだけを使う（既定 true）。前のフレームから引き継いだ ID（rot = -1）は 15〜20% 読み違える
  // （docs/history.md の「ステッカーの動きの方程式」の ε）。最後の手の直後に引き継いだ古い ID が残ると揃いが遅れる
  direct?: boolean;
}

export interface SolvedView {
  ok: boolean; // 読めたステッカーに、揃ったときの場所にいないものがない
  home: number; // 接し方で確かめられた面のまとまり（いちばん大きいもの）の、揃ったときの場所にいるステッカーの数
  faces: number; // そのまとまりの面の数
  read: number; // 使った読みの数（全部の面）
}

interface Read {
  c: number; // マス
  id: number;
  rot: number; // -1 = 引き継いだ ID
}

function readsOf(f: SightFace, direct: boolean): Read[] {
  const out: Read[] = [];
  for (let c = 0; c < 9; c++) {
    const id = f.ids[c];
    if (id < 0 || (direct && f.rot[c] < 0)) continue;
    out.push({ c, id, rot: f.rot[c] });
  }
  return out;
}

// 揃っているなら面 f は (face, r)。合わない読みがあれば null。r = -1 は決まらない（センターだけ）
function homePlacement(reads: Read[]): { face: number; r: number } | null {
  let face = -1;
  let r = -1;
  for (const x of reads) {
    const fx = Math.floor(x.id / 9);
    if (face >= 0 && fx !== face) return null;
    face = fx;
    if (isCenter(x.id)) {
      if (x.c !== 4) return null;
      continue; // センターの向きは揃っていても決まらない（その面を回した回数 mod 4）
    }
    let rx = -1;
    for (let k = 0; k < 4; k++) if (CELL_TURN[k * 9 + x.c] === x.id % 9) rx = k;
    if (rx < 0) return null; // エッジのマスにコーナー（またはその逆）
    if (r >= 0 && rx !== r) return null;
    r = rx;
    // マーカーの向き: 揃っていれば、どのステッカーも面の決まった並びの上を向く（格子での向き = r）
    if (x.rot >= 0 && x.rot !== r) return null;
  }
  return face >= 0 ? { face, r } : null;
}

export function solvedView(sight: SightFrame, opts: HomeOptions = {}): SolvedView {
  const direct = opts.direct ?? true;
  const fs: SightFace[] = [];
  const places: { face: number; r: number }[] = [];
  const counts: number[] = [];
  let read = 0;
  for (const f of sight.faces) {
    const reads = readsOf(f, direct);
    if (!reads.length) continue;
    read += reads.length;
    const p = homePlacement(reads);
    if (!p) return { ok: false, home: 0, faces: 0, read };
    fs.push(f);
    places.push(p);
    counts.push(reads.length);
  }
  // 同じ面・反対の面が 2 つ見えることはない
  for (let a = 0; a < fs.length; a++)
    for (let b = a + 1; b < fs.length; b++) if (places[a].face === places[b].face || places[a].face === (places[b].face + 3) % 6) return { ok: false, home: 0, faces: 0, read };
  // 接している面の組: その辺がキューブでも接していること（1 列・1 枚の面・外枠のない面は辺が当てにならないので使わない）
  const edgeOk = (f: SightFace) => !f.held && f.quad?.length === 8;
  const links: number[][] = [];
  for (let a = 0; a < fs.length; a++)
    for (let b = a + 1; b < fs.length; b++) {
      if (!edgeOk(fs[a]) || !edgeOk(fs[b])) continue;
      let best = Infinity;
      let bi = 0;
      let bj = 0;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
          const d = touching(fs[a].quad, fs[b].quad, i, j);
          if (d < best) {
            best = d;
            bi = i;
            bj = j;
          }
        }
      if (best < TOUCH) links.push([a, b, bi, bj]);
    }
  // まとまり（接し方でつながる面）ごとに、置き方を 1 つの面から広げて、ほかの面の置き方と合うかを見る
  const group = fs.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (const [a, b] of links) group[find(a)] = find(b);
  let home = 0;
  let faces = 0;
  for (let root = 0; root < fs.length; root++) {
    if (find(root) !== root) continue;
    const members = fs.map((_, i) => i).filter((i) => find(i) === root);
    if (members.length > 1) {
      // 置き方の決まった面から広げる（センターだけの面は向きが決まらないので、4 通りのどれかで合えばよい）
      const start = members.find((i) => places[i].r >= 0);
      if (start === undefined) continue; // センターしか読めていない面どうし: 確かめられないので数えない
      const placed = placeAll(fs, links, start, places[start].face, places[start].r);
      if (!placed) return { ok: false, home: 0, faces: 0, read };
      for (const i of members) {
        const pl = placed[i];
        if (!pl) continue;
        if (pl.face !== places[i].face || (places[i].r >= 0 && pl.r !== places[i].r)) return { ok: false, home: 0, faces: 0, read };
      }
    }
    const n = members.reduce((s, i) => s + counts[i], 0);
    if (n > home) {
      home = n;
      faces = members.length;
    }
  }
  return { ok: true, home, faces, read };
}

export interface ChangedView {
  read: number; // 使った読みの数
  mismatch: number; // 面ごとにいちばん合う置き方で合わなかった読みの数の合計
  worst: number; // 1 つの面で合わなかった読みの数の最大
  faces: number; // 読みが 3 つ以上あった面の数
}

// 状態 state のキューブを、面ごとにいちばん合う置き方で見たとき、読みと合わない数
export function changedFrom(sight: SightFrame, state: CubeState | number[], opts: HomeOptions = {}): ChangedView {
  const direct = opts.direct ?? true;
  const ids = new Int16Array(54);
  for (let f = 0; f < 54; f++) ids[f] = stickerIdAt(state, f);
  let read = 0;
  let mismatch = 0;
  let worst = 0;
  let faces = 0;
  for (const f of sight.faces) {
    const reads = readsOf(f, direct);
    if (!reads.length) continue;
    read += reads.length;
    if (reads.length >= 3) faces++;
    let best = Infinity;
    for (let face = 0; face < 6 && best > 0; face++)
      for (let r = 0; r < 4 && best > 0; r++) {
        let miss = 0;
        for (const x of reads) {
          const q = face * 9 + CELL_TURN[r * 9 + x.c];
          const s = ids[q];
          if (s !== x.id) miss++;
          else if (x.rot >= 0 && !isCenter(s) && EXPECT_ROT[s * 54 + q] !== ((x.rot - r + 4) & 3)) miss++;
          if (miss >= best) break;
        }
        if (miss < best) best = miss;
      }
    mismatch += best;
    if (best > worst) worst = best;
  }
  return { read, mismatch, worst, faces };
}
