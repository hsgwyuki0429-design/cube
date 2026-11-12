// 全フレームで筋書きを採点し直す（src/track/rescore.ts）の効き目を、実物の動画で測る。
// 精密解析の結果（たたき台）と精密解析が処理したフレームの読みを realVideo.debug.test.ts で書き出し、正解（原画質の動画の精密解析の手順）と比べる:
//   RS_READ=lq.ref-read.json RS_BASE=lq.ref.json RS_TRUTH=ref.json npx vitest run -c vitest.debug.config.ts tests/debug/rescore.debug.test.ts --silent=false
//   RS_PERTURB=10（たたき台をわざと崩す: 打ち消し合う 2 手を足す・隣り合う反対の面の手を入れ替える。崩したものが直るか）
//   RS_OPT='{"window":4}' など（src/track/rescore.ts の RescoreOptions）・RS_LIST=1（置き換えた所）
// 手順の比べ方: 同じ面の手が続いたらまとめ（U U' → なし・U U → U2）、隣り合う反対の面の手は順番をそろえてから（R L と L R は同じ）、手の挿入・削除・置き換えの数（編集距離）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { type CubeState, MOVE_NAMES, VIEW, applyMove, moveFace, statesEqual } from "../../src/cube/model";
import { stickerIds } from "../../src/cube/stickers";
import { type RescoreFrame, type RescoreMove, canonical, rescore } from "../../src/track/rescore";

const normalize = canonical;

