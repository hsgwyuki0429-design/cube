// 手と手の間の状態がどれだけ読めたか: 実物の動画で、k 手目と k+1 手目の間のキューブの状態 S_k が分かるフレームがあったかを数える。
// 手順は精密解析の結果（本当の動きとみなす）。精密解析の途中の手の時刻は粗い（速い手順では前の手の回し終わりが次の手の回し始めより
// 後になることが多い）ので、前の手の回し始めから次の手の回し終わりまでの間で探す。
//   realVideo.debug.test.ts で REAL_REF=ref.json REAL_READINGS=live.json REAL_RREADINGS=ref-read.json を書き出してから
//   BM_REF=ref.json BM_READ=live.json,ref-read.json npx vitest run -c vitest.debug.config.ts tests/debug/betweenMoves.debug.test.ts --silent=false
// フレームの読み（ID が読めたマス）を、24 通りの姿勢のうち S_k に一番合う姿勢で S_k・S_{k-1}（前の手の前）・S_{k+1}（次の手の後）と照らす:
//   確かめた: S_k と食い違うマスがなく、S_{k-1} と違うマス（前の手を回し終えた証拠）と S_{k+1} と違うマス（次の手をまだ回していない証拠）が
//     どちらも 1 つ以上ある
//   前だけ / 次だけ: 片方の証拠しかない（回した層が見えていない）
//   見えず: 読めたマスがどちらとも区別できない・間にフレームがない
// BM_FPS=30,15,10: 全フレームの読みから 1 秒 N 枚だけ取ったら確かめられたか（取り始めをずらして平均）。全フレームで処理したときの読みから
// 抜き出すので、実際に 1 秒 N 枚で処理したとき（格子で追う範囲が広くなる）とは少し違う
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, VIEW, applyMove } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";

type Reading = { t: number; faces: { slot: number; ids?: number[] | null }[] };
type RefMove = { move: number; start: number; end: number; inferred?: boolean; exact?: boolean };
type Verdict = "both" | "prev" | "next" | "none" | "noframe";
const LABEL: Record<Verdict, string> = { both: "確かめた", prev: "前だけ", next: "次だけ", none: "見えず", noframe: "フレームなし" };
const SEEN = [0, 1, 2, 4, 8, Infinity]; // 確かめたフレームの数の区切り

// 1 フレームの読みを状態 st の、一番合う姿勢で照らす
function judge(r: Reading, st: Uint8Array, prev: Uint8Array, next: Uint8Array) {
  const cur = stickerIds(st);
  const p = stickerIds(prev);
  const n = stickerIds(next);
  let best = { score: -Infinity, read: 0, wrong: 0, dPrev: 0, dNext: 0 };
  for (let o = 0; o < 24; o++) {
    let read = 0;
    let wrong = 0;
    let dPrev = 0;
    let dNext = 0;
    for (const f of r.faces)
      for (let c = 0; c < 9; c++) {
        const id = f.ids?.[c] ?? -1;
        if (id < 0) continue;
        read++;
        const fl = VIEW[(o * 6 + f.slot) * 9 + c];
        if (cur[fl] !== id) {
          wrong++;
          continue;
        }
        if (p[fl] !== id) dPrev++;
        if (n[fl] !== id) dNext++;
      }
    const score = read - 2 * wrong;
    if (score > best.score) best = { score, read, wrong, dPrev, dNext };
  }
  return best;
}

