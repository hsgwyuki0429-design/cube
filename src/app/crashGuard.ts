// 解析中に落ちたときの備え。iPhone の Safari はメモリが足りなくなるとタブごと落として読み込み直すので、落ちた場所は JS からは
// 分からない。解析の段階ごとに端末に印を残し（落ちずに終わったら消す）、読み込んだときに印が残っていれば「その段階で落ちた」と分かる。
// 落ちたら次から精密解析を軽くする（候補を減らし、隠れた区間の橋渡しをしない。2 回続けて落ちても解析はやめない: 以前は止めて
// いて、設定から戻すまでタイムが速報値のままだった）。落ちずに終わるたびに 1 段ずつ元に戻る。
// 設定の画面から元に戻せる。閉じた・移動した（pagehide）ときは印を消すので、落ちたとき以外には数えない
export type AnalysisPhase = "solving" | "finishing" | "flush" | "decode" | "timing" | "saving";

export const PHASE_LABEL: Record<AnalysisPhase, string> = {
  solving: "ソルブ中の解析",
  finishing: "止めた後の残りの解析",
  flush: "録画の読み込みの仕上げ",
  decode: "手順の解き直し",
  timing: "手の時刻の決定",
  saving: "結果の保存",
};

const CRUMB = "cubevision.analysisCrumb";
const SAFE = "cubevision.safeAnalysis";
const MAX_AGE_MS = 30 * 60 * 1000; // これより古い印は数えない（その後にアプリを使っていない）

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても動作は続ける
  }
}

// 解析の段階の印（null で消す）
export function markPhase(phase: AnalysisPhase | null): void {
  write(CRUMB, phase ? { phase, at: Date.now() } : null);
}

// 精密解析の軽さ: 0 = ふつう / 1・2 = 軽く（2 は 2 回続けて落ちた: 元に戻るまで 2 回かかる）
export function safeLevel(): number {
  const v = read<number>(SAFE);
  return typeof v === "number" && v > 0 ? Math.min(2, v) : 0;
}

// 解析が落ちずに終わった: 軽さを 1 段戻す（落ちた原因が一時的なもの（ほかのタブ・メモリの込み具合）なら、そのうち元に戻る）
export function noteAnalysisOk(): void {
  const level = safeLevel();
  if (level > 0) write(SAFE, level - 1 || null);
}

export function resetSafeLevel(): void {
  write(SAFE, null);
}

// 読み込んだとき: 前回は解析の途中で落ちたか（落ちていれば、その段階と新しい軽さ）
export function checkLastRun(now = Date.now()): { phase: AnalysisPhase; level: number } | null {
  const c = read<{ phase: AnalysisPhase; at: number }>(CRUMB);
  write(CRUMB, null);
  if (!c || !(c.phase in PHASE_LABEL) || !(now - c.at < MAX_AGE_MS)) return null;
  const level = Math.min(2, safeLevel() + 1);
  write(SAFE, level);
  return { phase: c.phase, level };
}
