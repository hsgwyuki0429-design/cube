// 解析中に落ちたときの備え。iPhone の Safari はメモリが足りなくなるとタブごと落として読み込み直すので、落ちた場所は JS からは
// 分からない。解析の段階ごとに端末に印を残し（落ちずに終わったら消す）、読み込んだときに印が残っていれば「その段階で落ちた」と分かる。
// 落ちたら次から精密解析を軽くし（1: 候補を減らし、隠れた区間の橋渡しをしない）、それでも落ちたら止める（2: 速報値のまま）。
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

// 精密解析の軽さ: 0 = ふつう / 1 = 軽く / 2 = しない
export function safeLevel(): number {
  const v = read<number>(SAFE);
  return typeof v === "number" && v > 0 ? Math.min(2, v) : 0;
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
