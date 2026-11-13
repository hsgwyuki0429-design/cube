// 記録を縦長の画像（1080×1920、SNS の縦動画・ストーリーの大きさ）にして共有する。
// 共有できる端末（スマホの共有シート）ではそのまま渡し、できなければ画像を保存する
import { controller } from "../app/controller";
import { type Solve, effectiveTime, formatTime } from "../app/storage";
import { bestGain } from "./solveUi";

const W = 1080;
const H = 1920;
const FONT = `-apple-system, "SF Pro Display", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
const ACCENT = "#ffd60a";

// 少し上と右から見た揃ったキューブ（上 白・前 緑・右 赤）
function drawCube(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const a = (s * Math.sqrt(3)) / 2;
  const top = { o: [cx, cy - s], u: [a, s / 2], v: [-a, s / 2], color: "#f5f5f7" };
  const left = { o: [cx - a, cy - s / 2], u: [a, s / 2], v: [0, s], color: "#1fb35f" };
  const right = { o: [cx, cy], u: [a, -s / 2], v: [0, s], color: "#e8323e" };
  ctx.fillStyle = "#050505";
  ctx.beginPath();
  ctx.moveTo(cx, cy - s - 10);
  ctx.lineTo(cx + a + 9, cy - s / 2 - 5);
  ctx.lineTo(cx + a + 9, cy + s / 2 + 5);
  ctx.lineTo(cx, cy + s + 10);
  ctx.lineTo(cx - a - 9, cy + s / 2 + 5);
  ctx.lineTo(cx - a - 9, cy - s / 2 - 5);
  ctx.closePath();
  ctx.fill();
  for (const f of [top, left, right]) {
    ctx.fillStyle = f.color;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const g = 0.06;
        const pt = (p: number, q: number) => [f.o[0] + f.u[0] * p + f.v[0] * q, f.o[1] + f.u[1] * p + f.v[1] * q];
        const p0 = (i + g) / 3;
        const p1 = (i + 1 - g) / 3;
        const q0 = (j + g) / 3;
        const q1 = (j + 1 - g) / 3;
        ctx.beginPath();
        for (const [p, q] of [
          [p0, q0],
          [p1, q0],
          [p1, q1],
          [p0, q1],
        ]) {
          const [x, y] = pt(p, q);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      }
  }
}

// 手順を幅に収まるように行に分ける
function wrapWords(ctx: CanvasRenderingContext2D, words: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function drawShareCard(canvas: HTMLCanvasElement, solve: Solve, solves: Solve[]): void {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 44px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("CubeVision", 90, 150);
  ctx.fillStyle = "rgba(235,235,245,0.6)";
  ctx.font = `400 34px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(new Date(solve.date).toLocaleDateString(), W - 90, 150);

  drawCube(ctx, W / 2, 520, 190);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = `200 300px ${FONT}`;
  ctx.fillText(formatTime(effectiveTime(solve)) + (solve.penalty === "+2" ? "+" : ""), W / 2, 1060);

  const gain = bestGain(solves, solve);
  let y = 1150;
  if (gain !== null) {
    const text = `自己ベスト −${(gain / 1000).toFixed(2)}`;
    ctx.font = `700 40px ${FONT}`;
    const w = ctx.measureText(text).width + 70;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.roundRect(W / 2 - w / 2, y - 48, w, 72, 36);
    ctx.fill();
    ctx.fillStyle = "#000000";
    ctx.fillText(text, W / 2, y);
    y += 90;
  }
  ctx.fillStyle = "rgba(235,235,245,0.75)";
  ctx.font = `500 42px ${FONT}`;
  ctx.fillText(`${solve.moves.length} 手・${solve.tps.toFixed(2)} TPS`, W / 2, y);

  ctx.textAlign = "left";
  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = "rgba(235,235,245,0.5)";
  ctx.fillText("スクランブル", 90, 1400);
  ctx.font = `500 36px ${FONT}`;
  ctx.fillStyle = "#ffffff";
  let ly = 1452;
  for (const l of wrapWords(ctx, solve.scramble.split(/\s+/).filter(Boolean), W - 180).slice(0, 2)) {
    ctx.fillText(l, 90, ly);
    ly += 50;
  }
  if (solve.moves.length) {
    ly += 30;
    ctx.font = `600 30px ${FONT}`;
    ctx.fillStyle = "rgba(235,235,245,0.5)";
    ctx.fillText("解いた手順（カメラで読み取り）", 90, ly);
    ly += 52;
    ctx.font = `500 32px ${FONT}`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const lines = wrapWords(
      ctx,
      solve.moves.map((m) => m.m),
      W - 180,
    );
    for (const l of lines.slice(0, 4)) {
      ctx.fillText(l + (l === lines[3] && lines.length > 4 ? " …" : ""), 90, ly);
      ly += 46;
    }
  }
}

export async function shareSolve(solve: Solve, solves: Solve[]): Promise<void> {
  const canvas = document.createElement("canvas");
  drawShareCard(canvas, solve, solves);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
  if (!blob) {
    controller.toast("画像を作れませんでした");
    return;
  }
  const name = `cubevision-${formatTime(effectiveTime(solve)).replace(/[^0-9.:]/g, "")}.png`;
  const file = new File([blob], name, { type: "image/png" });
  const text = `${formatTime(effectiveTime(solve))}（${solve.moves.length} 手・${solve.tps.toFixed(2)} TPS）#CubeVision`;
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text });
      return;
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // 共有シートを閉じた
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  controller.toast("画像を保存しました");
}
