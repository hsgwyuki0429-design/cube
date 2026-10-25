// ArUco ステッカーの A4 印刷用 PDF を作る（docs/stickers/）。
//   node scripts/aruco-stickers.mjs            # 2 つとも
//   node scripts/aruco-stickers.mjs unique54 [出力先]  /  aruco12 [出力先]
// 符号と色は src/aruco/codes.ts・src/aruco/palette.ts と同じ（tests/aruco.test.ts でこのスクリプトの値と照合する）。
// unique54（マスごとに違う 54 種類）: 1 ページ目 18mm・2 ページ目 15mm（どちらも 2 セット）、3 ページ目は貼り方。向きも決まっている
// aruco12（12 種類）: 1 ページ目 18mm・2 ページ目 15mm（どちらも 2 セット = 108 枚）、3 ページ目は黒地のテストページ（12 種類 × 12/15/18mm）。
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

export const CODES = [141, 237, 85, 39, 327, 115, 215, 187, 206, 58, 92, 31];
export const CODES_U54 = [
  [60, 106, 142, 187, 46, 57, 43, 105, 45],
  [126, 207, 237, 175, 222, 231, 215, 111, 125],
  [141, 27, 63, 71, 189, 113, 197, 92, 39],
  [335, 85, 383, 343, 245, 255, 221, 119, 95],
  [10, 18, 58, 5, 12, 3, 17, 33, 6],
  [159, 51, 15, 86, 101, 77, 123, 30, 99],
].flat();
export const COLORS = ["#fafaf8", "#ff6e6e", "#78dc87", "#ffec6e", "#ffaa46", "#7dafff"];
const FACES = ["U", "R", "F", "D", "L", "B"];
const COLOR_NAMES = ["白", "赤", "緑", "黄", "橙", "青"];
const DARK = "#1a1a1a";
const MARGIN = 0.08; // ステッカーの辺に対する色の余白（アプリの合成画像と同じ）

// 1 枚のステッカー（12 種類の ID、左上 x,y、辺 s mm）
const sticker = (id, x, y, s) => drawSticker(CODES[id], COLORS[id % 6], x, y, s);

