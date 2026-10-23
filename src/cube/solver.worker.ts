// cubing.js のソルバー／スクランブル生成を専用 Worker で動かす。
// メインのバンドルに含めると、cubing.js 内部の Worker がアプリ本体のチャンク（DOM を触る）を
// 読み込んでしまい起動に失敗するため、ここで依存関係を切り離す。
import { Alg } from "cubing/alg";
import { KPattern, type KPatternData } from "cubing/kpuzzle";
import { cube3x3x3 } from "cubing/puzzles";
import { experimentalSolve3x3x3IgnoringCenters, setSearchDebug } from "cubing/search";
import { randomScrambleForEvent } from "cubing/scramble";

// 既定ではスクランブルを先読みし続け、計測ログも出すので止める
setSearchDebug({ scramblePrefetchLevel: "none", logPerf: false });

type Req = { id: number; type: "solve"; data: KPatternData } | { id: number; type: "scramble" };

self.onmessage = async (e: MessageEvent<Req>) => {
  const msg = e.data;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  try {
    if (msg.type === "solve") {
      const kpuzzle = await cube3x3x3.kpuzzle();
      const alg = await experimentalSolve3x3x3IgnoringCenters(new KPattern(kpuzzle, msg.data));
      post({ id: msg.id, result: alg.toString() });
    } else {
      const alg: Alg = await randomScrambleForEvent("333");
      post({ id: msg.id, result: alg.toString() });
    }
  } catch (err) {
    post({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
