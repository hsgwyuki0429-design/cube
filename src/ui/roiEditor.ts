/** ROI の四隅ドラッグ。ポインタ座標は正規化 (0..1) で扱う。 */

import type { RoiConfig } from '../vision/roi';

export interface RoiEditorHandle {
  hover: { roi: number; corner: number } | null;
  destroy(): void;
}

const HIT_PX = 26;

export interface RoiEditorOptions {
  /** false のときは四隅ドラッグを無効にする（追跡モードでは座標を追跡側が供給する） */
  dragEnabled?: () => boolean;
  /** ドラッグでなく単なるタップだったときに呼ばれる（正規化座標） */
  onTap?: (nx: number, ny: number) => void;
}

export function attachRoiEditor(
  canvas: HTMLCanvasElement,
  getRois: () => RoiConfig[],
  onChange: (final: boolean) => void,
  opts: RoiEditorOptions = {},
): RoiEditorHandle {
  let dragging: { roi: number; corner: number } | null = null;
  let downAt: { x: number; y: number; t: number } | null = null;
  const handle: RoiEditorHandle = { hover: null, destroy };

  const toNorm = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, rect: r };
  };

  function pick(nx: number, ny: number, rect: DOMRect): { roi: number; corner: number } | null {
    const rois = getRois();
    let best: { roi: number; corner: number } | null = null;
    let bestD = Infinity;
    for (let i = 0; i < rois.length; i++) {
      if (!rois[i].enabled) continue;
      for (let k = 0; k < 4; k++) {
        const c = rois[i].corners[k];
        const dx = (c.x - nx) * rect.width;
        const dy = (c.y - ny) * rect.height;
        const d = Math.hypot(dx, dy);
        if (d < HIT_PX && d < bestD) {
          bestD = d;
          best = { roi: i, corner: k };
        }
      }
    }
    return best;
  }

  const onDown = (e: PointerEvent) => {
    const { x, y, rect } = toNorm(e);
    downAt = { x, y, t: performance.now() };
    if (opts.dragEnabled && !opts.dragEnabled()) return;
    const hit = pick(x, y, rect);
    if (!hit) return;
    dragging = hit;
    handle.hover = hit;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent) => {
    const { x, y, rect } = toNorm(e);
    if (!dragging) {
      handle.hover = (opts.dragEnabled && !opts.dragEnabled()) ? null : pick(x, y, rect);
      return;
    }
    const c = getRois()[dragging.roi].corners[dragging.corner];
    c.x = Math.max(0, Math.min(1, x));
    c.y = Math.max(0, Math.min(1, y));
    onChange(false);
    e.preventDefault();
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) {
      // ドラッグでなくタップだったら初期化用に通知する
      if (downAt && opts.onTap) {
        const { x, y } = toNorm(e);
        const moved = Math.hypot(x - downAt.x, y - downAt.y);
        if (moved < 0.02 && performance.now() - downAt.t < 600) opts.onTap(x, y);
      }
      downAt = null;
      return;
    }
    dragging = null;
    downAt = null;
    canvas.releasePointerCapture(e.pointerId);
    onChange(true);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  function destroy(): void {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  }

  return handle;
}