// 符号 code（3×3 ビット、ビット r*3+c、1 = 明るい）・色 color のステッカー。マーカーの上辺 = ステッカーの上
function drawSticker(code, color, x, y, s) {
  const k = 5;
  const m = s * MARGIN;
  const c = (s - 2 * m) / k;
  let out = `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${color}"/>`;
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

// 切る位置の目印: ステッカーどうしは隙間なく並べ、境目の延長に、ブロックの外側だけ短い線を引く
// （ステッカーの上に線を引くと、切りずれたときに線が残る）
function cutMarks(x0, y0, n, s) {
  const w = n * s;
  const L = 2.5;
  const o = 0.8; // ブロックから離す
  let out = "";
  for (let i = 0; i <= n; i++) {
    const p = i * s;
    out += `<line x1="${x0 - o - L}" y1="${y0 + p}" x2="${x0 - o}" y2="${y0 + p}"/><line x1="${x0 + w + o}" y1="${y0 + p}" x2="${x0 + w + o + L}" y2="${y0 + p}"/>`;
    out += `<line x1="${x0 + p}" y1="${y0 - o - L}" x2="${x0 + p}" y2="${y0 - o}"/><line x1="${x0 + p}" y1="${y0 + w + o}" x2="${x0 + p}" y2="${y0 + w + o + L}"/>`;
  }
  return `<g stroke="#888" stroke-width="0.15">${out}</g>`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const text = (x, y, str, size = 3.2, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${esc(str)}</text>`;

// 1 面ぶん（3×3、真ん中がセンター）のブロック
function faceBlock(face, x, y, s) {
  let out = text(x, y - 4.2, `${FACES[face]} 面（${COLOR_NAMES[face]}）`, 3);
  out += cutMarks(x, y, 3, s);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out += sticker(face + (r === 1 && c === 1 ? 6 : 0), x + c * s, y + r * s, s);
  return out;
}

// ステッカーのページ: 6 面 × sets セット
function stickerPage(s, sets) {
  const block = 3 * s;
  const colGap = 10;
  const cols = 3;
  const W = 210;
  const x0 = (W - (cols * block + (cols - 1) * colGap)) / 2;
  let out = text(x0, 14, `CubeVision ArUco ステッカー（12 種類・3×3）  ${s}mm × ${sets * 54} 枚（${sets} セット）`, 4.2, 'font-weight="bold"');
  out += text(x0, 20, "真ん中がセンター用（印が他と違います）。センター以外の 8 枚はどこに貼っても、どの向きでもかまいません。", 2.9);
  out += text(x0, 24.5, "揃った状態のキューブに、その面のセンターの色と同じ色のステッカーを貼ります（例: 白のセンターの面に白の 9 枚）。", 2.9);
  let y = 37;
  for (let set = 0; set < sets; set++) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cols; col++) out += faceBlock(row * 3 + col, x0 + col * (block + colGap), y, s);
      y += block + 10;
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
    "・外側の目印を結んだ線（ステッカーの境目）で切ります。模様の外側の色の縁は切り落とさないでください（黒い枠を、キューブの黒い部分と見分けるのに必要）。",
    "・1 マスに収まる大きさに（56〜57mm のキューブは 1 マスが約 19mm。18mm でほぼいっぱい、15mm は余裕あり）。",
    "・揃った状態で、各面にセンターと同じ色の 9 枚を貼ります。真ん中のマスに「中」の印（センター用）、ほかの 8 枚は位置も向きも自由です。",
    "・アプリの 設定 → ステッカー を「ArUco マーカー（12 種類・3×3）」にします。揃った状態から始めればスキャンはいりません。",
  ];
  notes.forEach((n, i) => (out += text(15, y + 6 + i * 5.5, n, i === 0 ? 3.6 : 2.8, i === 0 ? 'font-weight="bold"' : "")));
  return out;
}

// ---- マスごとに違う 54 種類 ----
// 揃った状態で、ブロックの上辺を向ける面（U は B 側、D は F 側、側面は U 側。src/cube/model.ts の ROWDIR の逆）
const UP_SIDE = [5, 0, 0, 2, 0, 0];

function uniqueBlock(face, x, y, s) {
  let out = text(x, y - 4.2, `${FACES[face]} 面（${COLOR_NAMES[face]}）  ↑ ${COLOR_NAMES[UP_SIDE[face]]}の面の側`, 3);
  out += cutMarks(x, y, 3, s);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out += drawSticker(CODES_U54[face * 9 + r * 3 + c], COLORS[face], x + c * s, y + r * s, s);
  return out;
}

function uniquePage(s, sets) {
  const block = 3 * s;
  const colGap = 10;
  const cols = 3;
  const x0 = (210 - (cols * block + (cols - 1) * colGap)) / 2;
  let out = text(x0, 14, `CubeVision ArUco ステッカー（54 種類・3×3・マスごとに違う）  ${s}mm × ${sets} セット`, 4.2, 'font-weight="bold"');
  out += text(x0, 20, "1 枚ずつ貼る場所と向きが決まっています。ブロックの並びのまま、ブロックの上辺を「↑」の面の側に向けて貼ります（3 ページ目）。", 2.9);
  out += text(x0, 24.5, "切ると向きが分からなくなるので、1 段（3 枚）ずつ切り、左から順に、1 枚ずつ切り離しながら貼るのがおすすめです。", 2.9);
  let y = 37;
  for (let set = 0; set < sets; set++) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cols; col++) out += uniqueBlock(row * 3 + col, x0 + col * (block + colGap), y, s);
      y += block + 10;
    }
  }
  return out;
}

function uniqueGuide() {
  const lines = [
    ["貼り方（54 種類・マスごとに違う）", 4.2, true],
    ["", 2, false],
    ["1. キューブを揃えて、白を上・緑を手前にして持ちます。", 3, false],
    ["2. 側面（緑・赤・青・橙）: その面を正面から見て、ブロックの上の段をキューブの上（白）の側にし、", 3, false],
    ["   ブロックの並びのまま貼ります。", 3, false],
    ["3. 白の面: 緑を手前にしたまま上からのぞき、ブロックの上の段を奥（青）の側にして貼ります。", 3, false],
    ["4. 黄の面: キューブを奥へ 90° 倒して黄を手前に向け（緑が上になる）、ブロックの上の段を上（緑）の", 3, false],
    ["   側にして貼ります。", 3, false],
    ["5. 1 枚ずつ上の向きが決まっています。印刷したまま回さずに貼ってください。", 3, false],
    ["", 2, false],
    ["アプリの 設定 → ステッカー を「ArUco マーカー（54 種類・3×3・マスごとに違う）」にします。", 3, false],
    ["揃った状態から始めればスキャンはいりません。1 枚のマーカーの番号と向きから、その面の真ん中の位置が", 3, false],
    ["分かるので、センターや他のマスが指で隠れても面を組み立てられます。", 3, false],
    ["", 2, false],
    ["印刷は「実際のサイズ（100%）」で（「用紙に合わせる」にしない）。光沢のないステッカー用紙が向いています。", 3, false],
    ["外側の目印を結んだ線（ステッカーの境目）で切ります。模様の外側の色の縁は切り落とさないでください", 3, false],
    ["（黒い枠を、キューブの黒い部分と見分けるのに必要）。", 3, false],
    ["1 マスに収まる大きさに（56〜57mm のキューブは 1 マスが約 19mm。18mm でほぼいっぱい、15mm は余裕あり）。", 3, false],
  ];
  let out = "";
  lines.forEach(([t, size, bold], i) => (out += text(15, 20 + i * 6, t, size, bold ? 'font-weight="bold"' : "")));
  // 展開図: 揃った状態で、各ブロックの上辺がどちらを向くか（緑を手前に置いた展開図。U は上、D は下、L R B は横）
  const s = 9;
  const B = 3 * s;
  const ox = 40;
  const oy = 150;
  const at = { 0: [1, 0], 4: [0, 1], 2: [1, 1], 1: [2, 1], 5: [3, 1], 3: [1, 2] };
  for (const [f, [cx, cy]] of Object.entries(at)) {
    const x = ox + cx * (B + 5);
    const y = oy + cy * (B + 5);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out += drawSticker(CODES_U54[Number(f) * 9 + r * 3 + c], COLORS[Number(f)], x + c * s, y + r * s, s);
    out += text(x + B / 2, y - 1.2, `${FACES[Number(f)]}（${COLOR_NAMES[Number(f)]}）`, 2.6, 'text-anchor="middle"');
  }
  out += text(15, oy + 3 * (B + 5) + 6, "揃った状態の展開図（緑を手前に置いて開いたところ）。各ブロックはこの向きで貼ります。", 3, "");
  return out;
}

function page(content) {
  return `<section><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">${content}</svg></section>`;
}

export function html(scheme = "aruco12") {
  const pages = scheme === "unique54" ? [uniquePage(18, 2), uniquePage(15, 2), uniqueGuide()] : [stickerPage(18, 2), stickerPage(15, 2), testPage()];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
html, body { margin: 0 }
section { width: 210mm; height: 297mm; page-break-after: always; overflow: hidden }
section:last-child { page-break-after: auto }
svg { display: block; font-family: "Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", sans-serif; fill: #222 }
</style></head><body>${pages.map(page).join("")}</body></html>`;
}

export const OUT = { aruco12: "docs/stickers/cubevision_aruco12_stickers.pdf", unique54: "docs/stickers/cubevision_unique54_stickers.pdf" };

if (import.meta.url === `file://${process.argv[1]}`) {
  const schemes = process.argv[2] ? [process.argv[2]] : ["unique54", "aruco12"];
  const CHROME = process.env.CHROME_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch({ executablePath: CHROME });
  for (const scheme of schemes) {
    const out = resolve((schemes.length === 1 && process.argv[3]) || OUT[scheme]);
    mkdirSync(dirname(out), { recursive: true });
    const p = await browser.newPage();
    await p.setContent(html(scheme));
    await p.pdf({ path: out, format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    await p.close();
    console.log(out);
  }
  await browser.close();
}
