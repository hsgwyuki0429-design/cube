// 展開図（十字型）。スキャン結果の確認・修正に使う
import { B, D, F, L, R, U } from "../cube/model";

// 12 列 × 9 行のグリッドに各面 3x3 を置く（U は上、L F R B は横並び、D は下）
const POS: Record<number, [number, number]> = { [U]: [3, 0], [L]: [0, 3], [F]: [3, 3], [R]: [6, 3], [B]: [9, 3], [D]: [3, 6] };

export interface NetViewProps {
  state: ArrayLike<number> | null; // facelet → 色（面番号）。null なら未取得
  colors: string[]; // 色（面番号）→ CSS
  partial?: (string | null)[]; // スキャン途中: facelet ごとの CSS 色
  problemFacelets?: Set<number>;
  uncertainFacelets?: Set<number>; // 読みに自信がない・ピースの組み合わせから決めたマス
  onCell?: (facelet: number) => void;
}

export function NetView({ state, colors, partial, problemFacelets, uncertainFacelets, onCell }: NetViewProps) {
  const cells: preact.JSX.Element[] = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 12; col++) {
      const face = Object.entries(POS).find(([, [c, r]]) => col >= c && col < c + 3 && row >= r && row < r + 3);
      if (!face) {
        cells.push(<div class="gap" key={`${row}-${col}`} />);
        continue;
      }
      const f = Number(face[0]);
      const [c0, r0] = face[1];
      const facelet = f * 9 + (row - r0) * 3 + (col - c0);
      const color = partial ? (partial[facelet] ?? "transparent") : state ? colors[state[facelet]] : "transparent";
      const center = facelet % 9 === 4;
      cells.push(
        <button
          type="button"
          key={facelet}
          class={`cell${onCell && !center ? " editable" : ""}${problemFacelets?.has(facelet) ? " problem" : uncertainFacelets?.has(facelet) ? " uncertain" : ""}${center ? " center" : ""}`}
          style={{ background: color, borderStyle: color === "transparent" ? "dashed" : "solid" }}
          onClick={() => onCell?.(facelet)}
          aria-label={`facelet ${facelet}`}
        />,
      );
    }
  }
  return <div class="net">{cells}</div>;
}
