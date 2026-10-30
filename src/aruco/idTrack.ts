// ID なし追跡: マーカーの ID が読めなくなったマス（指が一部にかかった・少しぶれた）に、直前のフレームで同じマスに読めていた
// ステッカーの ID を引き継ぐ。「同じマス」は、組み立てた面の格子で求めたマスの中心が、前のフレームのそのマスの中心の近くにあること
// （マスの輪郭で追う）。引き継いだ ID は弱い観測で、確からしさはフレームごとに下がり、一定時間で切れる。
// 読めない理由があるマスだけ引き継ぐ: 色が合う（色による補完）か、指がかかっている（allow で渡す。肌らしい点がある）。
// 30fps では回している層のマーカーはぶれて読めないが、格子は本体から求めるのでマスの位置は動かない。理由なしに引き継ぐと、
// 回した後のマスに前のステッカーを置いてしまう。
// 次のときは引き継がない（決めつけない）:
//   - そのマスの層を回している途中（回転途中の形状認識: turn.ts）
//   - 同じ面の読めたマスのステッカーが、前のフレームと食い違う（見えないうちに層を回した）
//   - そのマスで色が分かっていて（色による補完）、引き継ぐ ID の色と違う
// 精密解析・キューブモードでは、後ろのフレームからも同じように引き継ぐ（前後フレーム）。DOM もカメラも知らない
import { NORMAL, faceletGeometry } from "../cube/model";
import { type Pt, applyH } from "../vision/homography";
import { type VisibleFace, cellH } from "./cube";

export interface IdTrackOptions {
  maxGapMs: number; // これより前のフレームからは引き継がない
  posTol: number; // マスの中心のずれの許容（マスの間隔に対する割合）
  decay: number; // 1 フレーム引き継ぐごとに確からしさにかける
  minConf: number; // これより低くなったら引き継がない
  startConf: number; // 読めたマスから引き継いだときの確からしさの上限
}

export const DEFAULT_ID_TRACK: IdTrackOptions = { maxGapMs: 150, posTol: 0.3, decay: 0.85, minConf: 0.3, startConf: 0.7 };

interface Cell {
  slot: number;
  cell: number;
  center: Pt;
  id: number;
  color: number;
  conf: number; // 次のフレームへ引き継ぐときの確からしさ
}

interface Snapshot {
  t: number;
  cells: Cell[];
  faceIds: Map<number, Int16Array>; // 面ごとの、読めた（引き継いでいない）ステッカー
}

const cellCenter = (f: VisibleFace, cell: number): Pt => applyH(cellH(f, cell), (cell % 3) + 0.5, Math.floor(cell / 3) + 0.5);
const facePitch = (f: VisibleFace) => {
  const a = applyH(f.H, 1, 1.5);
  const b = applyH(f.H, 2, 1.5);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

// 外側の面 s の層を回すと動くマス（slot * 9 + cell）。カメラフレームの面のセルの並びはキューブの面と同じ表（src/cube/model）なので、
// マスの位置が s の法線の側にあるもの
export const LAYER_CELLS: Set<number>[] = NORMAL.map((n) => {
  const out = new Set<number>();
  for (let i = 0; i < 54; i++) {
    const p = faceletGeometry(i).pos;
    if (p[0] * n[0] + p[1] * n[1] + p[2] * n[2] === 1) out.add(i);
  }
  return out;
});

export class IdTracker {
  private prev: Snapshot | null = null;

  constructor(readonly options: IdTrackOptions = DEFAULT_ID_TRACK) {}

  reset(): void {
    this.prev = null;
  }

  // faces の ID が分からないマスを、前のフレームから埋める（faces を書き換える）。turnSlot: いま回している層の外側の面（なければ null）。
  // 埋めたマスの番号（slot * 9 + cell）を返す
  // allow: 色が分からないマスでも引き継いでよいか（指がかかっている）。省略時はすべて許す
  update(t: number, faces: VisibleFace[], turnSlot: number | null = null, allow: (slot: number, cell: number) => boolean = () => true): Set<number> {
    const o = this.options;
    const filled = new Set<number>();
    // 後ろのフレームから引き継ぐ（逆向きに通す）ときは t が減る
    const prev = this.prev && Math.abs(t - this.prev.t) <= o.maxGapMs ? this.prev : null;
    // 読めた（引き継ぐ前の）ステッカー
    const readIds = new Map(faces.map((f) => [f.slot, Int16Array.from(f.ids)]));
    if (prev) {
      for (const f of faces) {
        if (f.partial) continue;
        // 同じ面の読めたマスが前のフレームと食い違えば、見えないうちに動いた: この面は引き継がない
        const before = prev.faceIds.get(f.slot);
        if (before && f.ids.some((id, c) => id >= 0 && before[c] >= 0 && before[c] !== id)) continue;
        const pitch = facePitch(f);
        for (let cell = 0; cell < 9; cell++) {
          if (f.ids[cell] >= 0) continue;
          if (turnSlot !== null && LAYER_CELLS[turnSlot].has(f.slot * 9 + cell)) continue;
          const at = cellCenter(f, cell);
          const p = prev.cells.find((x) => x.slot === f.slot && x.cell === cell);
          if (!p || p.conf < o.minConf) continue;
          if (Math.hypot(p.center[0] - at[0], p.center[1] - at[1]) > o.posTol * pitch) continue;
          if (f.colors[cell] >= 0 ? f.colors[cell] !== p.color : !allow(f.slot, cell)) continue;
          // 色で補ったマス（色が合う）なら、ステッカーの身元が加わる。確からしさは高い方
          f.conf[cell] = f.colors[cell] >= 0 ? Math.max(f.conf[cell], p.conf) : p.conf;
          f.ids[cell] = p.id;
          f.colors[cell] = p.color;
          filled.add(f.slot * 9 + cell);
        }
      }
    }
    const cells: Cell[] = [];
    for (const f of faces) {
      if (f.partial) continue;
      for (let cell = 0; cell < 9; cell++) {
        if (f.ids[cell] < 0) continue;
        const read = !filled.has(f.slot * 9 + cell);
        cells.push({ slot: f.slot, cell, center: cellCenter(f, cell), id: f.ids[cell], color: f.colors[cell], conf: read ? Math.min(o.startConf, f.conf[cell]) : f.conf[cell] * o.decay });
      }
    }
    this.prev = { t, cells, faceIds: readIds };
    return filled;
  }
}
