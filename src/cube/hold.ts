// 表示の持ち方: 記録の詳しい画面の 3D・手順の表記で、クロスの面を下にして持った向き（できれば緑・赤・青・橙の順に前）。
// cubing.js の 3D に渡す持ち替え（x・y・z）と、キューブ固定の手をその持ち方での手に読み替えるための姿勢を返す。DOM を知らない
import { NUM_ORIENTATIONS, cubeFaceAt, rotateOrientation } from "./model";

const IDENTITY_O = 0; // ORIENTATIONS[0] は単位行列（白上・緑前）
const ROTS: { axis: "x" | "y" | "z"; times: number; name: string }[] = (["x", "y", "z"] as const).flatMap((axis) => [
  { axis, times: 1, name: axis },
  { axis, times: 2, name: `${axis}2` },
  { axis, times: 3, name: `${axis}'` },
]);

export interface Hold {
  o: number; // キューブ固定 → 表示（カメラフレーム）の姿勢。relativeMove(m, o) でその持ち方での手
  rotation: string; // cubing.js で白上・緑前からこの持ち方にする持ち替え（"" / "z2" / "x' y" など）
}

export function holdWithDown(face: number): Hold {
  // 前に来てほしい面の順（緑 F・赤 R・青 B・橙 L・白 U・黄 D）
  const want = [2, 1, 5, 4, 0, 3];
  let target = -1;
  for (const f of want) {
    target = Array.from({ length: NUM_ORIENTATIONS }, (_, o) => o).find((o) => cubeFaceAt(o, 3) === face && cubeFaceAt(o, 2) === f) ?? -1;
    if (target >= 0) break;
  }
  // 白上・緑前から、持ち替え 2 回までで届く並び（短い方）
  let frontier: { o: number; seq: string[] }[] = [{ o: IDENTITY_O, seq: [] }];
  for (let depth = 0; depth <= 2; depth++) {
    const hit = frontier.find((x) => x.o === target);
    if (hit) return { o: target, rotation: hit.seq.join(" ") };
    frontier = frontier.flatMap((x) => ROTS.map((r) => ({ o: rotateOrientation(x.o, r.axis, r.times), seq: [...x.seq, r.name] })));
  }
  return { o: IDENTITY_O, rotation: "" };
}
