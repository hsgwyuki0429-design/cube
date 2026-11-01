// cubing.js のソルバー／スクランブル生成を専用 Worker で動かす。
// メインのバンドルに含めると、cubing.js 内部の Worker がアプリ本体のチャンク（DOM を触る）を
// 読み込んでしまい起動に失敗するため、ここで依存関係を切り離す。
import { Alg } from "cubing/alg";
import { KPattern, type KPatternData } from "cubing/kpuzzle";
import { cube3x3x3 } from "cubing/puzzles";
import { experimentalSolve3x3x3IgnoringCenters, setSearchDebug } from "cubing/search";
import { randomScrambleForEvent } from "cubing/scramble";
import { solveXCross } from "./xcross";

// 既定ではスクランブルを先読みし続け、計測ログも出すので止める
setSearchDebug({ scramblePrefetchLevel: "none", logPerf: false });

type Req = { id: number; type: "solve"; data: KPatternData } | { id: number; type: "scramble" } | { id: number; type: "xcross"; state: number[]; face: number };

// ビルドすると、cubing.js の探索の Worker（search-worker-entry）がこのファイルのまとまりを読み込むことがある（共通の部品が
// ここに入る）。そのときこの受け口が探索の Worker の中でも動き、cubing.js 自身のメッセージ（comlink）を「スクランブルを作る」と
// 受け取って、また探索の Worker を作り…と Worker が際限なく増え、iPhone ではメモリが尽きてタブごと落ちた（30 秒で 20 個）。
// この Worker（名前で見分ける）の中だけで、自分の形のメッセージだけを受ける
const SOLVER_WORKER_NAME = "cubevision-solver"; // solver.ts と同じ
const isRequest = (m: unknown): m is Req =>
  !!m && typeof m === "object" && typeof (m as Req).id === "number" && ["solve", "scramble", "xcross"].includes((m as Req).type);

if ((self as unknown as { name?: string }).name === SOLVER_WORKER_NAME) self.addEventListener("message", (e: MessageEvent) => void handle(e));

async function handle(e: MessageEvent) {
  if (!isRequest(e.data)) return;
  const msg = e.data;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    if (msg.type === "solve") {
      const kpuzzle = await cube3x3x3.kpuzzle();
      const alg = await experimentalSolve3x3x3IgnoringCenters(new KPattern(kpuzzle, msg.data));
      post({ id: msg.id, result: alg.toString() });
    } else if (msg.type === "xcross") {
      post({ id: msg.id, result: JSON.stringify(solveXCross(Uint8Array.from(msg.state), msg.face)) });
    } else {
      const alg: Alg = await randomScrambleForEvent("333");
      post({ id: msg.id, result: alg.toString() });
    }
  } catch (err) {
    post({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
}
