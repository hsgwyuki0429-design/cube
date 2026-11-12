// 解析中に落ちたときの備え。iPhone の Safari はメモリが足りなくなるとタブごと落として読み込み直すので、落ちた場所は JS からは
// 分からない。解析の段階ごとに端末に印を残し（落ちずに終わったら消す）、読み込んだときに印が残っていれば「その段階で落ちた」と分かる
// （画面に出す）。以前は落ちたら次から精密解析を軽く（候補を半分・橋渡しなし）していたが、録画の画質の実物のソルブで、軽い設定では
// 4 本のうち 3 本が完成までつながらず「速報値」のまま終わっていた。落ちた原因（全観測の橋渡しの表・増え続けたソルバーの Worker）は
// 直したので、軽くするのはやめた。閉じた・移動した（pagehide）ときは印を消すので、落ちたとき以外には数えない
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
const SAFE = "cubevision.safeAnalysis"; // 以前の「軽さ」（読み込んだときに消す）
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

// 読み込んだとき: 前回は解析の途中で落ちたか（落ちていれば、その段階）
export function checkLastRun(now = Date.now()): { phase: AnalysisPhase } | null {
  const c = read<{ phase: AnalysisPhase; at: number }>(CRUMB);
  write(CRUMB, null);
  write(SAFE, null);
  if (!c || !(c.phase in PHASE_LABEL) || !(now - c.at < MAX_AGE_MS)) return null;
  return { phase: c.phase };
}
