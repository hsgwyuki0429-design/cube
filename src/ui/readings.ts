// 読み取りの図（src/ui/CameraView.tsx）のマスの分け方。DOM を使わない（tests/readings.test.ts）
// マスの読み: direct = マーカーの ID を直接読んだ（そのマスにマーカーが写っていた: DetectedFace.shift）・kept = ID はあるが直接は読んでいない
// （前のフレームから引き継いだ・格子で追った推測）・none = ID がない
export type CellRead = "direct" | "kept" | "none";
export function cellReads(face: { ids?: number[]; shift?: ([number, number] | null)[] }): CellRead[] {
  return Array.from({ length: 9 }, (_, c) => {
    const id = face.ids?.[c] ?? -1;
    if (id < 0) return "none";
    return face.shift?.[c] ? "direct" : "kept";
  });
}
