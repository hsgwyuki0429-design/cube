// 回転途中の形状認識の手がかり（Observation.turns）: 認識の側のつながり → 手がかり、デコーダでの照らし合わせ
import { describe, expect, it } from "vitest";
import { MOVE_NAMES, solvedState } from "../src/cube/model";
import { MoveDecoder, turnConsistent } from "../src/track/decoder";
import { turnHint } from "../src/track/engine";
import { reversedObservations } from "../src/track/offline";
import type { Observation, TurnHint } from "../src/track/types";

const deg = (d: number) => (d * Math.PI) / 180;
const snap = (slot: number, totalDeg: number, o: { frames?: number; maxStep?: number; first?: number } = {}) => ({
  slot,
  start: 0,
  first: deg(o.first ?? 5),
  total: deg(totalDeg),
  frames: o.frames ?? 8,
  maxStep: deg(o.maxStep ?? 10),
});

describe("回転途中の形のつながり → 手がかり", () => {
  it("回した量: 軸の正の側の層を負の側に対して、軸の正の向きのまわりに 90° 単位", () => {
    // 右の面（軸の正の側）が -90°（外から見て時計回り）= R → 3
    expect(turnHint(snap(1, -84))).toEqual({ slot: 1, quarters: 3 });
    // 上の面が +90° = U' → 1
    expect(turnHint(snap(0, 80))).toEqual({ slot: 0, quarters: 1 });
    // 左の面（負の側）が軸の正の向きのまわりに +90° = 外から見て時計回り（L）。正の側から見ると -90° → 3
    expect(turnHint(snap(4, 85))).toEqual({ slot: 4, quarters: 3 });
  });

  it("45° に届かない回転は使わない。粗くしか追えていない・途中から見えた・回し終わりで止まっていないときは軸だけ", () => {
    expect(turnHint(snap(1, -30))).toBeNull();
    expect(turnHint(snap(1, -80, { frames: 1 }))).toBeNull();
    expect(turnHint(snap(1, -80, { maxStep: 40 }))).toEqual({ slot: 1, quarters: null });
    expect(turnHint(snap(1, -80, { first: -35 }))).toEqual({ slot: 1, quarters: null });
    expect(turnHint(snap(1, -60))).toEqual({ slot: 1, quarters: null });
  });

  it("90° が見えたら、同じ向きの 90° か半回転なら合う（半回転は途中で立方体の形を通るので、見えた回転が途切れることがある）", () => {
    expect(turnConsistent(3, 3)).toBe(true);
    expect(turnConsistent(3, 2)).toBe(true);
    expect(turnConsistent(3, 1)).toBe(false);
    expect(turnConsistent(3, 0)).toBe(false);
    expect(turnConsistent(2, 2)).toBe(true);
    expect(turnConsistent(2, 1)).toBe(false);
  });
});

// 揃った状態から R か R' を回した後の正面: 右の列だけが「白か黄」（白と黄は見分けにくい読み）。R（黄）と R'（白）のどちらでも合う
function ambiguousFront(turns?: TurnHint[]): Observation {
  const cost = new Float32Array(54);
  const labels = new Int8Array(9);
  for (let cell = 0; cell < 9; cell++) {
    const ok = cell % 3 === 2 ? [0, 3] : [2];
    labels[cell] = cell % 3 === 2 ? -1 : 2;
    for (let c = 0; c < 6; c++) cost[cell * 6 + c] = ok.includes(c) ? 0 : 1.5;
  }
  return { t: 100, tPrevEnd: 0, faces: [{ slot: 2, cost, labels }], turns };
}

describe("デコーダ: 見えた層の回転と合わない手の並びは高くつく", () => {
  const decode = (turns?: TurnHint[]) => {
    const d = new MoveDecoder(solvedState(), { priorWeight: 0 }, [0]);
    d.observe(ambiguousFront(turns));
    return d.bestMoves().map((m) => MOVE_NAMES[m.move]);
  };
  it("色だけでは R と R' を見分けられない観測で、右の層が時計回りに回るのが見えたら R、反時計回りなら R'", () => {
    expect(decode([{ slot: 1, quarters: 3 }])).toEqual(["R"]);
    expect(decode([{ slot: 1, quarters: 1 }])).toEqual(["R'"]);
    // 左の面の層（同じ軸）が見えても、正の側から見た向きで照らす: L 側が時計回り（正の側から -90°）= R と同じ向き
    expect(decode([{ slot: 4, quarters: 3 }])).toEqual(["R"]);
  });

  it("逆向きに解くときは、次の観測の手がかりを逆向きにして使う", () => {
    const obs: Observation[] = [
      { ...ambiguousFront(), t: 0, tPrevEnd: 0, turns: undefined },
      { ...ambiguousFront([{ slot: 1, quarters: 3 }]), t: 100, tPrevEnd: 50 },
    ];
    const rev = reversedObservations(obs, 200);
    expect(rev[0].turns).toBeUndefined();
    expect(rev[1].turns).toEqual([{ slot: 1, quarters: 1 }]);
  });
});