function verdictOf(js: ReturnType<typeof judge>[]): Verdict {
  if (!js.length) return "noframe";
  const ok = js.filter((j) => j.wrong === 0);
  if (ok.some((j) => j.dPrev > 0 && j.dNext > 0)) return "both";
  // 前の証拠と次の証拠が別のフレームにある場合も、その間の状態は確かめられている
  if (ok.some((j) => j.dPrev > 0) && ok.some((j) => j.dNext > 0)) return "both";
  if (ok.some((j) => j.dPrev > 0)) return "prev";
  if (ok.some((j) => j.dNext > 0)) return "next";
  return "none";
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

it("手と手の間の状態がどれだけ読めたか", () => {
  const refFile = process.env.BM_REF;
  if (!refFile) return;
  const ref = JSON.parse(readFileSync(refFile, "utf8")) as { moves: RefMove[]; startState?: number[]; solved: boolean };
  const files = (process.env.BM_READ ?? "").split(",").filter(Boolean);
  const fpsList = (process.env.BM_FPS ?? "30,15,10").split(",").map(Number).filter(Boolean);
  const out: string[] = [];
  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8")) as { start: number[]; readings: Reading[] };
    const start = Uint8Array.from(ref.startState ?? data.start);
    const moves = ref.moves;
    const states: Uint8Array[] = [start];
    for (const m of moves) states.push(applyMove(states[states.length - 1], m.move));
    const rs = data.readings.slice().sort((a, b) => a.t - b.t);
    const frameMs = rs.length > 1 ? (rs[rs.length - 1].t - rs[0].t) / (rs.length - 1) : 16.7;
    out.push(`\n== ${file}（フレーム ${rs.length}・平均の間 ${frameMs.toFixed(1)}ms）・手 ${moves.length}（推定 ${moves.filter((m) => m.inferred).length}）・精密解析 ${ref.solved ? "完成まで" : "つながらず"}`);
    // 間の状態 S_k（k = 1..n-1）: moves[k-1] の回し終わり〜 moves[k] の回し始め
    type Gap = { k: number; gap: number; frames: number; verdict: Verdict; maxRead: number; maxEvid: number; wrongFrames: number; seen: number };
    const gaps: Gap[] = [];
    const verdictAt = (k: number, pick: (r: Reading, i: number) => boolean) => {
      const a = moves[k - 1].start;
      const b = moves[k].end;
      const js = rs.filter((r, i) => r.t >= a && r.t <= b && pick(r, i)).map((r) => judge(r, states[k], states[k - 1], states[k + 1]));
      return { js, verdict: verdictOf(js) };
    };
    for (let k = 1; k < moves.length; k++) {
      if (moves[k - 1].inferred || moves[k].inferred) continue; // 推定した手の前後は時刻が当てにならない
      const { js, verdict } = verdictAt(k, () => true);
      gaps.push({
        k,
        gap: moves[k].start - moves[k - 1].end,
        frames: js.length,
        verdict,
        maxRead: Math.max(0, ...js.map((j) => j.read)),
        maxEvid: Math.max(0, ...js.filter((j) => j.wrong === 0).map((j) => Math.min(j.dPrev, j.dNext))),
        wrongFrames: js.filter((j) => j.wrong > 0).length,
        seen: js.filter((j) => j.wrong === 0 && j.dPrev > 0 && j.dNext > 0).length, // その状態だと 1 枚で分かったフレーム
      });
    }
    const count = (gs: Gap[], v: Verdict) => gs.filter((g) => g.verdict === v).length;
    const line = (name: string, gs: Gap[]) =>
      `${name.padEnd(12)} ${String(gs.length).padStart(3)} 個: ${(["both", "prev", "next", "none", "noframe"] as Verdict[]).map((v) => `${LABEL[v]} ${pct(count(gs, v), gs.length)}`).join("・")}`;
    out.push(line("全部", gaps));
    const seenLine = SEEN.slice(0, -1).map((lo, i) => {
      const hi = SEEN[i + 1];
      const n = gaps.filter((g) => g.seen >= lo && g.seen < hi).length;
      return `${hi === Infinity ? `${lo} 枚以上` : hi - lo === 1 ? `${lo} 枚` : `${lo}〜${hi - 1} 枚`} ${pct(n, gaps.length)}`;
    });
    out.push(`その状態だと 1 枚で分かったフレームの数（60fps）: ${seenLine.join("・")}`);
    const withFrames = gaps.filter((g) => g.frames);
    const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : 0);
    out.push(
      `探したフレーム 中央 ${med(gaps.map((g) => g.frames))} 枚・` +
        `間で一番多く読めたマス 中央 ${med(withFrames.map((g) => g.maxRead))}・食い違いのあるフレーム ${gaps.reduce((n, g) => n + g.wrongFrames, 0)}/${gaps.reduce((n, g) => n + g.frames, 0)}`,
    );
    // 1 秒 N 枚だけ取ったとき
    const fpsLine = fpsList.map((fps) => {
      const step = Math.max(1, Math.round(1000 / fps / frameMs));
      let both = 0;
      let total = 0;
      for (let phase = 0; phase < step; phase++)
        for (const g of gaps) {
          total++;
          if (verdictAt(g.k, (_r, i) => i % step === phase).verdict === "both") both++;
        }
      return `${fps} 枚 ${pct(both, total)}`;
    });
    out.push(`1 秒 N 枚だけ取ったときの「確かめた」: ${fpsLine.join("・")}`);
    if (process.env.BM_LIST)
      for (const g of gaps)
        out.push(
          `  S${g.k} ${MOVE_NAMES[moves[g.k - 1].move]}→${MOVE_NAMES[moves[g.k].move]} ${(moves[g.k - 1].end / 1000).toFixed(3)}s ${g.frames} 枚中 ${g.seen} 枚 ${LABEL[g.verdict]}・最多 ${g.maxRead} マス・証拠 ${g.maxEvid}${g.wrongFrames ? `・食い違い ${g.wrongFrames} 枚` : ""}`,
        );
  }
  console.log(out.join("\n"));
});
