// 試作: 書き出した精密解析の観測（realVideo.debug.test.ts の REAL_OBS）を「止まっている区間」ごとに足し合わせ、区間の間を深く探して解き直す。
// 1 観測で読めるマスは 8 ほど。同じ状態の間（手と手の間）の観測を足し合わせると 15〜18 マスになり、深く探しても「たまたま合う間違った
// 手順」が出にくくなる。手と手の間の半分は止まった瞬間が 1 フレームもない（続けて回す）ので、区間の間には 2 手以上入るのがふつう。
//   OBS_FILE=obs.json REF_FILE=ref.json npx vitest run -c vitest.debug.config.ts tests/debug/segmentReplay.debug.test.ts --silent=false
//   SEG_MODE=layer（層ごとに足し合わせる。LAYER_W・HOLD_MS・LAYER_SHIFT）・SEG_RULE=face|shift|turn|all（フレームの読みで区切る。REAL_OBS に frames があるとき）・SEG_MIN_BOTH・SEG_GAP
//   SEG_DEC='[{"maxMovesPerStep":4,"beamWidth":256}]'（試すデコーダの設定の並び）
// 結果（2026-11、Testvideo2 の 5047・5048 を録画の画質 2.5Mbps で）: 本当の手の時刻で区切れば 1 区間 14〜16 マスになるが、観測どうしの
// 食い違いだけで区切ると 8.3 → 9.0〜9.7 マスにしかならず（両方で読めたマスが少なく、回った後も食い違いが見えないまま足してしまう）、
// 5048 で正解と 10 手違う手順が「完成まで」つながった（誤った手順を確定にするのがいちばん悪い）。区切りは観測ではなく、フレームの
// マーカーの動き（層が動いたか: src/track/timing.ts のずれ）で決める必要がある
// 続けて、精密解析が処理したフレームの読み（REAL_OBS の frames）で「面が組み立てられないフレームは回している途中」として区切った（SEG_RULE）。
// 本当に手が入った観測の間のうち 6 割前後（162 中 103 など）は、間のフレームでもどこかの面が組み立てられていて区切れない（U を回している間も
// 正面の下 2 段・右の面は読める）。ずれ・回転途中の形も足すと見逃しは 16〜32 に減るが、止まっている所も区切って足し合わせがほとんど
// 起きない。解き直すと速くはなる（1 回目 15〜19 秒 → 1〜7 秒）が、face・shift では 4 本のうち 5048 で、終わりの 15 手が違う手順が
// 「完成まで」つながった。本体には入れない
// さらに、層ごとに足し合わせた（SEG_MODE=layer。REAL_OBS の frames の 6 番目にマスごとの ID とずれ）: 読みが変わった・ずれたマスを含む層のうち、
// 同じ層の別のマスが止まって読めた層を除いた層のマスだけ捨て、真ん中の ID が変わったら（持ち替え）全部捨てる。誤った手順が完成まで
// つながることはなくなったが、足し合わせたマスは 8.3 → 9.4〜10.4（録画の画質）・9.4 → 11.3〜12.2（元の画質）にとどまり（全部捨てるのが
// 1 本 87〜189 回: 面の割り当てが変わる・説明のつかない変わり方）、録画の画質では 1 回目の設定で 5047・5049 が観測ごとより悪くなった
// （持ち越したマスの重みを 0.3〜0.5 にしても同じ）。深い設定（4 手・候補 256）なら 2 本とも正しく完成までつながるが、観測ごとより遅い
// （35.7 秒 / 14 秒・26.4 秒 / 24.6 秒）。効き目がないので本体には入れない
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, applyMoves, faceletGeometry, isSolved } from "../../src/cube/model";
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

// フレームの読み（realVideo の REAL_OBS の frames: [時刻, 面の数, ID のマス, ずれの最大, 回転の形]）で「回している途中」とみなすフレーム
// SEG_RULE: face = 面が組み立てられない / shift = 面なしか格子からのずれ > 0.18 / turn = 面なしか回転途中の形 / all = どれか
let frames: number[][] = [];
function moving(f: number[]): boolean {
  const rule = process.env.SEG_RULE ?? "";
  if (rule === "face") return f[1] === 0;
  if (rule === "shift") return f[1] === 0 || f[3] > 0.18;
  if (rule === "turn") return f[1] === 0 || f[4] === 1;
  if (rule === "all") return f[1] === 0 || f[3] > 0.18 || f[4] === 1;
  return false;
}
// 観測 a から b までの間（b を含まない）に、回している途中とみなすフレームがあるか
function movedBetween(a: number, b: number): boolean {
  if (!process.env.SEG_RULE) return false;
  for (const f of frames) if (f[0] >= a && f[0] < b && moving(f)) return true;
  return false;
}

