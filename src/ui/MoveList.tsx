import { useEffect, useRef } from "preact/hooks";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import { mergeQuickRepeats, simplifyMoves } from "../track/merge";
import type { DecodedMove } from "../track/types";
import { moveLabel } from "./notation";

export function MoveList({ moves, confirmed, offset = 0 }: { moves: DecodedMove[]; confirmed: number; offset?: number }) {
  const s = useStore(settingsStore, (x) => ({ notation: x.notation, viewpoint: x.viewpoint }));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [moves.length]);
  // 確定済みと未確定を別々にまとめる（R R → R2。打ち消し合う誤読の手 R2 R2・U' U は表示しない）
  const done = simplifyMoves(mergeQuickRepeats(moves.slice(offset, Math.max(offset, confirmed))));
  const pending = simplifyMoves(mergeQuickRepeats(moves.slice(Math.max(offset, confirmed))));
  const shown = [...done.map((m) => ({ m, tentative: false })), ...pending.map((m) => ({ m, tentative: true }))];
  if (!shown.length) return <div class="empty">まだ手はありません。キューブを回すとここに表示されます。</div>;
  return (
    <div class="moves" ref={box} aria-live="polite">
      {shown.map(({ m, tentative }, i) => {
        const cls = ["mv", tentative ? "tentative" : "", m.inferred ? "inferred" : "", i === shown.length - 1 ? "latest" : ""].join(" ");
        return (
          <span class={cls} key={i} title={m.inferred ? "直接は見えず、後から推定した手" : tentative ? "まだ確定していない手" : ""}>
            {moveLabel(m, s)}
          </span>
        );
      })}
    </div>
  );
}
