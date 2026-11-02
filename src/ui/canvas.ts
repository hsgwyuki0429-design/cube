// canvas に描くときの小さな部品

// 点を順につないだ閉じた多角形のパスを作る（塗る・線を引くのは呼ぶ側）
export function polygonPath(ctx: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}