function editDistance(a: number[], b: number[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

it("全フレームで筋書きを採点し直す", () => {
  const readFile = process.env.RS_READ;
  if (!readFile) return;
  const read = JSON.parse(readFileSync(readFile, "utf8")) as { start: number[]; readings: RescoreFrame[] };
  const base = JSON.parse(readFileSync(process.env.RS_BASE!, "utf8")) as { moves: RescoreMove[]; startState?: number[]; solved: boolean; inferred: number };
  const truth = process.env.RS_TRUTH ? (JSON.parse(readFileSync(process.env.RS_TRUTH, "utf8")) as { moves: RescoreMove[]; startState?: number[] }) : null;
  const start = Uint8Array.from(base.startState ?? read.start);
  // RS_PERTURB=n: たたき台を n か所わざと崩す（終わりの状態は変えない）
  const nPerturb = Number(process.env.RS_PERTURB ?? 0);
  if (nPerturb) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ms = base.moves.map((m) => ({ ...m }));
    for (let k = 0; k < nPerturb; k++) {
      const i = 1 + Math.floor(rnd() * (ms.length - 2));
      const swap = moveFace(ms[i].move) % 3 === moveFace(ms[i + 1].move) % 3 && moveFace(ms[i].move) !== moveFace(ms[i + 1].move);
      if (swap && rnd() < 0.7) [ms[i], ms[i + 1]] = [{ ...ms[i + 1], start: ms[i].start, end: ms[i].end }, { ...ms[i], start: ms[i + 1].start, end: ms[i + 1].end }];
      else {
        let x = Math.floor(rnd() * 18);
        while (moveFace(x) === moveFace(ms[i].move) || moveFace(x) === moveFace(ms[i - 1].move)) x = Math.floor(rnd() * 18);
        const inv = moveFace(x) * 3 + [2, 1, 0][x % 3];
        const t = (ms[i - 1].end + ms[i].start) / 2;
        ms.splice(i, 0, { ...ms[i], move: x, start: t, end: t }, { ...ms[i], move: inv, start: t, end: t });
      }
    }
    base.moves = ms;
  }
  const t0 = performance.now();
  const r = rescore(read.readings, start, base.moves, JSON.parse(process.env.RS_OPT ?? "{}"));
  const ms = performance.now() - t0;
  const names = (xs: number[]) => xs.map((m) => MOVE_NAMES[m]).join(" ");
  const endOf = (xs: number[]) => {
    let s: CubeState = Uint8Array.from(start);
    for (const m of xs) s = applyMove(s, m);
    return s;
  };
  const out = [`${readFile}: フレーム ${read.readings.length}・たたき台 ${base.moves.length} 手（推定 ${base.inferred}・${base.solved ? "完成まで" : "つながらず"}）・採点し直し ${(ms / 1000).toFixed(1)} 秒・置き換え ${r.changes.length} か所`];
  const before = normalize(base.moves.map((m) => m.move));
  const after = normalize(r.moves.map((m) => m.move));
  if (!statesEqual(endOf(before), endOf(after))) out.push("!! 終わりの状態が変わった");
  if (truth) {
    const want = normalize(truth.moves.map((m) => m.move));
    const sameStart = statesEqual(Uint8Array.from(truth.startState ?? read.start), start);
    const raw = (ms: RescoreMove[]) => ms.map((m) => m.move);
    out.push(
      `正解 ${want.length} 手${sameStart ? "" : "（始まりの状態が違う）"}: 編集距離 たたき台 ${editDistance(before, want)} → 採点し直し ${editDistance(after, want)}` +
        `（まとめない手順で ${editDistance(raw(base.moves), raw(truth.moves))} → ${editDistance(raw(r.moves), raw(truth.moves))}）`,
    );
  }
  // RS_FRAMES=2.2-2.6: その間のフレームを、正解の手順と時刻の状態と照らす（食い違うマス: 面.マス 読んだ ID / 正解の ID・前の状態どおり < / 後の状態どおり >）
  if (truth && process.env.RS_FRAMES) {
    const [f0, f1] = process.env.RS_FRAMES.split("-").map((x) => Number(x) * 1000);
    const tst = Uint8Array.from(truth.startState ?? read.start);
    for (const fr of read.readings) {
      if (fr.t < f0 || fr.t > f1) continue;
      let st: CubeState = Uint8Array.from(tst);
      let k = 0;
      for (const m of truth.moves) {
        if (m.end > fr.t) break;
        st = applyMove(st, m.move);
        k++;
      }
      const ids = stickerIds(st);
      const prevIds = k > 0 ? stickerIds(truth.moves.slice(0, k - 1).reduce((s: CubeState, m) => applyMove(s, m.move), Uint8Array.from(tst))) : ids;
      const nextIds = k < truth.moves.length ? stickerIds(applyMove(st, truth.moves[k].move)) : ids;
      let best = { o: 0, bad: Infinity };
      for (let o = 0; o < 24; o++) {
        let bad = 0;
        for (const f of fr.faces) for (let c = 0; c < 9; c++) if ((f.ids?.[c] ?? -1) >= 0 && ids[VIEW[(o * 6 + f.slot) * 9 + c]] !== f.ids![c]) bad++;
        if (bad < best.bad) best = { o, bad };
      }
      const bad: string[] = [];
      let n = 0;
      for (const f of fr.faces)
        for (let c = 0; c < 9; c++) {
          const id = f.ids?.[c] ?? -1;
          if (id < 0) continue;
          n++;
          const fl = VIEW[(best.o * 6 + f.slot) * 9 + c];
          if (ids[fl] !== id) bad.push(`${f.slot}.${c} ${id}/${ids[fl]}${prevIds[fl] === id ? "<" : nextIds[fl] === id ? ">" : ""}`);
        }
      const turning = truth.moves.find((m) => m.start <= fr.t && m.end > fr.t);
      out.push(`  F ${(fr.t / 1000).toFixed(3)} 手 ${k}${turning ? `（${MOVE_NAMES[turning.move]} を回している）` : ""} 読めた ${n}・食い違い ${bad.length}: ${bad.join(" ")}`);
    }
  }
  if (process.env.RS_LIST)
    for (const c of r.changes) out.push(`  ${c.at}: ${names(c.before)} → ${names(c.after) || "（なし）"}（${c.gain.toFixed(1)}）`);
  console.log(out.join("\n"));
}, 3600000);
