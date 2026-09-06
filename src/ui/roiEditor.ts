/** ROI の四隅ドラッグ。ポインタ座標は正規化 (0..1) で扱う。 */

import type { RoiConfig } from '../vision/roi';

export interface RoiEditorHandle {
  hover: { roi: number; corner: number } | null;
  destroy(): void;
}

const HIT_PX = 26;

export function attachRoiEditor(
  canvas: HTMLCanvasElement,
  getRois: () => RoiConfig[],
  onChange: (final: boolean) => void,
): RoiEditorHandle {
  let dragging: { roi: number; corner: number } | null = null;
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
      handle.hover = pick(x, y, rect);
      return;
    }
    const c = getRois()[dragging.roi].corners[dragging.corner];
    c.x = Math.max(0, Math.min(1, x));
    c.y = Math.max(0, Math.min(1, y));
    onChange(false);
    e.preventDefault();
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = null;
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
