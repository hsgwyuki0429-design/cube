import { MOVE_NAMES, relativeMove, rotateOrientation } from "../cube/model";
import { controller } from "../app/controller";
import type { Settings } from "../app/settings";
import type { DecodedMove } from "../track/types";

// 表示用の向き: 「自分視点」ならカメラの反対側から見た向き（y2）。
// デモの合成カメラは自分の方を向いていないので、映像と同じカメラ視点にする
export const viewOrient = (o: number, s: Pick<Settings, "viewpoint">) => (s.viewpoint === "user" && !controller.store.get().demo ? rotateOrientation(o, "y", 2) : o);

export function moveLabel(m: DecodedMove, s: Pick<Settings, "viewpoint" | "notation">): string {
  return s.notation === "relative" ? MOVE_NAMES[relativeMove(m.move, viewOrient(m.orient, s))] : MOVE_NAMES[m.move];
}

export const SLOT_LABEL = ["上", "右", "正面", "下", "左", "背面"];
