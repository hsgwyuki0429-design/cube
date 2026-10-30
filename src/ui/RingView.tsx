// 円環図: 54 マスの対応（どのステッカーがどこにあるか）・確からしさ・直前の手での移動を、極投影の同心円で描く（幾何は ring.ts）。
// U を中心に、正面（F）を下に置いて上から見下ろした図。U・D の手はリングの回転、R・L・F・B の手はリングをまたぐ矢印になる
import { FACES, moveAmount, moveFace } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
import { CERTAIN, type CellBelief } from "../track/engine";
import { RADII, RING_CELLS, cellCenter, cellPath, moveArrows, ringPoint } from "./ring";

export interface RingViewProps {
  state: ArrayLike<number>; // facelet → 色（面番号）
  colors: string[]; // 面番号 → CSS
  cells?: CellBelief | null; // マスごとの確からしさ（なければすべて確か）
  lastMove?: number | null; // 直前の手（キューブ固定の 0..17）
  showIds?: boolean; // そこにあるステッカーの番号（U0〜B8）を書く
  highlight?: Set<number>; // 太い枠で示すマス（いまのフレームで見えているマスなど）
  size?: number; // px
  // 直前の手の矢印をすべて描く（既定: 回した面の中は回転の矢印 1 つ、他の面へ移るものはエッジ 4 枚だけ）
  allArrows?: boolean;
}

const NAME = (id: number) => (id < 0 ? "?" : `${FACES[Math.floor(id / 9)]}${id % 9}`);
const isEdge = (f: number) => f % 2 === 1; // センターでもコーナーでもないマス
const faceOf = (f: number) => Math.floor(f / 9);

const angleDelta = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// 回した面の中の回転を表す曲がった矢印。U・D は原点のまわり（U の周り・D の周りのリング）、側面はその面のセンターのまわり。
// 向きは実際に動くステッカー（その面の中のエッジ）から決める（D は上から透かして見ているので、見かけの向きが逆になる）
function faceTurn(move: number, R: number, c: number): { d: string; half: boolean; label: [number, number] } | null {
  const face = moveFace(move);
  const edge = moveArrows(face * 3).find(({ from, to }) => faceOf(from) === face && faceOf(to) === face && isEdge(from));
  if (!edge) return null;
  const a = RING_CELLS[edge.from];
  const b = RING_CELLS[edge.to];
  let ccw: boolean; // 時計回り 90°（X）が画面で反時計回りに見えるか
  let center: [number, number];
  let r: number;
  if (face === 0 || face === 3) {
    center = [c, c];
    const ring = face === 0 ? 1 : 5;
    r = ((RADII[ring][0] + RADII[ring][1]) / 2) * R;
    ccw = angleDelta(a.angle, b.angle) > 0; // 角度が増える = 画面で反時計回り
  } else {
    const p = cellCenter(RING_CELLS[face * 9 + 4]);
    center = [c + p[0] * R, c + p[1] * R];
    r = (RADII[3][1] - RADII[3][0]) * R * 0.42;
    const pa = cellCenter(a);
    const pb = cellCenter(b);
    ccw = (pa[0] - p[0]) * (pb[1] - p[1]) - (pa[1] - p[1]) * (pb[0] - p[0]) < 0; // y が下の画面で外積が負 = 反時計回り
  }
  const dir = ccw !== (moveAmount(move) === 3) ? -1 : 1; // -1: 画面で反時計回り（X' は逆向き）
  // 300° の弧（真上から）
  const start = -Math.PI / 2;
  const end = start + dir * ((Math.PI * 5) / 3);
  const P = (t: number) => `${(center[0] + r * Math.cos(t)).toFixed(1)} ${(center[1] + r * Math.sin(t)).toFixed(1)}`;
  return {
    d: `M ${P(start)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 1 ${dir > 0 ? 1 : 0} ${P(end)}`,
    half: moveAmount(move) === 2,
    label: [center[0], center[1] - r - 6],
  };
}

