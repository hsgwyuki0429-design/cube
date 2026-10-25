// ステッカーの符号（ArUco マーカーの辞書）の種類。
//   aruco54: OpenCV の DICT_4X4_100 の ID 0〜53（ID = 揃った状態での facelet 番号）。最初に印刷した版
//   aruco12: 自作の 3×3 ビット（全体 5×5 マス）の 12 種類。ID 0〜5 = 面 U R F D L B のセンター以外、6〜11 = 各面のセンター。
//            マスが 4×4 より 2 割大きく、合成画像の比較で小さく写るほど読みやすかった（tests/debug/markers.debug.test.ts）。
//            9 ビットでは 12 種類に誤り訂正の距離を取れないので、距離 2 の組（4 組）はどれも見分けやすい色どうしにして、
//            読んだ ID の色と写った色を照らして誤読を捨てる（src/aruco/cube.ts）。同じ面のセンターとそれ以外は距離 3 以上
import { DICT_4X4_100, markerBits as bits4x4 } from "./dict4x4";

export type StickerScheme = "aruco54" | "aruco12";

export const SCHEME_LABEL: Record<StickerScheme, string> = {
  aruco12: "12 種類（3×3）",
  aruco54: "54 種類（4×4・最初に印刷した版）",
};

// ビット r*3+c（1 = 明るい = ステッカーの色）
export const ARUCO12_CODES = [141, 237, 85, 39, 327, 115, 215, 187, 206, 58, 92, 31];

export const markerSize = (s: StickerScheme) => (s === "aruco12" ? 3 : 4);
export const idCount = (s: StickerScheme) => (s === "aruco12" ? 12 : 54);

export interface Decoded {
  face: number; // ステッカーの色（センターの面 U R F D L B）
  center: boolean;
  sticker: number; // 揃った状態での facelet 番号（aruco54 のときだけ。aruco12 は -1）
}

export function decode(s: StickerScheme, id: number): Decoded | null {
  if (!Number.isInteger(id) || id < 0 || id >= idCount(s)) return null;
  if (s === "aruco12") return { face: id % 6, center: id >= 6, sticker: -1 };
  return { face: Math.floor(id / 9), center: id % 9 === 4, sticker: id };
}

// 揃った状態の facelet に貼るマーカーの ID
export const idForFacelet = (s: StickerScheme, facelet: number) => (s === "aruco12" ? Math.floor(facelet / 9) + (facelet % 9 === 4 ? 6 : 0) : facelet);

// 黒い枠を含む (n+2)×(n+2)（1 = 明るい、0 = 黒）
export function markerBits(s: StickerScheme, id: number): Uint8Array {
  if (s === "aruco54") return bits4x4(id);
  const code = ARUCO12_CODES[id];
  const out = new Uint8Array(25);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[(r + 1) * 5 + c + 1] = (code >> (r * 3 + c)) & 1;
  return out;
}

// 符号 → OpenCV の辞書のバイト列（Dictionary::getByteListFromBits と同じ並び: 4 つの回転を順に nbytes ずつ）。
// OpenCV.js では getByteListFromBits を JS から呼べなかったので組み立てる（tests/aruco.test.ts で DICT_4X4_100 と照合）
export function byteList(code: number, n: number): Uint8Array {
  const nbytes = Math.ceil((n * n) / 8);
  const out = new Uint8Array(4 * nbytes);
  const bit = (r: number, c: number) => (code >> (r * n + c)) & 1;
  let cur = 0;
  let cnt = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const vals = [bit(r, c), bit(c, n - 1 - r), bit(n - 1 - r, n - 1 - c), bit(n - 1 - c, r)];
      for (let k = 0; k < 4; k++) out[k * nbytes + cur] = ((out[k * nbytes + cur] << 1) | vals[k]) & 255;
      if (++cnt === 8) (cnt = 0), cur++;
    }
  }
  return out;
}

// DICT_4X4_100 の符号（dict4x4.ts の表は上位ビットが左上なので、r*4+c の並びに直す）
export function code4x4(id: number): number {
  const v = DICT_4X4_100[id];
  let code = 0;
  for (let i = 0; i < 16; i++) if ((v >> (15 - i)) & 1) code |= 1 << i;
  return code;
}

export function makeDictionary(cv: any, s: StickerScheme): any {
  if (s === "aruco54") return cv.getPredefinedDictionary(cv.DICT_4X4_100);
  const n = 3;
  const nbytes = Math.ceil((n * n) / 8);
  const bl = new cv.Mat(ARUCO12_CODES.length, nbytes, cv.CV_8UC4);
  ARUCO12_CODES.forEach((code, i) => bl.data.set(byteList(code, n), i * 4 * nbytes));
  const dict = new cv.aruco_Dictionary(bl, n, 0); // 誤り訂正なし（距離 2 しか取れない）
  bl.delete();
  return dict;
}
