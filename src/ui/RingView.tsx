// 円環図: 54 マスの対応（どのステッカーがどこにあるか）・確からしさ・直前の手での移動を描く（幾何は ring.ts）。
// 層ごとに側面の 12 枚が 1 つの円に並び、各ステッカーは 2 つの層の円の交わるところにある（jagarikin さんの図と同じ考え方）。
// 面を回すと、その層の円に沿ってステッカーが進む。U・R・F の角から見た向き（U・R・F が真ん中、B・L・D の層は外側の大きな円）
import { FACES } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
import { CERTAIN, type CellBelief } from "../track/engine";
import { FACE_CENTER, RING_CIRCLES, RING_POINTS, moveArrows, ringAngle, ringArc, ringDirection, startDirection, turnCircle } from "./ring";

export interface RingViewProps {
  state: ArrayLike<number>; // facelet → 色（面番号）
  colors: string[]; // 面番号 → CSS
  cells?: CellBelief | null; // マスごとの確からしさ（なければすべて確か）
  lastMove?: number | null; // 直前の手（キューブ固定の 0..17）
  showIds?: boolean; // そこにあるステッカーの番号（U0〜B8）を点に添える
  highlight?: Set<number>; // 太い枠で示すマス（いまのフレームで見えているマスなど）
  size?: number; // px
}

const NAME = (id: number) => (id < 0 ? "?" : `${FACES[Math.floor(id / 9)]}${id % 9}`);
const faceOf = (f: number) => Math.floor(f / 9);

export function RingView({ state, colors, cells, lastMove, showIds, highlight, size = 320 }: RingViewProps) {
  const R = size / 2 - 6;
  const c = size / 2;
  const at = (p: [number, number]): [number, number] => [c + p[0] * R, c + p[1] * R];
  const dotR = size / 44;
  const has = lastMove !== null && lastMove !== undefined;
  const ring = has ? turnCircle(Math.floor(lastMove / 3)) : null;
  // 直前の手: 層の円に沿って進む側面のステッカー（エッジ 4 枚で向きが分かる）と、回した面の中の回転
  const path = (pts: [number, number][], close = false) => pts.map((p, i) => `${i ? "L" : "M"} ${(c + p[0] * R).toFixed(1)} ${(c + p[1] * R).toFixed(1)}`).join(" ") + (close ? " Z" : "");
  const arcs = has
    ? moveArrows(lastMove)
        .filter(({ from, to }) => faceOf(from) !== faceOf(to) && from % 2 === 1)
        .map(({ from, to }) => ({ key: from, d: path(ringArc(ring!, ringAngle(ring!, from), ringAngle(ring!, to), ringDirection(lastMove))) }))
    : [];
  // 回した面の中: センターのまわりの曲がった矢印（向きはその面のエッジの動き出しから）
  let spin: string | null = null;
  if (has) {
    const face = Math.floor(lastMove / 3);
    const edge = moveArrows(lastMove).find(({ from, to }) => faceOf(from) === face && faceOf(to) === face && from % 2 === 1);
    if (edge) {
      const [cx, cy] = at(RING_POINTS[FACE_CENTER(face)]);
      const [ex, ey] = at(RING_POINTS[edge.from]);
      const [dx, dy] = startDirection(edge.from, lastMove);
      const cw = (ex - cx) * dy - (ey - cy) * dx > 0;
      const r = dotR * 2.1;
      const start = -Math.PI / 2;
      const end = start + (cw ? 1 : -1) * ((Math.PI * 5) / 3);
      const P = (t: number) => `${(cx + r * Math.cos(t)).toFixed(1)} ${(cy + r * Math.sin(t)).toFixed(1)}`;
      spin = `M ${P(start)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 1 ${cw ? 1 : 0} ${P(end)}`;
    }
  }
  return (
    <svg class="ring-view" viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="円環図（54 マスの対応）">
      <defs>
        <pattern id="ring-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(0,0,0,0.6)" stroke-width="1.6" />
        </pattern>
        <marker id="ring-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#111" />
        </marker>
        <clipPath id="ring-clip">
          <rect x="0" y="0" width={size} height={size} />
        </clipPath>
      </defs>
      {/* 9 本の層の円（直前に回した層は太く） */}
      <g clip-path="url(#ring-clip)" fill="none">
        {RING_CIRCLES.map((rc) => (
          <path key={`${rc.axis}${rc.layer}`} d={path(rc.points, true)} stroke={rc === ring ? "#444" : "#c8c8c8"} stroke-width={rc === ring ? 2 : 1} />
        ))}
      </g>
      {arcs.map((a) => (
        <path key={`a${a.key}`} d={a.d} fill="none" stroke="#111" stroke-width="1.8" opacity="0.8" marker-end="url(#ring-arrow)" />
      ))}
      {spin && <path d={spin} fill="none" stroke="#111" stroke-width="1.6" opacity="0.85" marker-end="url(#ring-arrow)" />}
      {RING_POINTS.map((p, f) => {
        const [x, y] = at(p);
        const unsure = cells ? cells.certainty[f] < CERTAIN : false;
        const inferred = cells ? cells.seenAt[f] < cells.movedAt[f] : false;
        const strong = highlight?.has(f);
        const center = f % 9 === 4;
        const r = center ? dotR * 1.25 : dotR;
        return (
          <g key={f} class={`ring-cell${unsure ? " unsure" : ""}${inferred ? " inferred" : ""}`}>
            <title>{`${FACES[faceOf(f)]}${f % 9}: ${NAME(stickerIdAt(state as number[], f))}`}</title>
            <circle cx={x} cy={y} r={r} fill={colors[state[f]] ?? "#888"} opacity={inferred && !unsure ? 0.65 : 1} stroke={strong ? "#111" : "#555"} stroke-width={strong ? 2.4 : 0.9} stroke-dasharray={inferred ? "2 2" : undefined} />
            {unsure && <circle cx={x} cy={y} r={r} fill="url(#ring-hatch)" pointer-events="none" />}
            {center && (
              <text x={x} y={y} class="ring-label center" text-anchor="middle" dominant-baseline="central" font-size={r * 1.2}>
                {FACES[faceOf(f)]}
              </text>
            )}
            {showIds && !center && (
              <text x={x} y={y + r + size / 70} class="ring-label" text-anchor="middle" dominant-baseline="central" font-size={size / 48}>
                {NAME(stickerIdAt(state as number[], f))}
              </text>
            )}
          </g>
        );
      })}
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
      <span>円 = 層（回すとその円に沿って進む）・矢印: 直前の手</span>
    </div>
  );
}
