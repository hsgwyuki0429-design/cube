// 12 種類（3×3）の ArUco ステッカーの A4 印刷用 PDF を作る（docs/stickers/cubevision_aruco12_stickers.pdf）。
//   node scripts/aruco-stickers.mjs [出力先]
// 符号と色は src/aruco/codes.ts・src/aruco/palette.ts と同じ（tests/aruco.test.ts でこのスクリプトの値と照合する）。
// 1 ページ目 18mm・2 ページ目 15mm（どちらも 2 セット = 108 枚）、3 ページ目は黒地のテストページ（12 種類 × 12/15/18mm）。
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

export const CODES = [141, 237, 85, 39, 327, 115, 215, 187, 206, 58, 92, 31];
export const COLORS = ["#fafaf8", "#ff6e6e", "#78dc87", "#ffec6e", "#ffaa46", "#7dafff"];
const FACES = ["U", "R", "F", "D", "L", "B"];
const COLOR_NAMES = ["白", "赤", "緑", "黄", "橙", "青"];
const DARK = "#1a1a1a";
const MARGIN = 0.08; // ステッカーの辺に対する色の余白（アプリの合成画像と同じ）

// 1 枚のステッカー（左上 x,y、辺 s mm）
function sticker(id, x, y, s) {
  const k = 5;
  const m = s * MARGIN;
  const c = (s - 2 * m) / k;
  const code = CODES[id];
  let out = `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${COLORS[id % 6]}"/>`;
  let d = "";
  for (let r = 0; r < k; r++) {
    for (let col = 0; col < k; col++) {
      const inner = r >= 1 && r <= 3 && col >= 1 && col <= 3;
      const light = inner && (code >> ((r - 1) * 3 + col - 1)) & 1;
      if (!light) d += `M${(x + m + col * c).toFixed(3)} ${(y + m + r * c).toFixed(3)}h${c.toFixed(3)}v${c.toFixed(3)}h${(-c).toFixed(3)}z`;
    }
  }
  out += `<path d="${d}" fill="${DARK}"/>`;
  return out;
}

