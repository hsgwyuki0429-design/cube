import { useEffect, useRef } from "preact/hooks";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import type { DecodedMove } from "../track/types";
import { moveLabel } from "./notation";

export function MoveList({ moves, confirmed, offset = 0 }: { moves: DecodedMove[]; confirmed: number; offset?: number }) {
  const s = useStore(settingsStore, (x) => ({ notation: x.notation, viewpoint: x.viewpoint }));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [moves.length]);
  const shown = moves.slice(offset);
  if (!shown.length) return <div class="empty">まだ手はありません。キューブを回すとここに表示されます。</div>;
  return (
    <div class="moves" ref={box} aria-live="polite">
      {shown.map((m, i) => {
        const idx = i + offset;
        const cls = ["mv", idx >= confirmed ? "tentative" : "", m.inferred ? "inferred" : "", idx === moves.length - 1 ? "latest" : ""].join(" ");
        return (
          <span class={cls} key={idx} title={m.inferred ? "直接は見えず、後から推定した手" : idx >= confirmed ? "まだ確定していない手" : ""}>
            {moveLabel(m, s)}
          </span>
        );
      })}
    </div>
  );
}
