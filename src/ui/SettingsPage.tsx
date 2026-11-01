import { useEffect, useRef } from "preact/hooks";
import { controller } from "../app/controller";
import { type Settings, settingsStore, updateSettings } from "../app/settings";
import { useStore } from "../app/store";
import { HelpPage } from "./HelpPage";

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

export function SettingsPage() {
  const info = useStore(controller.store, (s) => s.cameraInfo);
  const facing = useStore(settingsStore, (s) => s.facingMode);
  // カメラを変えたら、動いているカメラをそのまま切り替える
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (controller.store.get().camera === "on" && !controller.store.get().demo) void controller.startCamera();
  }, [facing]);

  return (
    <div class="page settings">
      <h2>設定</h2>
      <div class="card">
        <div class="card-head">カメラ</div>
        <div class="card-body form">
          <Field label="使うカメラ" desc={info ? `使用中: ${info.label || "カメラ"}（${info.width}×${info.height}${info.frameRate ? `・${Math.round(info.frameRate)}fps` : ""}）。インカメラは鏡像で映します` : "インカメラは鏡像で映します"}>
            <Select k="facingMode" options={[["user", "インカメラ（自分側）"], ["environment", "背面カメラ"]]} />
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
        </div>
      </div>
      <details class="help-details" id="help">
        <summary>使い方</summary>
        <HelpPage />
      </details>
    </div>
  );
}