// 切り取り線（ステッカーの間の隙間の中央に細い灰色の線）
function cutGuides(x0, y0, n, m, s, gap) {
  let out = "";
  const w = m * s + (m - 1) * gap;
  const h = n * s + (n - 1) * gap;
  for (let i = 0; i <= n; i++) {
    const y = i === 0 ? y0 - gap / 2 : y0 + i * (s + gap) - gap / 2;
    out += `<line x1="${x0 - gap / 2 - 1.5}" y1="${y}" x2="${x0 + w + gap / 2 + 1.5}" y2="${y}"/>`;
  }
  for (let j = 0; j <= m; j++) {
    const x = j === 0 ? x0 - gap / 2 : x0 + j * (s + gap) - gap / 2;
    out += `<line x1="${x}" y1="${y0 - gap / 2 - 1.5}" x2="${x}" y2="${y0 + h + gap / 2 + 1.5}"/>`;
  }
  return `<g stroke="#bbb" stroke-width="0.1">${out}</g>`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const text = (x, y, str, size = 3.2, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${esc(str)}</text>`;

// 1 面ぶん（3×3、真ん中がセンター）のブロック
function faceBlock(face, x, y, s, gap) {
  let out = text(x, y - gap / 2 - 1.8, `${FACES[face]} 面（${COLOR_NAMES[face]}）`, 3);
  out += cutGuides(x, y, 3, 3, s, gap);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out += sticker(face + (r === 1 && c === 1 ? 6 : 0), x + c * (s + gap), y + r * (s + gap), s);
  return out;
}

// ステッカーのページ: 6 面 × sets セット
function stickerPage(s, sets) {
  const gap = 1.2;
  const block = 3 * s + 2 * gap;
  const colGap = 8;
  const cols = 3;
  const W = 210;
  const x0 = (W - (cols * block + (cols - 1) * colGap)) / 2;
  let out = text(x0, 14, `CubeVision ArUco ステッカー（12 種類・3×3）  ${s}mm × ${sets * 54} 枚（${sets} セット）`, 4.2, 'font-weight="bold"');
  out += text(x0, 20, "真ん中がセンター用（印が他と違います）。センター以外の 8 枚はどこに貼っても、どの向きでもかまいません。", 2.9);
  out += text(x0, 24.5, "揃った状態のキューブに、その面のセンターの色と同じ色のステッカーを貼ります（例: 白のセンターの面に白の 9 枚）。", 2.9);
  let y = 34;
  for (let set = 0; set < sets; set++) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cols; col++) out += faceBlock(row * 3 + col, x0 + col * (block + colGap), y, s, gap);
      y += block + 7;
    }
  }
  return out;
}

// テストページ: 黒地に 12 種類 × 3 つの大きさ（アプリの「ArUco」→ テストモードで写す）
function testPage() {
  const sizes = [12, 15, 18];
  let out = text(15, 14, "テストページ（12 種類 × 12 / 15 / 18mm）", 4.2, 'font-weight="bold"');
  out += text(15, 20, "アプリの「ArUco」画面 → 符号「12 種類（3×3）」・シート「テストページ（12 種類）」で、このページを撮って検出率を確かめます。", 2.9);
  out += text(15, 24.5, "黒い紙の上に置いたのと同じ条件（黒い台）にしてあります。どの大きさがよく読めるかで、貼る大きさを決めてください。", 2.9);
  const top = 32;
  const bg = { x: 12, y: top, w: 186 };
  let marks = "";
  let y = top + 8;
  for (const s of sizes) {
    marks += `<text x="${bg.x + 4}" y="${y - 2}" font-size="3" fill="#ddd">${s}mm</text>`;
    const gap = 3;
    const perRow = Math.floor((bg.w - 8 + gap) / (s + gap));
    const rowW = perRow * s + (perRow - 1) * gap;
    const x0 = bg.x + (bg.w - rowW) / 2;
    for (let i = 0; i < 12; i++) {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const x = x0 + c * (s + gap);
      const yy = y + r * (s + gap + 4);
      marks += sticker(i, x, yy, s);
      marks += `<text x="${x + s / 2}" y="${yy + s + 3}" font-size="2.4" fill="#aaa" text-anchor="middle">${FACES[i % 6]}${i >= 6 ? "中" : ""}</text>`;
    }
    y += Math.ceil(12 / perRow) * (s + gap + 4) + 8;
  }
  out += `<rect x="${bg.x}" y="${bg.y}" width="${bg.w}" height="${y - top - 4}" fill="#141414"/>${marks}`;
  const notes = [
    "印刷と貼り方",
    "・印刷は「実際のサイズ（100%）」で（「用紙に合わせる」にしない）。ステッカーの辺が 18mm / 15mm になっているか定規で確かめてください。",
    "・光沢のないステッカー用紙が向いています。光沢紙は照明が映り込むと、その間は読めません。",
    "・ステッカーは切り取り線の内側（色の縁を残す）で切ります。色の縁が、黒い枠をキューブの黒い部分と見分ける余白になります。",
    "・1 マスに収まる大きさに（56〜57mm のキューブは 1 マスが約 19mm。18mm でほぼいっぱい、15mm は余裕あり）。",
    "・揃った状態で、各面にセンターと同じ色の 9 枚を貼ります。真ん中のマスに「中」の印（センター用）、ほかの 8 枚は位置も向きも自由です。",
    "・アプリの 設定 → ステッカー を「ArUco マーカー（12 種類・3×3）」にします。揃った状態から始めればスキャンはいりません。",
  ];
  notes.forEach((n, i) => (out += text(15, y + 6 + i * 5.5, n, i === 0 ? 3.6 : 2.8, i === 0 ? 'font-weight="bold"' : "")));
  return out;
}

function page(content) {
  return `<section><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">${content}</svg></section>`;
}

export function html() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
html, body { margin: 0 }
section { width: 210mm; height: 297mm; page-break-after: always; overflow: hidden }
section:last-child { page-break-after: auto }
svg { display: block; font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", sans-serif; fill: #222 }
</style></head><body>${page(stickerPage(18, 2))}${page(stickerPage(15, 2))}${page(testPage())}</body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(process.argv[2] ?? "docs/stickers/cubevision_aruco12_stickers.pdf");
  mkdirSync(dirname(out), { recursive: true });
  const CHROME = process.env.CHROME_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch({ executablePath: CHROME });
  const p = await browser.newPage();
  await p.setContent(html());
  await p.pdf({ path: out, format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  console.log(out);
}
