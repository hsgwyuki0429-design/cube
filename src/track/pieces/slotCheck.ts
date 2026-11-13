// 認識が面に付けたスロット（上・右・正面…）が、物理的にありえるかを確かめる（ライブの観測の掃除）。
// 実物の動画で、キューブを傾けたとき・層を回している途中に、面の中身は正しいのにスロットだけが 1 枚狂うフレームがあった
// （正面だった面が「下」に入り、別の面が正面になる: 正面・上・下が同時に見えたことになる）。ライブはそれを観測にして見失い、
// 実物のソルブで 5 秒以上ずれたままになっていた。スロットに頼らない手がかりで確かめる:
//   - 上と下・右と左が同時に見えることはない。センターが反対の面どうしの 2 面も同時には見えない
//   - センターの ID（= どの面か）と、面どうしが画像の上でどの辺で接しているか（外枠の辺が重なる）から置き方が 1 つに決まるときは、
//     スロットの割り当てがその置き方と合う姿勢があること（table.ts と同じ決め方）
// DOM もカメラも知らない
import { OPPOSITE, VIEW } from "../../cube/model";
import type { SightFrame } from "./frame";
import { CELL_TURN } from "./model";
import { isCenter, placeAll, touching } from "./table";

const TOUCH = 0.45;

export function slotsPlausible(sight: SightFrame): boolean {
  const slots = new Set(sight.faces.map((f) => f.slot));
  if ((slots.has(0) && slots.has(3)) || (slots.has(1) && slots.has(4))) return false;
  const fs = sight.faces.filter((f) => !f.held && f.quad?.length === 8 && f.ids.some((id, c) => id >= 0 && f.rot[c] >= 0));
  // センターが反対の面どうし
  const centers = fs.map((f) => (f.ids[4] >= 0 && f.rot[4] >= 0 && isCenter(f.ids[4]) ? Math.floor(f.ids[4] / 9) : -1));
  for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) if (centers[a] >= 0 && centers[b] >= 0 && (centers[a] === centers[b] || OPPOSITE[centers[a]] === centers[b])) return false;
  if (fs.length < 2) return true;
  const links: number[][] = [];
  for (let a = 0; a < fs.length; a++)
    for (let b = a + 1; b < fs.length; b++) {
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
  const root = centers.findIndex((c) => c >= 0);
  if (root < 0) return true;
  const valid = [0, 1, 2, 3].map((r) => placeAll(fs, links, root, centers[root], r)).filter((p) => p !== null);
  // 置き方がどれも成り立たない（接し方とセンターが食い違う）
  if (!valid.length) return false;
  // 置き方が 1 つに決まらなければ確かめない
  if (valid.length > 1) return true;
  const placed = valid[0]!;
  for (let o = 0; o < 24; o++) {
    let ok = true;
    for (let i = 0; i < fs.length && ok; i++) {
      const pl = placed[i];
      if (pl && (VIEW[o * 54 + fs[i].slot * 9 + 4] !== pl.face * 9 + 4 || VIEW[o * 54 + fs[i].slot * 9 + 1] !== pl.face * 9 + CELL_TURN[pl.r * 9 + 1])) ok = false;
    }
    if (ok) return true;
  }
  return false;
}
