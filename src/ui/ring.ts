// 円環図（極投影の同心円）の幾何。キューブを上（U）から見下ろし、表面を U を中心に外へ広げた 2D の図。
// 内側から U のセンター・U の周り 8・側面の上段 12・中段 12・下段 12・D の周り 8・D のセンター（外周）の 54 マス。
// 正面（F）を下・R を右・B を上・L を左に置く（上から見下ろした向き）。U・D・E の手はリングの回転そのものになる
// （U は U の周りが 2 マス・上段が 3 マス回る）。DOM を持たない（tests/ring.test.ts で検証）
import { MOVE_DEST, faceletGeometry } from "../cube/model";

export interface RingCell {
  facelet: number;
  ring: number; // 0: U センター, 1: U の周り, 2〜4: 側面の上・中・下段, 5: D の周り, 6: D センター
  angle: number; // 中心の角度（ラジアン。0 = 正面 = 下、増える向きは F → R → B → L）
  width: number; // 角度の幅（ラジアン。センターは 2π）
}

// リングの内径・外径（図の半径 = 1）
export const RADII: [number, number][] = [
  [0, 0.12],
  [0.13, 0.3],
  [0.31, 0.45],
  [0.46, 0.6],
  [0.61, 0.75],
  [0.76, 0.92],
  [0.93, 1],
];

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

export const RING_CELLS: RingCell[] = Array.from({ length: 54 }, (_, f) => {
  const face = Math.floor(f / 9);
  const { pos, normal } = faceletGeometry(f);
  const center = f % 9 === 4;
  if (face === 0 || face === 3) {
    // U・D: 水平面の向き (x, z) の角度。センターは真ん中（U）か外周（D）
    if (center) return { facelet: f, ring: face === 0 ? 0 : 6, angle: 0, width: TAU };
    return { facelet: f, ring: face === 0 ? 1 : 5, angle: wrap(Math.atan2(pos[0], pos[2])), width: TAU / 8 };
  }
  // 側面: 面の向きの角度 + 列（F → R の向きに 30° ずつ）。段は上（y = 1）から
  const base = Math.atan2(normal[0], normal[2]);
  const k = pos[0] * Math.cos(base) - pos[2] * Math.sin(base);
  return { facelet: f, ring: 3 - pos[1], angle: wrap(base + (k * Math.PI) / 6), width: TAU / 12 };
});

// 図の上の位置（中心 = 原点、半径 1。x 右・y 下）
export function ringPoint(angle: number, r: number): [number, number] {
  return [r * Math.sin(angle), r * Math.cos(angle)];
}

// マスの中心（センターは U が原点、D は外周の下）
export function cellCenter(c: RingCell): [number, number] {
  if (c.ring === 0) return [0, 0];
  const [r0, r1] = RADII[c.ring];
  return ringPoint(c.angle, (r0 + r1) / 2);
}

// マスの外形（SVG の path。scale 倍、中心 (cx, cy)）
export function cellPath(c: RingCell, scale: number, cx = 0, cy = 0): string {
  const [r0, r1] = RADII[c.ring].map((r) => r * scale);
  const P = (a: number, r: number) => {
    const [x, y] = ringPoint(a, r);
    return `${(cx + x).toFixed(2)} ${(cy + y).toFixed(2)}`;
  };
  if (c.width >= TAU - 1e-9) {
    // 円（U センター）か円環（D センター）: 2 つの半円で
    const outer = `M ${P(0, r1)} A ${r1} ${r1} 0 1 0 ${P(Math.PI, r1)} A ${r1} ${r1} 0 1 0 ${P(0, r1)} Z`;
    if (r0 <= 0) return outer;
    return `${outer} M ${P(0, r0)} A ${r0} ${r0} 0 1 1 ${P(Math.PI, r0)} A ${r0} ${r0} 0 1 1 ${P(0, r0)} Z`;
  }
  const a0 = c.angle - c.width / 2;
  const a1 = c.angle + c.width / 2;
  // 角度が増える向きは画面では反時計回り（sweep 0）
  return `M ${P(a0, r0)} L ${P(a0, r1)} A ${r1} ${r1} 0 0 0 ${P(a1, r1)} L ${P(a1, r0)} A ${r0} ${r0} 0 0 1 ${P(a0, r0)} Z`;
}

// 手 move で動くステッカーの移動（元の facelet → 行き先）
export function moveArrows(move: number): { from: number; to: number }[] {
  const dest = MOVE_DEST[move];
  const out: { from: number; to: number }[] = [];
  for (let f = 0; f < 54; f++) if (dest[f] !== f) out.push({ from: f, to: dest[f] });
  return out;
}
