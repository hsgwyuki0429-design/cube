// 精密解析の終わりを、ライブが揃ったと判断して止めた時刻で打ち切る（DOM もカメラも知らない。tests/stopCut.test.ts）。
// WCA で競技者がタイマーを止めた時点でタイムが決まるのと同じ考え方: 止めた後に回した手（揃えた後に上の層を往復させた U・U' など）は
// 手順・手数・TPS・CFOP の区切りに数えない。精密解析には止めた後 1.1 秒の録画まで渡し、終わりを完成の状態として解くので、そのままだと
// 外して戻した往復まで含めて 2 回目の揃いで終わる（IMG_5049: 44.93 秒に揃い、45.20 秒に上の層を回して外し、45.53 秒からまた揃う。
// 記録のタイムが画面のタイムより 0.65 秒長かった）。
//
// 打ち切る所: 精密解析の手順（まとめる前）の途中で状態が揃いになる所のうち、止めた時刻より前で最後のもの。ただし
//   - その所の手の回し終わりが、止めた時刻の STOP_BEFORE_MS 前〜STOP_AFTER_MS 後にあること（止めた時点の前後で精密解析が揃いを
//     見つけた。見つからなければ打ち切らない: ライブの誤判定に引きずられない）
//   - 外す次の手の回し終わりが止めた時刻より後であること（止めた時刻にはまだ揃っていた）
// 終わりの揃いが止めた時刻の近くにあれば（ふつうのソルブ）、何もしない
import { type CubeState, applyMove, isSolved } from "../cube/model";

// 揃った所（その手の回し終わり）が、止めた時刻よりこれだけ後まで。止めた時刻はライブが揃いを見始めたフレームなので、本当の回し終わりは
// その少し前のはず。精密解析の回し終わりは画素で詰めた時刻で、ほぼ回し終えた層をライブが揃いと読むこともあるので少し余裕を見る
export const STOP_AFTER_MS = 250;
// 揃った所が、止めた時刻よりこれだけ前まで（ライブが揃いを見るのが遅れた: 1 面しか見えていなかった・指で隠れていた）。それより前の
// 揃いは、止めた時点の揃いとはみなさない
export const STOP_BEFORE_MS = 1500;

// ライブが揃ったと判断して止めた: at = 揃いが見え始めたフレーム（Solve.edges.stop の hold の始まり。追跡で止めたらその観測）、
// until = 止めると決めたフレーム（at〜until のフレームは揃って見えていた）
export interface LiveStop {
  at: number;
  until: number;
}

export interface StopCut {
  keep: number; // 残す手の数（moves の先頭からこれだけ）
  end: number; // 残した最後の手の回し終わり（ms）
}

// moves: 精密解析の手順（まとめる前、時刻の順）。timeOf: i 番目の手の回し始め・回し終わり。打ち切らないときは null
export function stopCut(start: CubeState, moves: readonly { move: number }[], stopAt: number, timeOf: (i: number) => { start: number; end: number }): StopCut | null {
  let s = start;
  let best: StopCut | null = null;
  for (let i = 0; i < moves.length - 1; i++) {
    s = applyMove(s, moves[i].move);
    if (!isSolved(s)) continue;
    const end = timeOf(i).end;
    if (end > stopAt + STOP_AFTER_MS || end < stopAt - STOP_BEFORE_MS) continue; // 止めた後の揃い・止めた時点より前すぎる揃い
    if (timeOf(i + 1).end <= stopAt) continue; // 次の手も止める前に回し終えている: 止めたのはもっと後の揃い
    best = { keep: i + 1, end };
  }
  // 終わり（全部の手の後）が止めた時刻の近くで揃っていれば、それが止めた所
  if (best && moves.length) {
    const last = timeOf(moves.length - 1).end;
    if (last <= stopAt + STOP_AFTER_MS) return null;
  }
  return best;
}