function segments(obs: Observation[]): Observation[] {
  const out: Observation[] = [];
  let cur: Observation | null = null;
  let last: Observation | null = null;
  for (const o of obs) {
    if (!o.faces.length) continue;
    // 回転途中の形が見えた・同じマスの読みが食い違った（何か回った）・間が開いたら次の区間
    const gap = last ? o.t - last.t : 0;
    if (cur && last && !o.turns?.length && gap < Number(process.env.SEG_GAP ?? 400) && !movedBetween(last.t, o.t) && agrees(cur, o) && agrees(last, o)) mergeInto(cur, o);
    else {
      cur = { t: o.t, tPrevEnd: o.tPrevEnd, faces: o.faces.map((f) => ({ ...f, cost: f.cost.slice(), labels: f.labels.slice(), ...(f.ids ? { ids: f.ids.slice(), idCost: f.idCost!.slice() } : {}) })), turns: o.turns };
      out.push(cur);
    }
    last = o;
  }
  return out;
}

// ---- 層ごとに足し合わせる（SEG_MODE=layer） ----
// マスごとに最後に読めた読みを持ち続ける。読みが変わった・マーカーが格子からずれたマスは、そのマスを含む層（カメラの面の格子の 3D の位置で
// ±1 の軸ごと。角は 3 層・辺は 2 層・真ん中は自分の面の層だけ）のどれかが動いた。同じ層の別のマス（真ん中以外）が変わらずに読めて
// ずれもなければその層は動いていないので候補から外し、残った層のマスの読みだけ捨てる。真ん中の ID が変わったら持ち替えとして全部捨てる。
// 説明のつかない変わり方（どの層もほかのマスで止まっていたと分かる）も全部捨てる。HOLD_MS 読めなかったマスの読みは捨てる
const LAYERS: number[][] = []; // (slot*9+cell) → 含む層（軸*2 + 正の側なら 1）
const CENTER = (k: number) => k % 9 === 4;
for (let k = 0; k < 54; k++) {
  const { pos } = faceletGeometry(k);
  const ls: number[] = [];
  for (let a = 0; a < 3; a++) if (pos[a] !== 0) ls.push(a * 2 + (pos[a] > 0 ? 1 : 0));
  LAYERS.push(CENTER(k) ? [] : ls); // 真ん中は面を回しても同じステッカーのまま（どの層の動きの証拠にもならない）
}
const MOVE_SHIFT = Number(process.env.LAYER_SHIFT ?? 18); // マス × 100

interface Held {
  t: number;
  label: number;
  cost: Float32Array;
  id: number;
  idCost: number;
}

