// ArUco ステッカーの代表色。マーカーの ID で色（ID÷9 = 面 U R F D L B）が決まるので、スキャンで測らずに固定の色を使う。
// 色は印刷した PDF の配色（白・赤・緑・黄・橙・青）。本体のメインのバンドルからも使うので、重い依存を持たない
import { type Lab, NAMED_COLORS } from "../vision/color";

export const ARUCO_NAMES = ["W", "R", "G", "Y", "O", "B"];

// 12 種類（3×3）のステッカーを印刷する色（面 U R F D L B）。マーカーが読みやすいよう明るく薄めにした
// （黒いセルとの差が大きい。青・赤の濃い色は明るさが黒に近い）。白と黄・赤と橙は人が見分けられる程度に残す
export const PRINT_COLORS = ["#fafaf8", "#ff6e6e", "#78dc87", "#ffec6e", "#ffaa46", "#7dafff"];
export const ARUCO_REFS: Lab[] = ARUCO_NAMES.map((id) => [...NAMED_COLORS.find((c) => c.id === id)!.lab] as Lab);
