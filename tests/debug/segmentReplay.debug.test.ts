// 試作: 書き出した精密解析の観測（realVideo.debug.test.ts の REAL_OBS）を「止まっている区間」ごとに足し合わせ、区間の間を深く探して解き直す。
// 1 観測で読めるマスは 8 ほど。同じ状態の間（手と手の間）の観測を足し合わせると 15〜18 マスになり、深く探しても「たまたま合う間違った
// 手順」が出にくくなる。手と手の間の半分は止まった瞬間が 1 フレームもない（続けて回す）ので、区間の間には 2 手以上入るのがふつう。
//   OBS_FILE=obs.json REF_FILE=ref.json npx vitest run -c vitest.debug.config.ts tests/debug/segmentReplay.debug.test.ts --silent=false
//   SEG_DEC='[{"maxMovesPerStep":4,"beamWidth":256}]'（試すデコーダの設定の並び）
// 結果（2026-11、Testvideo2 の 5047・5048 を録画の画質 2.5Mbps で）: 本当の手の時刻で区切れば 1 区間 14〜16 マスになるが、観測どうしの
// 食い違いだけで区切ると 8.3 → 9.0〜9.7 マスにしかならず（両方で読めたマスが少なく、回った後も食い違いが見えないまま足してしまう）、
// 5048 で正解と 10 手違う手順が「完成まで」つながった（誤った手順を確定にするのがいちばん悪い）。区切りは観測ではなく、フレームの
// マーカーの動き（層が動いたか: src/track/timing.ts のずれ）で決める必要がある
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, applyMoves, isSolved } from "../../src/cube/model";
import { simplifyMoves } from "../../src/track/merge";
import { DEFAULT_OFFLINE, decodeOffline } from "../../src/track/offline";
import type { FaceObservation, Observation } from "../../src/track/types";

type RawFace = { slot: number; cost: number[]; labels: number[]; ids?: number[]; idCost?: number[] };
type RawObs = Omit<Observation, "faces"> & { faces: RawFace[] };

const toObs = (o: RawObs): Observation => ({
  ...o,
  faces: o.faces.map((f) => ({ slot: f.slot, cost: Float32Array.from(f.cost), labels: Int8Array.from(f.labels), ...(f.ids ? { ids: Int16Array.from(f.ids), idCost: Float32Array.from(f.idCost!) } : {}) })),
});

// 2 つの観測が同じ状態を見ているとみなせるか: 両方で読めたマスの色・ステッカーがすべて同じ
function agrees(a: Observation, b: Observation): boolean {
  let both = 0;
  for (const fa of a.faces) {
    const fb = b.faces.find((x) => x.slot === fa.slot);
    if (!fb) continue;
    for (let c = 0; c < 9; c++) {
      if (fa.labels[c] < 0 || fb.labels[c] < 0) continue;
      both++;
      if (fa.labels[c] !== fb.labels[c]) return false;
      const ia = fa.ids?.[c] ?? -1;
      const ib = fb.ids?.[c] ?? -1;
      if (ia >= 0 && ib >= 0 && ia !== ib) return false;
    }
  }
  return both >= Number(process.env.SEG_MIN_BOTH ?? 2);
}

// b の読めたマスのうち a で読めていないものを a に足す
function mergeInto(a: Observation, b: Observation): void {
  for (const fb of b.faces) {
    let fa = a.faces.find((x) => x.slot === fb.slot);
    if (!fa) {
      fa = { slot: fb.slot, cost: new Float32Array(54), labels: new Int8Array(9).fill(-1), ...(fb.ids ? { ids: new Int16Array(9).fill(-1), idCost: new Float32Array(9) } : {}) } as FaceObservation;
      a.faces.push(fa);
    }
    for (let c = 0; c < 9; c++) {
      const known = fa.labels[c] >= 0;
      const better = (fb.ids?.[c] ?? -1) >= 0 && (fa.ids?.[c] ?? -1) < 0;
      if (fb.labels[c] < 0 || (known && !better)) continue;
      fa.labels[c] = fb.labels[c];
      for (let k = 0; k < 6; k++) fa.cost[c * 6 + k] = fb.cost[c * 6 + k];
      if (fb.ids) {
        if (!fa.ids) {
          fa.ids = new Int16Array(9).fill(-1);
          fa.idCost = new Float32Array(9);
        }
        fa.ids[c] = fb.ids[c];
        fa.idCost![c] = fb.idCost![c];
      }
    }
  }
}

