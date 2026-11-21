// タイマーの開始・停止の判定を、実物の動画でライブが処理したフレームの読み（realVideo.debug.test.ts の REAL_READINGS。sight 付き）に
// 通し直して、前の判定（tests/debug/lib/oldTimer.ts）と今の判定（src/app/startDetect.ts・stopDetect.ts）を並べる。本当の手の時刻は
// 精密解析の結果（REAL_REF で書き出したもの）。ライブの追跡は本体と同じ設定で、インスペクションの始まりにスクランブルの状態から始める
// （本体ではスクランブルの状態に着いたときにインスペクションになる）。
//   TE_DIR=~/rv TE_SETS="4970:15:0,5046:15:10.10"（名前:fps:インスペクションの始まり（秒）。read-名前-fps.json・ref-名前.json）
//   TE_DUMP=1（開始・停止を決めたときの様子）・TE_MIN=10・TE_HOLD=200（今の停止の枚数・続く長さ）
// 出すもの（1 本ごと・合計）:
//   開始: 決めた時刻 − 本当の回し始め（遅れ。負 = 回す前に始めた: 間違って始まった）、開始の時刻の誤差
//   停止: 決めた時刻 − 本当の回し終わり（遅れ。負 = 間違って止まった）、止まらなかった。間違って止める判定の回数は、本当の最初の手を
//         回し終えてから最後の手の回し終わりまで判定を回し続け、止めると決めた回数（決めたらやり直す）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { type CubeState, applyMove } from "../../src/cube/model";
import { StartDetector } from "../../src/app/startDetect";
import { StopDetector } from "../../src/app/stopDetect";
import { TrackerEngine, type TrackUpdate } from "../../src/track/engine";
import type { FrameReading } from "../../src/track/observer";
import type { SightFrame } from "../../src/track/sight";
import { slotsPlausible } from "../../src/track/slotCheck";
import type { RefineResult } from "../../src/vision/refine";
import { OldStartDetector, OldStopDetector } from "./lib/oldTimer";
import { ARUCO_OBSERVER, LIVE_OBSERVER } from "../../src/track/observer";

// 本体のライブ（src/app/controller.ts の liveEngineOptions。liveReplay.debug.test.ts と同じ）
const liveEngineOptions = () => ({ observer: { ...ARUCO_OBSERVER, ...LIVE_OBSERVER }, decoder: { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5 }, snapToView: true, recover: true });

type Reading = FrameReading & { sight?: SightFrame };

interface Edge {
  decided: number | null; // 決めたフレームの時刻
  at: number | null; // 開始・停止の時刻
  note?: string;
}

// 判定の組: 開始は前・今、停止は「前（追跡 + 色）」「今（ID + 照らした追跡）」と、追跡に頼らない経路だけのもの
type StopKind = "old" | "neu" | "oldLook" | "neuId";
const KINDS: { kind: StopKind; label: string; start: "old" | "neu" }[] = [
  { kind: "old", label: "前", start: "old" },
  { kind: "neu", label: "今", start: "neu" },
  { kind: "oldLook", label: "前（色だけ）", start: "old" },
  { kind: "neuId", label: "今（ID だけ）", start: "neu" },
];
const TOL_STOP = 100; // 精密解析の回し終わりは画素で詰めた時刻なので、フレームの時刻がこれだけ前でも間違いにしない
const TOL_START = 50;

