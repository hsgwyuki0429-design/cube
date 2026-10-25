// ArUco ステッカーの代表色。マーカーの ID で色（ID÷9 = 面 U R F D L B）が決まるので、スキャンで測らずに固定の色を使う。
// 色は印刷した PDF の配色（白・赤・緑・黄・橙・青）。本体のメインのバンドルからも使うので、重い依存を持たない
import { type Lab, NAMED_COLORS } from "../vision/color";

export const ARUCO_NAMES = ["W", "R", "G", "Y", "O", "B"];
export const ARUCO_REFS: Lab[] = ARUCO_NAMES.map((id) => [...NAMED_COLORS.find((c) => c.id === id)!.lab] as Lab);
