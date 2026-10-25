// 色付き ArUco ステッカーの仕様（印刷済み PDF: cubevision_aruco_stickers.pdf）。
// ID = 面番号×9 + 位置 = このリポジトリの facelet 番号（src/cube/model.ts）。ID÷9 がそのまま色（センターの面）。
// 位置は面を正面から見て左上→右下。マーカー画像の上辺がその面の「上」（U は B 側、D は F 側、側面は U 側）。

export type ColorKey = "white" | "red" | "green" | "yellow" | "orange" | "blue";

// 面番号の順（U R F D L B）の色
export const FACE_COLORS: ColorKey[] = ["white", "red", "green", "yellow", "orange", "blue"];
export const FACE_NAMES = ["U", "R", "F", "D", "L", "B"];
export const COLOR_LABEL: Record<ColorKey, string> = { white: "白", red: "赤", green: "緑", yellow: "黄", orange: "橙", blue: "青" };
export const COLOR_ORDER: ColorKey[] = ["white", "red", "green", "yellow", "orange", "blue"];

export const STICKER_IDS = 54;

export function stickerOf(id: number): { face: number; pos: number; color: ColorKey } | null {
  if (!Number.isInteger(id) || id < 0 || id >= STICKER_IDS) return null;
  const face = Math.floor(id / 9);
  return { face, pos: id % 9, color: FACE_COLORS[face] };
}

// マーカーの表示名。54 種類（unique54・aruco54）は U0〜B8、12 種類は面の文字（センターは「U中」）
export function markerLabel(scheme: "aruco54" | "aruco12" | "unique54", id: number): string {
  if (scheme !== "aruco12") return stickerName(id);
  if (id < 0 || id >= 12) return `#${id}`;
  return `${FACE_NAMES[id % 6]}${id >= 6 ? "中" : ""}`;
}

export function stickerName(id: number): string {
  const s = stickerOf(id);
  return s ? `${FACE_NAMES[s.face]}${s.pos}` : `#${id}`;
}

// 写すシート。同じ ID が複数の大きさで載っているときは、写った大きさの比で区別する（stats.ts）
export interface SheetSpec {
  key: string;
  label: string;
  ids: number[];
  sizes: number[]; // ステッカーの辺の長さ（mm）
  scheme: "aruco54" | "aruco12" | "unique54"; // 符号の種類（src/aruco/codes.ts）
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const SHEETS: SheetSpec[] = [
  // マスごとに違う 54 種類（3×3）: 印刷用 PDF の 1・2 ページ目（18mm・15mm が 1 セットずつ）
  { key: "u18", label: "ステッカー 18mm（54 種類・3×3）", ids: range(STICKER_IDS), sizes: [18], scheme: "unique54" },
  { key: "u15", label: "ステッカー 15mm（54 種類・3×3）", ids: range(STICKER_IDS), sizes: [15], scheme: "unique54" },
  // 12 種類（3×3）: 同じ ID のステッカーが何枚もあるので、ID と大きさが 1 枚ずつのテストページだけ
  { key: "t12", label: "テストページ（12 種類 × 12/15/18mm）", ids: range(12), sizes: [12, 15, 18], scheme: "aruco12" },
  { key: "test", label: "テストページ（ID 90〜92 × 12/15/18mm）", ids: [90, 91, 92], sizes: [12, 15, 18], scheme: "aruco54" },
  { key: "s18", label: "ステッカー 18mm 版（ID 0〜53）", ids: range(STICKER_IDS), sizes: [18], scheme: "aruco54" },
  { key: "s15", label: "ステッカー 15mm 版（ID 0〜53）", ids: range(STICKER_IDS), sizes: [15], scheme: "aruco54" },
  { key: "s1518", label: "ステッカー 15mm と 18mm が同じ画面（ID 0〜53）", ids: range(STICKER_IDS), sizes: [15, 18], scheme: "aruco54" },
];

// 写った色（マーカーの明るいセルの平均 RGB）を 6 色のどれかに分ける。
// ID 0〜53 は仕様の色を使うので、これはテストページ（ID と色の対応を決めつけない）と表示のため
export function classifyColor(rgb: [number, number, number]): ColorKey {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const s = max > 0 ? (max - min) / max : 0;
  if (s < 0.25) return "white";
  let h = 0;
  const d = max - min;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 14 || h >= 300) return "red";
  if (h < 38) return "orange";
  if (h < 75) return "yellow";
  if (h < 170) return "green";
  return "blue";
}