function segments(obs: Observation[]): Observation[] {
  const out: Observation[] = [];
  let cur: Observation | null = null;
  let last: Observation | null = null;
  for (const o of obs) {
    if (!o.faces.length) continue;
    // 回転途中の形が見えた・同じマスの読みが食い違った（何か回った）・間が開いたら次の区間
    const gap = last ? o.t - last.t : 0;
    if (cur && last && !o.turns?.length && gap < Number(process.env.SEG_GAP ?? 400) && agrees(cur, o) && agrees(last, o)) mergeInto(cur, o);
    else {
      cur = { t: o.t, tPrevEnd: o.tPrevEnd, faces: o.faces.map((f) => ({ ...f, cost: f.cost.slice(), labels: f.labels.slice(), ...(f.ids ? { ids: f.ids.slice(), idCost: f.idCost!.slice() } : {}) })), turns: o.turns };
      out.push(cur);
    }
    last = o;
  }
  return out;
}

const cells = (o: Observation) => o.faces.reduce((n, f) => n + (f.ids ? Array.from(f.ids).filter((x) => x >= 0).length : 0), 0);

function editDistance(a: string[], b: string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

it("止まっている区間ごとに足し合わせて解き直す", () => {
  const file = process.env.OBS_FILE;
  if (!file) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { start: number[]; end: number[] | null; lastT: number; obs: RawObs[] };
  const obs = raw.obs.map(toObs);
  const truth = process.env.REF_FILE ? (JSON.parse(readFileSync(process.env.REF_FILE, "utf8")) as { moves: { move: number }[] }).moves.map((m) => MOVE_NAMES[m.move]) : null;
  const start = Uint8Array.from(raw.start);
  const end = raw.end ? Uint8Array.from(raw.end) : null;
  const segs = segments(obs);
  const per = obs.filter((o) => o.faces.length).map(cells);
  console.log(`観測 ${per.length}（ID のマス 平均 ${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1)}）→ 区間 ${segs.length}（平均 ${(segs.map(cells).reduce((a, b) => a + b, 0) / segs.length).toFixed(1)}）`);
  const configs = JSON.parse(process.env.SEG_DEC ?? '[{}, {"maxMovesPerStep":4,"beamWidth":256}]') as object[];
  for (const [name, input] of [
    ["観測ごと", obs],
    ["区間ごと", segs],
  ] as const) {
    if (process.env.SEG_ONLY && process.env.SEG_ONLY !== name) continue;
    for (const dec of configs) {
      const options = { decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5, ...DEFAULT_OFFLINE.decoder, ...dec }, bridge: true };
      const a = performance.now();
      const res = decodeOffline(input as Observation[], start, end, raw.lastT, options);
      const ms = performance.now() - a;
      const moves = simplifyMoves(res.moves);
      const names = moves.map((m) => MOVE_NAMES[m.move]);
      const ok = end ? isSolved(applyMoves(start, res.moves.map((m) => m.move))) : false;
      const dist = truth ? editDistance(names, simplifyMoves(truth.map((n) => ({ move: MOVE_NAMES.indexOf(n), t: 0, orient: 0 }))).map((m) => MOVE_NAMES[m.move])) : -1;
      console.log(`${name} ${JSON.stringify(dec)}: ${(ms / 1000).toFixed(1)} 秒・${res.method}・${ok ? "完成まで" : "届かない"}・${names.length} 手・推定 ${moves.filter((m) => m.inferred).length}${truth ? `・正解との違い ${dist} 手` : ""}`);
    }
  }
});
