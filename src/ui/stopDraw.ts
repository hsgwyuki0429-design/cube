// 止めた後の画面（src/ui/StoppedScreen.tsx）の canvas の絵: 2D の等角のキューブ（録画を読む段の読めたマス・止めたときのキューブ・結果カード）と、
// 解き直しの「探索の枝」。描くだけで、状態は持たない。1 回の描画の時間を数える（drawStats。E2E が読む）
import { COLDIR, NORMAL, ROWDIR } from "../cube/model";

// 描いた回数・時間（ms）の合計・最大
export const drawStats = { n: 0, total: 0, max: 0 };
function timed(f: () => void): void {
  const t0 = performance.now();
  f();
  const ms = performance.now() - t0;
  drawStats.n++;
  drawStats.total += ms;
  if (ms > drawStats.max) drawStats.max = ms;
}

// canvas の大きさを表示の大きさ × 画素の比に合わせ、表示の座標で描けるようにする
export function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// ---- 2D の等角のキューブ ----

const C30 = Math.cos(Math.PI / 6);
// カメラの座標（+x 右・+y 上・+z カメラ側）→ 画面（単位はマス 1 つ）
const iso = (p: readonly number[]): [number, number] => [(p[0] - p[2]) * C30, -p[1] + (p[0] + p[2]) * 0.5];

// 左と下の面は鏡に映して見せる: 左の面は右の面の形で左へ、下の面は上の面の形で下へずらす（マスの位置は、鏡に映したときの位置）
const MIRROR_L = -6.2; // 左の面の画面の横のずらし
const MIRROR_D = 6.9; // 下の面の画面の縦のずらし
const BOX = { x0: -6.4, x1: 4.6, y0: -3.2, y1: 7.1 }; // 鏡も入れた絵の範囲（マスの単位）
const BOX_CUBE = { x0: -2.8, x1: 2.8, y0: -3.2, y1: 3.2 }; // キューブだけ

// カメラの面 slot（0 上 / 1 右 / 2 正面 / 3 下 / 4 左）のマス cell の 4 隅（画面の単位）
function cellQuad(slot: number, cell: number): [number, number][] {
  const row = Math.floor(cell / 3);
  const col = cell % 3;
  const n = NORMAL[slot];
  const rd = ROWDIR[slot];
  const cd = COLDIR[slot];
  const g = 0.44;
  const corners: [number, number][] = [];
  for (const [a, b] of [
    [-g, -g],
    [-g, g],
    [g, g],
    [g, -g],
  ]) {
    const p = [0, 1, 2].map((k) => n[k] * 1.5 + rd[k] * (row - 1 + a) + cd[k] * (col - 1 + b));
    if (slot === 4) {
      // 左の面を鏡に映す: x = -1.5 の面を x = +1.5 に（y・z はそのまま）、絵は左へ
      const [x, y] = iso([1.5, p[1], p[2]]);
      corners.push([x + MIRROR_L, y]);
    } else if (slot === 3) {
      // 下の面を鏡に映す: y = -1.5 の面を y = +1.5 に（x・z はそのまま）、絵は下へ
      const [x, y] = iso([p[0], 1.5, p[2]]);
      corners.push([x, y + MIRROR_D]);
    } else corners.push(iso(p));
  }
  return corners;
}

// 面の外枠（マスの下地）
function faceQuad(slot: number): [number, number][] {
  const q0 = cellQuad(slot, 0);
  const q2 = cellQuad(slot, 2);
  const q6 = cellQuad(slot, 6);
  const q8 = cellQuad(slot, 8);
  return [q0[0], q2[1], q8[2], q6[3]];
}

export interface IsoOptions {
  colors: (string | null)[]; // 45 = 面 5 × 9 マス。null = 読めていない（黒）
  mirrors: boolean; // 左と下の面を鏡に映して見せる
  dim?: number; // 薄く（0..1、1 = そのまま）
  labels?: { left: string; down: string };
}

