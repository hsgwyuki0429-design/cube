// ライブの作り変え: 一番合う仮説でも見え方とはっきり合わないとき、見えている色の組み合わせに合う「物理的にありえる」状態を作る。
// 見えているマスは観測の色のコスト（デコーダと同じ）、見えていないマスは今の仮説の色をなるべく保つ（変えると HIDDEN_COST）として、
// エッジ・コーナーにピースと向きを割り当てる（mostLikelyState。ねじれ・反転・偶奇も満たす）。姿勢は、見えている面の真ん中の色で選ぶ
// （真ん中が隠れていれば今の姿勢に近いもの）。手順を追えなくても、3D はこの状態にその場で作り変え、追跡はここからやり直す
import { type CubeState, VIEW, cubeFaceAt } from "../cube/model";
import { mostLikelyState } from "../cube/pattern";
import { PARTNERS } from "../cube/stickers";
import { observationCost } from "./decoder";
import type { Observation } from "./types";

const HIDDEN_COST = 0.3; // 見えていないマスの色を今の仮説から変えるコスト（見えているマスの矛盾 1.5 より十分小さい）
const KEEP_ORIENT = 0.5; // 今の姿勢を選ぶときの割り引き（真ん中が見えない・区別できないときに、姿勢が跳ねないように）
const IMPLIED_COST = 1.5; // 読んだ ID から決まる、同じピースの見えていない側の色と違うときのコスト

export interface Snapped {
  state: CubeState;
  orient: number;
  cost: number; // 観測の矛盾のコスト（デコーダと同じ計算）
}

export function snapToObservation(prior: CubeState, priorOrient: number, obs: Observation): Snapped | null {
  if (!obs.faces.length) return null;
  // 姿勢の候補: 見えている面の真ん中の色のコストが小さいもの
  const orientCost = (o: number) => obs.faces.reduce((s, f) => s + f.cost[4 * 6 + cubeFaceAt(o, f.slot)], 0) - (o === priorOrient ? KEEP_ORIENT : 0);
  const ranked = Array.from({ length: 24 }, (_, o) => ({ o, c: orientCost(o) })).sort((a, b) => a.c - b.c);
  const candidates = ranked.filter((r) => r.c <= ranked[0].c + 1.5).slice(0, 4);
  let best: Snapped | null = null;
  let bestTotal = Infinity;
  for (const { o, c } of candidates) {
    // 見えているマス（キューブ固定の facelet）→ そのマスの色のコスト
    const seen = new Map<number, { cost: Float32Array; cell: number }>();
    // 読んだステッカーの ID（揃った状態での facelet 番号）から、同じピースの他の facelet の色も決まる（マスごとに違うステッカー）。
    // 色だけで割り当てると、1 面しか見えないときに同じ色の別のピース（赤白と赤緑のエッジなど）を取り違え、ID の矛盾が残った
    const implied = new Map<number, { color: number; w: number }>();
    for (const f of obs.faces)
      for (let cell = 0; cell < 9; cell++) {
        if (f.labels[cell] < 0) continue;
        const facelet = VIEW[(o * 6 + f.slot) * 9 + cell];
        seen.set(facelet, { cost: f.cost, cell });
        const id = f.ids?.[cell] ?? -1;
        if (id < 0 || PARTNERS[facelet].length !== PARTNERS[id].length) continue;
        const w = f.idCost?.[cell] ?? 1;
        PARTNERS[facelet].forEach((g, k) => implied.set(g, { color: Math.floor(PARTNERS[id][k] / 9), w }));
      }
    const { state } = mostLikelyState((facelet, color) => {
      const s = seen.get(facelet);
      const i = implied.get(facelet);
      const extra = i && i.color !== color ? IMPLIED_COST * i.w : 0;
      if (s) return s.cost[s.cell * 6 + color] + extra;
      return (color === prior[facelet] ? 0 : HIDDEN_COST) + extra;
    });
    const cost = observationCost(state, o, obs);
    const total = cost + c;
    if (total < bestTotal) {
      bestTotal = total;
      best = { state, orient: o, cost };
    }
  }
  return best;
}