function layerAccumulate(obs: Observation[], frameLog: number[][]): Observation[] {
  const HOLD_MS = Number(process.env.HOLD_MS ?? 600);
  const held: (Held | null)[] = new Array(54).fill(null);
  const out: Observation[] = [];
  let fi = 0;
  let resets = 0;
  let drops = 0;
  const dropAll = () => {
    held.fill(null);
    resets++;
  };
  // 読み（id）と、ずれた・変わったマス
  const judge = (reads: Map<number, number>, moving: Set<number>) => {
    // 真ん中の ID が変わった: 持ち替え
    for (const [k, id] of reads) if (CENTER(k) && held[k] && held[k]!.id >= 0 && id >= 0 && id !== held[k]!.id) return dropAll();
    const changed = new Set<number>(moving);
    const stable = new Set<number>();
    for (const [k, id] of reads) {
      const h = held[k];
      if (!h || h.id < 0 || id < 0 || CENTER(k)) continue;
      if (id !== h.id) changed.add(k);
      else if (!moving.has(k)) stable.add(k);
    }
    if (!changed.size) return;
    const still = new Set<number>();
    for (const k of stable) for (const l of LAYERS[k]) still.add(l);
    const moved = new Set<number>();
    for (const k of changed) {
      const cand = LAYERS[k].filter((l) => !still.has(l));
      if (!cand.length) {
        if (CENTER(k)) continue;
        return dropAll(); // 説明がつかない
      }
      for (const l of cand) moved.add(l);
    }
    for (let k = 0; k < 54; k++) if (held[k] && !CENTER(k) && LAYERS[k].some((l) => moved.has(l))) {
      held[k] = null;
      drops++;
    }
  };
  for (const o of obs) {
    // 前の観測からこの観測までのフレーム: ずれたマスと読み
    for (; fi < frameLog.length && frameLog[fi][0] <= o.t; fi++) {
      const fr = frameLog[fi] as unknown as [number, number, number, number, number, number[][]];
      const reads = new Map<number, number>();
      const moving = new Set<number>();
      for (const face of fr[5] ?? []) {
        const slot = face[0];
        for (let c = 0; c < 9; c++) {
          const id = face[1 + c];
          const sh = face[10 + c];
          if (id >= 0) reads.set(slot * 9 + c, id);
          if (sh >= MOVE_SHIFT) moving.add(slot * 9 + c);
        }
      }
      judge(reads, moving);
      // フレームで読めた ID が持っている読みと違えば、その読みは古い（観測で上書きされるまで捨てる）
      for (const [k, id] of reads) if (held[k] && held[k]!.id >= 0 && held[k]!.id !== id) held[k] = null;
      for (const [k] of reads) if (held[k]) held[k]!.t = fr[0];
    }
    // 観測の読みで上書き
    const reads = new Map<number, number>();
    for (const f of o.faces) for (let c = 0; c < 9; c++) if (f.labels[c] >= 0) reads.set(f.slot * 9 + c, f.ids?.[c] ?? -1);
    judge(reads, new Set());
    for (const f of o.faces)
      for (let c = 0; c < 9; c++) {
        if (f.labels[c] < 0) continue;
        held[f.slot * 9 + c] = { t: o.t, label: f.labels[c], cost: f.cost.slice(c * 6, c * 6 + 6), id: f.ids?.[c] ?? -1, idCost: f.idCost?.[c] ?? 0 };
      }
    for (let k = 0; k < 54; k++) if (held[k] && o.t - held[k]!.t > HOLD_MS) held[k] = null;
    // 持っている読みから観測を作る
    const faces: FaceObservation[] = [];
    for (let slot = 0; slot < 6; slot++) {
      if (!held.slice(slot * 9, slot * 9 + 9).some((h) => h)) continue;
      const cost = new Float32Array(54);
      const labels = new Int8Array(9).fill(-1);
      const ids = new Int16Array(9).fill(-1);
      const idCost = new Float32Array(9);
      for (let c = 0; c < 9; c++) {
        const h = held[slot * 9 + c];
        if (!h) continue;
        // この観測で読めたマスはそのまま、持ち越したマスは重みを下げる（LAYER_W）
        const w = h.t === o.t ? 1 : Number(process.env.LAYER_W ?? 1);
        labels[c] = h.label;
        for (let k = 0; k < 6; k++) cost[c * 6 + k] = h.cost[k] * w;
        ids[c] = h.id;
        idCost[c] = h.idCost * w;
      }
      faces.push({ slot, cost, labels, ids, idCost });
    }
    out.push({ t: o.t, tPrevEnd: o.tPrevEnd, faces, turns: o.turns });
  }
  console.log(`層ごと: 全部捨てた ${resets} 回・層で捨てたマス ${drops}`);
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
  const raw = JSON.parse(readFileSync(file, "utf8")) as { start: number[]; end: number[] | null; lastT: number; frames?: number[][]; obs: RawObs[] };
  frames = raw.frames ?? [];
  const obs = raw.obs.map(toObs);
  const truth = process.env.REF_FILE ? (JSON.parse(readFileSync(process.env.REF_FILE, "utf8")) as { moves: { move: number }[] }).moves.map((m) => MOVE_NAMES[m.move]) : null;
  const start = Uint8Array.from(raw.start);
  const end = raw.end ? Uint8Array.from(raw.end) : null;
  const segs = process.env.SEG_MODE === "layer" ? layerAccumulate(obs, raw.frames ?? []) : segments(obs);
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
      if (process.env.SEG_PRINT) console.log(`手順 ${names.join(" ")}`);
      console.log(`${name} ${JSON.stringify(dec)}: ${(ms / 1000).toFixed(1)} 秒・${res.method}・${ok ? "完成まで" : "届かない"}・${names.length} 手・推定 ${moves.filter((m) => m.inferred).length}${truth ? `・正解との違い ${dist} 手` : ""}`);
    }
  }
});
