/**
 * デバッグオーバーレイ。
 * CLAUDE.md「デバッグオーバーレイ（必須）」— これなしにチューニングは不可能。
 */

import { cellQuads, gridPoints, type RoiConfig } from '../vision/roi';
import { FACE_NAMES } from '../core/cube';
import type { Pt } from '../vision/homography';

export interface OverlayCellData {
  /** 生 sRGB 9セル×3 */
  rgb: Float32Array | null;
  /** 分類ラベル（-1 = 未分類） */
  labels: Int8Array | null;
  conf: Float32Array | null;
}

export interface TrackingOverlay {
  status: string;
  confidence: number;
  faces: { id: string; corners: { x: number; y: number }[]; visible: boolean; gridLock: number }[];
  points: { x: number; y: number; px: number; py: number; ok: boolean; inlier: boolean }[];
  showOutlines: boolean;
  showPoints: boolean;
  showFlow: boolean;
  /** 未初期化でタップ待ち */
  awaitingTap: boolean;
}

export interface OverlayState {
  rois: RoiConfig[];
  cells: (OverlayCellData | null)[];
  /** 6色の表示用 RGB（キャリブレーション結果） */
  palette: [number, number, number][] | null;
  confThreshold: number;
  /** true なら生RGBで塗る。false なら分類色で塗る */
  showRaw: boolean;
  showGrid: boolean;
  hoverCorner: { roi: number; corner: number } | null;
  candidates: { label: string; score: number }[];
  status: string;
  moveLog: string[];
  /** 姿勢追跡の可視化（Phase 0.5）。手動モードでは null */
  tracking: TrackingOverlay | null;
}

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = rect.width;
    this.h = rect.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 正規化座標 → キャンバス CSS px */
  private px(p: Pt): [number, number] {
    return [p.x * this.w, p.y * this.h];
  }

  draw(s: OverlayState): void {
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);

    for (let i = 0; i < s.rois.length; i++) {
      const roi = s.rois[i];
      if (!roi.enabled) continue;
      const data = s.cells[i] ?? null;
      this.drawRoi(roi, data, s, i);
    }
    if (s.tracking) this.drawTracking(s.tracking);
    this.drawHud(s);
  }

  private drawRoi(roi: RoiConfig, data: OverlayCellData | null, s: OverlayState, roiIdx: number): void {
    const g = this.ctx;
    let quads;
    let grid;
    try {
      quads = cellQuads(roi);
      grid = gridPoints(roi.corners, 3);
    } catch {
      return; // 退化した四角形
    }

    // セル塗り
    if (data) {
      for (let i = 0; i < 9; i++) {
        const q = quads[i];
        let fill: string | null = null;
        const l = data.labels ? data.labels[i] : -1;
        if (!s.showRaw && l >= 0 && s.palette) {
          const c = s.palette[l];
          fill = `rgb(${c[0]},${c[1]},${c[2]})`;
        } else if (data.rgb) {
          // 未キャリブレーションなら分類色は出せないので生RGBに落ちる
          fill = `rgb(${data.rgb[i * 3] | 0},${data.rgb[i * 3 + 1] | 0},${data.rgb[i * 3 + 2] | 0})`;
        }
        if (!fill) continue;
        g.beginPath();
        const [x0, y0] = this.px(q[0]);
        g.moveTo(x0, y0);
        for (let k = 1; k < 4; k++) {
          const [x, y] = this.px(q[k]);
          g.lineTo(x, y);
        }
        g.closePath();
        g.globalAlpha = 0.62;
        g.fillStyle = fill;
        g.fill();
        g.globalAlpha = 1;
        // 低信頼セルは赤枠
        if (data.conf && data.conf[i] < s.confThreshold) {
          g.strokeStyle = '#f33';
          g.lineWidth = 2.5;
          g.stroke();
        }
      }
    }

    // グリッド線
    if (s.showGrid) {
      g.strokeStyle = 'rgba(120,220,255,0.85)';
      g.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        g.beginPath();
        for (let j = 0; j <= 3; j++) {
          const [x, y] = this.px(grid[i][j]);
          j === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
        g.beginPath();
        for (let j = 0; j <= 3; j++) {
          const [x, y] = this.px(grid[j][i]);
          j === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
    }

    // 信頼度の数値
    if (data?.conf) {
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let i = 0; i < 9; i++) {
        const q = quads[i];
        const cx = ((q[0].x + q[2].x) / 2) * this.w;
        const cy = ((q[0].y + q[2].y) / 2) * this.h;
        const c = data.conf[i];
        g.fillStyle = c < s.confThreshold ? '#f66' : '#000';
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 2.5;
        const txt = c.toFixed(2).slice(1);
        g.strokeText(txt, cx, cy);
        g.fillText(txt, cx, cy);
      }
    }

    // 四隅ハンドルと面ラベル
    for (let k = 0; k < 4; k++) {
      const [x, y] = this.px(roi.corners[k]);
      const hot = s.hoverCorner && s.hoverCorner.roi === roiIdx && s.hoverCorner.corner === k;
      g.beginPath();
      g.arc(x, y, hot ? 11 : 8, 0, Math.PI * 2);
      g.fillStyle = hot ? 'rgba(255,200,0,0.85)' : 'rgba(80,200,255,0.55)';
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.stroke();
      g.fillStyle = '#000';
      g.font = 'bold 9px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(k), x, y);
    }
    const [lx, ly] = this.px(roi.corners[0]);
    g.font = 'bold 13px ui-monospace, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    const label = `${FACE_NAMES[roi.face]}  rot${roi.rotate}${roi.mirror ? ' M' : ''}`;
    g.strokeText(label, lx + 12, ly - 6);
    g.fillText(label, lx + 12, ly - 6);
  }

  /** 追跡の可視化。面の外枠・特徴点・フローベクトル。 */
  private drawTracking(t: TrackingOverlay): void {
    const g = this.ctx;

    if (t.showOutlines) {
      for (const f of t.faces) {
        if (f.corners.length < 4) continue;
        g.beginPath();
        f.corners.forEach((p, i) => {
          const [x, y] = this.px(p);
          i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        });
        g.closePath();
        // 見失っている面は赤破線。見えている面は緑実線
        g.setLineDash(f.visible ? [] : [6, 4]);
        g.strokeStyle = f.visible ? 'rgba(60,255,140,0.95)' : 'rgba(255,80,80,0.95)';
        g.lineWidth = 2.5;
        g.stroke();
        g.setLineDash([]);
        const [lx, ly] = this.px(f.corners[0]);
        g.font = 'bold 12px ui-monospace, monospace';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        const label = `${f.id} ${f.gridLock.toFixed(2)}`;
        g.strokeStyle = '#000';
        g.lineWidth = 3;
        g.strokeText(label, lx + 4, ly + 4);
        g.fillStyle = f.visible ? '#7fa' : '#f88';
        g.fillText(label, lx + 4, ly + 4);
      }
    }

    if (t.showFlow) {
      g.strokeStyle = 'rgba(255,220,80,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      for (const p of t.points) {
        if (!p.ok) continue;
        const [x0, y0] = this.px({ x: p.px, y: p.py });
        const [x1, y1] = this.px({ x: p.x, y: p.y });
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
      }
      g.stroke();
    }

    if (t.showPoints) {
      for (const p of t.points) {
        const [x, y] = this.px({ x: p.x, y: p.y });
        g.beginPath();
        g.arc(x, y, 2.5, 0, Math.PI * 2);
        // インライア=緑 / 追跡できたが外れ値=黄 / 追跡失敗=赤
        g.fillStyle = p.inlier ? 'rgba(80,255,120,0.9)'
          : p.ok ? 'rgba(255,220,60,0.9)' : 'rgba(255,70,70,0.9)';
        g.fill();
      }
    }

    if (t.awaitingTap) {
      g.font = 'bold 20px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const msg = 'キューブをタップ';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 5;
      g.strokeText(msg, this.w / 2, this.h / 2);
      g.fillStyle = '#fff';
      g.fillText(msg, this.w / 2, this.h / 2);
    }
  }

  private drawHud(s: OverlayState): void {
    const g = this.ctx;
    g.font = '11px ui-monospace, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    const lines: string[] = [`state: ${s.status}`];
    if (s.tracking) {
      lines.push(`pose : ${s.tracking.status} ${(s.tracking.confidence * 100).toFixed(0)}%`);
    }
    for (const c of s.candidates.slice(0, 5)) lines.push(`${c.label.padEnd(4)} ${c.score.toFixed(3)}`);
    if (s.moveLog.length) lines.push('', ...s.moveLog.slice(-6));
    const wBox = 150;
    const hBox = lines.length * 13 + 8;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(4, 4, wBox, hBox);
    g.fillStyle = '#cfc';
    lines.forEach((l, i) => {
      g.fillStyle = i === 0 ? '#9df' : i <= 5 ? '#cfc' : '#fc9';
      g.fillText(l, 9, 9 + i * 13);
    });
  }
}
