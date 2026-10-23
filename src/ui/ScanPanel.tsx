// 6面スキャンの進行・結果の確認と修正
import { controller, displayColors } from "../app/controller";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import { labCss } from "../vision/color";
import { problemMessages } from "../scan/scan";
import { NetView } from "./NetView";

export function ScanPanel() {
  const scan = useStore(controller.store, (s) => s.scan);
  const scheme = useStore(settingsStore, (s) => s.scheme);
  if (!scan) return null;

  if (scan.result && scan.edited) {
    const colors = displayColors(scan.result.refs, scan.result.names, scheme);
    const problems = scan.problems ?? [];
    const problemFacelets = new Set(problems.flatMap((p) => ("facelets" in p ? p.facelets : [])));
    return (
      <div>
        <div class={`status-banner ${problems.length ? "bad" : "ok"}`}>
          <strong>{problems.length ? "読み取りに矛盾があります" : "スキャン完了"}</strong>
          {problems.length ? "色が違うマスをタップして直すか、その面をもう一度スキャンしてください。" : "展開図を確認して「この状態で追跡開始」を押してください。違うマスはタップで色を変えられます。"}
          {scan.result.autoFixed && !problems.length && <div class="small">見せた向きがずれていた面を自動で補正しました。</div>}
        </div>
        {scan.result.colorWarning && <div class="status-banner warn">{scan.result.colorWarning}</div>}
        <NetView state={scan.edited} colors={colors} problemFacelets={problemFacelets} onCell={(f) => controller.editScanCell(f)} />
        {problems.length > 0 && (
          <ul class="problems">
            {problemMessages(problems, scan.result.names).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
        <div class="btn-row" style={{ marginTop: 12 }}>
          <button class="btn primary" disabled={problems.length > 0} onClick={() => controller.confirmScan()}>
            この状態で追跡開始
          </button>
          <button class="btn" onClick={() => controller.retakeFace(0)}>
            最初からスキャン
          </button>
          <button class="btn" onClick={() => controller.cancelScan()}>
            キャンセル
          </button>
        </div>
        <div class="section">
          <h3>面ごとにやり直す</h3>
          <div class="btn-row">
            {scan.steps.map((s, i) => (
              <button class="btn small" key={i} onClick={() => controller.retakeFace(i)}>
                {s.title}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const step = scan.steps[scan.step];
  const partial: (string | null)[] = new Array(54).fill(null);
  for (const c of scan.captured) c.labs.forEach((lab, i) => (partial[c.face * 9 + i] = labCss(lab)));
  return (
    <div>
      <div class="steps">
        {scan.steps.map((_, i) => (
          <div key={i} class={`s ${i < scan.step ? "done" : i === scan.step ? "active" : ""}`} />
        ))}
      </div>
      <div class="muted small">
        {scan.step + 1} / 6 ・ {step.title}
      </div>
      <div class="instruction">{step.instruction}</div>
      <div class="progress" aria-label="取り込みの進み具合">
        <div style={{ width: `${Math.round(scan.progress * 100)}%` }} />
      </div>
      <p class="muted small">
        面が枠で囲まれ、少しの間止めると自動で取り込みます。手はキューブの横を持ち、ステッカーを隠さないでください。
      </p>
      <NetView state={null} colors={[]} partial={partial} />
      <div class="btn-row">
        {scan.step > 0 && (
          <button class="btn small" onClick={() => controller.retakeFace(scan.step - 1)}>
            1つ前をやり直す
          </button>
        )}
        <button class="btn small" onClick={() => controller.cancelScan()}>
          キャンセル
        </button>
      </div>
    </div>
  );
}