export function drawIsoCube(canvas: HTMLCanvasElement, o: IsoOptions): void {
  timed(() => {
    const f = fit(canvas);
    if (!f) return;
    const { ctx, w, h } = f;
    const box = o.mirrors ? BOX : BOX_CUBE;
    const s = Math.min(w / (box.x1 - box.x0), h / (box.y1 - box.y0));
    const ox = (w - (box.x1 - box.x0) * s) / 2 - box.x0 * s;
    const oy = (h - (box.y1 - box.y0) * s) / 2 - box.y0 * s;
    const P = ([x, y]: [number, number]): [number, number] => [ox + x * s, oy + y * s];
    const poly = (q: [number, number][]) => {
      ctx.beginPath();
      q.forEach((p, i) => {
        const [x, y] = P(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    ctx.globalAlpha = o.dim ?? 1;
    const slots = o.mirrors ? [0, 1, 2, 3, 4] : [0, 1, 2];
    ctx.lineJoin = "round";
    for (const slot of slots) {
      poly(faceQuad(slot));
      ctx.fillStyle = "#050506";
      ctx.fill();
      for (let c = 0; c < 9; c++) {
        poly(cellQuad(slot, c));
        const col = o.colors[slot * 9 + c];
        ctx.fillStyle = col ?? "#121215";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = col ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.13)";
        ctx.stroke();
      }
    }
    if (o.mirrors) {
      // 鏡の線（点線）と札
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      const [lx] = P([(MIRROR_L + 2.6 - 2.6) / 2, 0]); // 左の面の右端（-3.6）とキューブの左端（-2.6）の間
      ctx.beginPath();
      ctx.moveTo(lx, P([0, -3])[1]);
      ctx.lineTo(lx, P([0, 3.2])[1]);
      ctx.stroke();
      const [, dy] = P([0, 3.45]);
      ctx.beginPath();
      ctx.moveTo(P([-2.6, 0])[0], dy);
      ctx.lineTo(P([2.6, 0])[0], dy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (o.labels) {
        ctx.fillStyle = "rgba(235,235,245,0.62)";
        ctx.font = `${Math.max(10, Math.round(s * 0.36))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const [x, y] = P([MIRROR_L + 1.3, 3.3]);
        ctx.fillText(o.labels.left, x, y);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const [x2, y2] = P([2.9, MIRROR_D - 0.2]);
        ctx.fillText(o.labels.down, x2, y2);
      }
    }
    ctx.globalAlpha = 1;
  });
}

// ---- 探索の枝 ----

export interface BranchSide {
  x: number | null; // 読みと合っている所まで進んだ位置（0..1。null = まだ）
  alive: number; // 伸びている枝の数（有力な仮説の数の対数くらい）
  dead: number; // 消えた枝の数（落とした仮説の数の対数くらい）
}

export interface BranchOptions {
  fwd: BranchSide;
  bwd: BranchSide;
  meet: number | null; // つないだ位置（0..1）
  color: string;
  label: string; // 真ん中の札（ここをつなぐ・つながった）
}

// 決まった乱数（同じ枝が毎回同じ形に描かれる）
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function drawBranches(canvas: HTMLCanvasElement, o: BranchOptions): void {
  timed(() => {
    const f = fit(canvas);
    if (!f) return;
    const { ctx, w, h } = f;
    const pad = 10;
    const mid = h * 0.45;
    const X = (u: number) => pad + u * (w - pad * 2);
    const spread = h * 0.32;
    ctx.lineCap = "round";
    // 時間の軸
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(0), h - 6);
    ctx.lineTo(X(1), h - 6);
    ctx.stroke();
    const side = (s: BranchSide, dir: 1 | -1, seed: number) => {
      const x0 = dir === 1 ? X(0) : X(1);
      if (s.x === null) return;
      const reach = X(s.x);
      const len = reach - x0;
      // 消えた枝: 根元からの途中で分かれて、少し伸びて止まる
      for (let i = 0; i < s.dead; i++) {
        const u = 0.08 + 0.84 * rand(seed + i * 7.1);
        const bx = x0 + len * u;
        const ex = bx + dir * Math.max(10, Math.abs(len) * (0.08 + 0.12 * rand(seed + i * 3.3)));
        const ey = mid + (rand(seed + i * 5.7) < 0.5 ? -1 : 1) * spread * (0.35 + 0.65 * rand(seed + i * 9.1));
        ctx.strokeStyle = "rgba(235,235,245,0.22)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(bx, mid);
        ctx.bezierCurveTo(bx + dir * 6, mid, ex - dir * 8, ey, ex, ey);
        ctx.stroke();
        ctx.fillStyle = "rgba(235,235,245,0.3)";
        ctx.beginPath();
        ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      // 伸びている枝: 根元から今の所まで
      const n = Math.max(1, s.alive);
      for (let i = 0; i < n; i++) {
        const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * 0.9;
        const split = x0 + len * (0.25 + 0.4 * rand(seed + 100 + i));
        ctx.strokeStyle = o.color;
        ctx.globalAlpha = i === Math.floor((n - 1) / 2) ? 1 : 0.6;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, mid);
        ctx.lineTo(split, mid);
        ctx.bezierCurveTo(split + len * 0.15, mid, reach - len * 0.2, mid + off, reach, mid + off);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(reach, mid + off, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x0, mid, 4.5, 0, Math.PI * 2);
      ctx.fill();
    };
    side(o.fwd, 1, 1);
    side(o.bwd, -1, 50);
    // つなぐ所: 前向きの先と後ろ向きの先の間（重なっていれば重なり）。つないだら縦の線
    const a = o.fwd.x;
    const b = o.bwd.x;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    if (o.meet !== null) {
      const mx = X(o.meet);
      ctx.strokeStyle = "#34c759";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(mx, mid - spread);
      ctx.lineTo(mx, mid + spread);
      ctx.stroke();
      ctx.fillStyle = "#34c759";
      ctx.fillText(o.label, Math.min(w - 40, Math.max(40, mx)), mid + spread + 6);
    } else if (a !== null && b !== null) {
      const lo = X(Math.min(a, b));
      const hi = X(Math.max(a, b));
      const bw = Math.max(26, hi - lo);
      const bx = (lo + hi) / 2 - bw / 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, mid - spread * 0.75, bw, spread * 1.5);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(235,235,245,0.7)";
      ctx.fillText(o.label, Math.min(w - 40, Math.max(40, bx + bw / 2)), mid + spread * 0.75 + 6);
    }
  });
}
