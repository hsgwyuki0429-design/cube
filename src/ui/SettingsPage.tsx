import { useEffect, useRef, useState } from "preact/hooks";
import { resetSafeLevel, safeLevel } from "../app/crashGuard";
import { controller } from "../app/controller";
import { type Settings, settingsStore, updateSettings } from "../app/settings";
import { useStore } from "../app/store";
import { HelpPage } from "./HelpPage";

// 前回の解析中にアプリが落ちたので、精密解析を軽く・止めている（src/app/crashGuard.ts）。ふつうに戻せる
function SafeAnalysis() {
  const [level, setLevel] = useState(safeLevel());
  if (!level) return null;
  return (
    <Field label="精密解析" desc="解析の途中でアプリが落ちたため、自動で切り替えました。戻して落ちるときは、またこの状態になります">
      <span class="muted small">{level >= 2 ? "止めています（タイムは速報値）" : "軽くしています"}</span>{" "}
      <button
        class="btn small"
        onClick={() => {
          resetSafeLevel();
          setLevel(0);
        }}
      >
        元に戻す
      </button>
    </Field>
  );
}

function Field(props: { label: string; desc?: string; children: preact.ComponentChildren }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <span>{props.children}</span>
      {props.desc && <span class="desc">{props.desc}</span>}
    </label>
  );
}

function Select<K extends keyof Settings>(props: { k: K; options: [Settings[K], string][] }) {
  const v = useStore(settingsStore, (s) => s[props.k]);
  return (
    <select
      value={String(v)}
      onChange={(e) => {
        const raw = (e.target as HTMLSelectElement).value;
        const opt = props.options.find(([o]) => String(o) === raw);
        if (opt) updateSettings({ [props.k]: opt[0] } as Partial<Settings>);
      }}
    >
      {props.options.map(([o, label]) => (
        <option value={String(o)} key={String(o)}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Toggle<K extends keyof Settings>({ k }: { k: K }) {
  const v = useStore(settingsStore, (s) => s[k]);
  return <input type="checkbox" checked={!!v} onChange={(e) => updateSettings({ [k]: (e.target as HTMLInputElement).checked } as Partial<Settings>)} />;
}

// 使うカメラ: 端末が持っているカメラ（前面・背面・超広角など）から選ぶ。名前の一覧はカメラを一度許可すると取れるので、
// それまではインカメラ / 背面の 2 つだけ
function CameraSelect() {
  const cameras = useStore(controller.store, (s) => s.cameras);
  const inUse = useStore(controller.store, (s) => s.cameraInfo?.deviceId ?? "");
  const cameraId = useStore(settingsStore, (s) => s.cameraId);
  const facing = useStore(settingsStore, (s) => s.facingMode);
  if (!cameras.length)
    return (
      <select value={facing} onChange={(e) => updateSettings({ cameraId: "", facingMode: (e.target as HTMLSelectElement).value as "user" | "environment" })}>
        <option value="user">インカメラ（自分側）</option>
        <option value="environment">背面カメラ</option>
      </select>
    );
  const value = cameras.some((c) => c.id === cameraId) ? cameraId : cameras.some((c) => c.id === inUse) ? inUse : "";
  return (
    <select value={value} onChange={(e) => updateSettings({ cameraId: (e.target as HTMLSelectElement).value })}>
      {!value && <option value="">自動</option>}
      {cameras.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

export function SettingsPage() {
  const info = useStore(controller.store, (s) => s.cameraInfo);
  const facing = useStore(settingsStore, (s) => s.facingMode);
  const cameraId = useStore(settingsStore, (s) => s.cameraId);
  useEffect(() => {
    controller.refreshCameras();
  }, []);
  // カメラを変えたら、動いているカメラをそのまま切り替える
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (controller.store.get().camera === "on" && !controller.store.get().demo) void controller.startCamera();
  }, [facing, cameraId]);

  return (
    <div class="page settings">
      <h2>設定</h2>
      <div class="card">
        <div class="card-head">カメラ</div>
        <div class="card-body form">
          <Field label="使うカメラ" desc={info ? `使用中: ${info.label || "カメラ"}（${info.width}×${info.height}${info.frameRate ? `・${Math.round(info.frameRate)}fps` : ""}）` : "カメラを一度許可すると、超広角などのカメラも選べます"}>
            <CameraSelect />
          </Field>
        </div>
      </div>

      <div class="card" style={{ marginTop: 12 }}>
        <div class="card-head">表示</div>
        <div class="card-body form">
          <Field label="手順の表記" desc="持ち方基準: いまの持ち方で見た R・U。色基準: 白 = U・緑 = F で固定">
            <Select k="notation" options={[["relative", "持ち方基準"], ["absolute", "色基準"]]} />
          </Field>
          <Field label="3D キューブの向き">
            <Select k="cube3dView" options={[["camera", "映っている傾きに追従"], ["fixed", "固定"]]} />
          </Field>
        </div>
      </div>

      <div class="card" style={{ marginTop: 12 }}>
        <div class="card-head">タイマー</div>
        <div class="card-body form">
          <Field label="インスペクション（15 秒）">
            <Toggle k="inspection" />
          </Field>
          <Field label="効果音">
            <Toggle k="sound" />
          </Field>
          <SafeAnalysis />
        </div>
      </div>
      <details class="help-details" id="help">
        <summary>使い方</summary>
        <HelpPage />
      </details>
    </div>
  );
}