export function RingView({ state, colors, cells, lastMove, showIds, highlight, size = 300, allArrows }: RingViewProps) {
  const R = size / 2 - 4;
  const c = size / 2;
  const at = (p: [number, number]): [number, number] => [c + p[0] * R, c + p[1] * R];
  const has = lastMove !== null && lastMove !== undefined;
  // 他の面へ移るステッカー（既定はエッジだけ: 4 本で回る向きが分かる）
  const arrows = has ? moveArrows(lastMove).filter(({ from, to }) => allArrows || (faceOf(from) !== faceOf(to) && isEdge(from))) : [];
  const turn = has && !allArrows ? faceTurn(lastMove, R, c) : null;
  return (
    <svg class="ring-view" viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="円環図（54 マスの対応）">
      <defs>
        <pattern id="ring-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(0,0,0,0.55)" stroke-width="2" />
        </pattern>
        <marker id="ring-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#111" />
        </marker>
      </defs>
      {RING_CELLS.map((rc) => {
        const f = rc.facelet;
        const unsure = cells ? cells.certainty[f] < CERTAIN : false;
        const inferred = cells ? cells.seenAt[f] < cells.movedAt[f] : false;
        const d = cellPath(rc, R, c, c);
        const strong = highlight?.has(f);
        return (
          <g key={f} class={`ring-cell${unsure ? " unsure" : ""}${inferred ? " inferred" : ""}`}>
            <path d={d} fill={colors[state[f]] ?? "#888"} fill-rule="evenodd" opacity={inferred && !unsure ? 0.7 : 1} stroke={strong ? "#111" : "#333"} stroke-width={strong ? 2.4 : 0.8} stroke-dasharray={inferred ? "3 2" : undefined} />
            {unsure && <path d={d} fill="url(#ring-hatch)" fill-rule="evenodd" pointer-events="none" />}
          </g>
        );
      })}
      {/* 面の名前（センター）とステッカーの番号 */}
      {RING_CELLS.map((rc) => {
        const f = rc.facelet;
        const isCenter = f % 9 === 4;
        if (!isCenter && !showIds) return null;
        const [x, y] = rc.ring === 6 ? at(ringPoint(Math.PI, (RADII[6][0] + RADII[6][1]) / 2)) : at(cellCenter(rc));
        const label = isCenter ? FACES[faceOf(f)] : NAME(stickerIdAt(state as number[], f));
        return (
          <text key={`t${f}`} x={x} y={y} class={`ring-label${isCenter ? " center" : ""}`} text-anchor="middle" dominant-baseline="central" font-size={isCenter ? size / 20 : size / 36}>
            {label}
          </text>
        );
      })}
      {arrows.map(({ from, to }) => {
        const a = RING_CELLS[from];
        const b = RING_CELLS[to];
        const [x0, y0] = at(cellCenter(a));
        const [x1, y1] = at(cellCenter(b));
        let d: string;
        if (a.ring === b.ring && a.ring !== 0 && a.ring !== 6) {
          // 同じリングの中の移動（U・D の手の側面）: リングに沿った弧
          const r = ((RADII[a.ring][0] + RADII[a.ring][1]) / 2) * R;
          d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${angleDelta(a.angle, b.angle) > 0 ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
        } else {
          // リングをまたぐ移動: 中心側へ少しふくらませた曲線
          const mx = (x0 + x1) / 2;
          const my = (y0 + y1) / 2;
          d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${(mx + (c - mx) * 0.25).toFixed(1)} ${(my + (c - my) * 0.25).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
        }
        return <path key={`a${from}`} d={d} fill="none" stroke="#111" stroke-width="1.6" opacity="0.8" marker-end="url(#ring-arrow)" />;
      })}
      {turn && <path d={turn.d} fill="none" stroke="#111" stroke-width="2" opacity="0.85" marker-end="url(#ring-arrow)" />}
      {turn?.half && (
        <text x={turn.label[0]} y={turn.label[1]} class="ring-label center" text-anchor="middle" dominant-baseline="central" font-size={size / 22}>
          ×2
        </text>
      )}
    </svg>
  );
}

// 凡例
export function RingLegend() {
  return (
    <div class="ring-legend small muted">
      <span>
        <i class="sw" /> 見えた
      </span>
      <span>
        <i class="sw inferred" /> 推定（見た後に動いた）
      </span>
      <span>
        <i class="sw unsure" /> 未確定（候補の手順で食い違う）
      </span>
      <span>矢印: 直前の手</span>
    </div>
  );
}