class Stopper {
  private oldS = new OldStopDetector();
  private newS = new StopDetector({ min: Number(process.env.TE_MIN) || undefined, holdMs: process.env.TE_HOLD ? Number(process.env.TE_HOLD) : undefined });
  constructor(readonly kind: StopKind) {}
  reset(): void {
    this.oldS.reset();
    this.newS.reset();
  }
  // 止めると決めたら止める時刻と経路
  push(t: number, sight: SightFrame | undefined, looks: boolean | undefined, u: TrackUpdate | null, status: string | undefined): { at: number; how: string } | null {
    const k = this.kind;
    const lastEnd = (x: TrackUpdate) => (x.moves.length ? x.moves[x.moves.length - 1].t : t);
    if (k === "old" || k === "oldLook") {
      const a = this.oldS.frame(t, looks, status);
      if (a !== null) return { at: a, how: "色" };
      if (k === "old" && u?.solved) return { at: lastEnd(u), how: "追跡" };
      return null;
    }
    const a = this.newS.frame(t, sight);
    if (a !== null) return { at: a, how: "ID" };
    if (k === "neu" && u?.solved && this.newS.trackedSolved(u.observation.t)) return { at: lastEnd(u), how: "追跡" };
    return null;
  }
}

it("タイマーの開始・停止（前の判定と今の判定）", () => {
  const dir = (process.env.TE_DIR ?? `${process.env.HOME}/rv`).replace(/^~/, process.env.HOME ?? "");
  const sets = (process.env.TE_SETS ?? "4970:15:0").split(",").map((s) => {
    const [name, fps, from] = s.split(":");
    return { name, fps, from: Number(from ?? 0) * 1000 };
  });
  const dump = !!process.env.TE_DUMP;
  const rows: string[] = [];
  const tot = Object.fromEntries(KINDS.map((k) => [k.kind, { early: 0, lateStart: [] as number[], startErr: [] as number[], falseStop: 0, noStop: 0, stopLag: [] as number[], wrongStop: 0 }]));
  for (const set of sets) {
    const rd = JSON.parse(readFileSync(`${dir}/read-${set.name}-${set.fps}.json`, "utf8")) as { start: number[]; readings: Reading[] };
    const ref = JSON.parse(readFileSync(`${dir}/ref-${set.name}.json`, "utf8")) as RefineResult;
    // インスペクションの始まりの状態（本当の手順で、その時刻までに回し終えた手）と、本当の回し始め・回し終わり
    let target: CubeState = Uint8Array.from(rd.start);
    let first = -1;
    for (let i = 0; i < ref.moves.length; i++) {
      const m = ref.moves[i];
      if (m.end <= set.from) target = applyMove(target, m.move);
      else if (first < 0 && m.start >= set.from - 50) first = i;
    }
    if (first < 0) throw new Error(`${set.name}: インスペクションの後に手がない`);
    const truthStart = ref.moves[first].start;
    const truthEnd = ref.moves[ref.moves.length - 1].end;
    const engine = new TrackerEngine(target, ARUCO_REFS, liveEngineOptions());
    const readyMoves = 0; // 追跡はインスペクションの始まりから
    const oldStart = new OldStartDetector();
    oldStart.reset(0);
    const newStart = new StartDetector();
    const start: Record<"old" | "neu", Edge> = { old: { decided: null, at: null }, neu: { decided: null, at: null } };
    const stops = KINDS.map((k) => ({ ...k, s: new Stopper(k.kind), probe: new Stopper(k.kind), edge: { decided: null, at: null } as Edge, wrong: 0, wrongAt: [] as string[] }));
    let last: TrackUpdate | null = null;
    for (const r of rd.readings) {
      if (r.t < set.from) continue;
      const sight = r.sight;
      // 本体の Worker と同じ: スロットがありえないフレームは追跡に何も見えなかったとして渡す
      const dropped = !!sight && r.faces.length > 0 && !slotsPlausible(sight);
      const reading: FrameReading = dropped ? { ...r, faces: [] } : r;
      const u = engine.push(reading);
      if (u) last = u;
      const looks = reading.faces.length ? engine.looksSolved(reading) : undefined;
      const status = last?.status;
      // ---- 開始 ----（本体と同じ順: フレームの見え方 → 追跡の更新）
      if (start.old.decided === null && u) {
        const at = oldStart.push(u, target, readyMoves);
        if (at !== null) start.old = { decided: r.t, at, note: `${u.moves.length - readyMoves} 手・確定 ${u.confirmed - readyMoves}・作り変え ${u.base?.n ?? 0}` };
      }
      if (start.neu.decided === null) {
        newStart.frame(r.t, sight, target);
        if (u) {
          const at = newStart.push(u, readyMoves);
          if (at !== null) start.neu = { decided: r.t, at, note: (u.timings ?? []).slice(readyMoves).map((x, i) => `${u.moves[readyMoves + i]?.move}${x?.moved ? "m" : ""}${x?.exact ? `@${((x.start - r.t) / 1000).toFixed(2)}` : `~${(((u.moves[readyMoves + i]?.t0 ?? r.t) - r.t) / 1000).toFixed(2)}`}`).join(" ") };
        }
      }
      // ---- 停止（それぞれの開始の後）と、間違って止める判定（本当の最初の手の回し終わりの 100ms 後から、最後の手の回し終わりの 100ms 前まで）----
      for (const x of stops) {
        const st = start[x.start];
        if (st.decided !== null && r.t > st.decided && x.edge.decided === null) {
          const e = x.s.push(r.t, sight, looks, u, status);
          if (e) x.edge = { decided: r.t, at: e.at, note: e.how };
        }
        if (r.t >= ref.moves[first].end + 100 && r.t < truthEnd - TOL_STOP) {
          const e = x.probe.push(r.t, sight, looks, u, status);
          if (e) {
            x.wrong++;
            x.wrongAt.push(`${(r.t / 1000).toFixed(2)}s${e.how}`);
            x.probe.reset();
          }
        }
      }
    }
    const f = (x: number | null) => (x === null ? "-" : `${x >= 0 ? "+" : ""}${(x / 1000).toFixed(2)}`);
    const line = [`${set.name}@${set.fps}`];
    for (const x of stops) {
      const s = start[x.start];
      const e = x.edge;
      const t = tot[x.kind];
      const sd = s.decided === null ? null : s.decided - truthStart;
      const ed = e.decided === null ? null : e.decided - truthEnd;
      if (sd !== null && sd < -TOL_START) t.early++;
      else if (sd !== null) t.lateStart.push(sd);
      if (s.at !== null) t.startErr.push(s.at - truthStart);
      if (e.decided === null) t.noStop++;
      else if (ed! < -TOL_STOP) t.falseStop++;
      else t.stopLag.push(ed!);
      t.wrongStop += x.wrong;
      const startPart = x.kind === "old" || x.kind === "neu" ? `開始 ${f(sd)}（時刻 ${f(s.at === null ? null : s.at - truthStart)}${s.note ? `・${s.note}` : ""}） ` : "";
      line.push(`${x.label}: ${startPart}停止 ${f(ed)}（時刻 ${f(e.at === null ? null : e.at - truthEnd)}${e.note ? `・${e.note}` : ""}） 間違い ${x.wrong}${dump && x.wrongAt.length ? `（${x.wrongAt.slice(0, 6).join(" ")}）` : ""}`);
    }
    rows.push(line.join(" | "));
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
  for (const k of KINDS) {
    const t = tot[k.kind];
    const startPart = k.kind === "old" || k.kind === "neu" ? `早く始まった ${t.early}/${sets.length}・始まるまでの遅れ 中央 ${(med(t.lateStart) / 1000).toFixed(2)}s 最大 ${(max(t.lateStart) / 1000).toFixed(2)}s・開始の時刻の誤差 中央 ${(med(t.startErr) / 1000).toFixed(2)}s 範囲 ${(Math.min(...t.startErr) / 1000).toFixed(2)}〜${(max(t.startErr) / 1000).toFixed(2)}s・` : "";
    rows.push(`${k.label}: ${startPart}間違って止まった ${t.falseStop}・止まらなかった ${t.noStop}・止まるまで 中央 ${(med(t.stopLag) / 1000).toFixed(2)}s 最大 ${(max(t.stopLag) / 1000).toFixed(2)}s・間違って止める判定 ${t.wrongStop}`);
  }
  console.log(rows.join("\n"));
}, 600000);
