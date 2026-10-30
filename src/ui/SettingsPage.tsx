import { useEffect } from "preact/hooks";
import { controller } from "../app/controller";
import { DEFAULT_SETTINGS, type Settings, settingsStore, updateSettings } from "../app/settings";
import { useStore } from "../app/store";
import { FrameRecorder } from "../vision/recorder";

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

function NumberInput<K extends keyof Settings>(props: { k: K; min: number; max: number; step: number }) {
  const v = useStore(settingsStore, (s) => s[props.k]) as number;
  return (
    <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input type="range" min={props.min} max={props.max} step={props.step} value={v} onInput={(e) => updateSettings({ [props.k]: Number((e.target as HTMLInputElement).value) } as Partial<Settings>)} />
      <span class="kbd">{v}</span>
    </span>
  );
}

export function SettingsPage() {
  const cameras = useStore(controller.store, (s) => s.cameras);
  const info = useStore(controller.store, (s) => s.cameraInfo);
  useEffect(() => {
    controller.refreshCameras();
  }, []);

  return (
    <div class="page">
      <h2>設定</h2>
      <div class="card">
        <div class="card-head">カメラ</div>
        <div class="card-body form">
          <Field label="カメラ" desc={info ? `使用中: ${info.label || "カメラ"}（${info.width}×${info.height}${info.frameRate ? `・${Math.round(info.frameRate)}fps` : ""}）` : undefined}>
            <Select k="cameraId" options={[["", "自動"], ...cameras.map((c) => [c.id, c.label] as [string, string])]} />
          </Field>
          <Field label="向き（自動のとき）">
            <Select k="facingMode" options={[["user", "インカメラ（自分側）"], ["environment", "背面カメラ"]]} />
          </Field>
          <Field label="解像度">
            <Select k="resolution" options={[[720, "720p（推奨）"], [1080, "1080p"]]} />
          </Field>
          <Field label="フレームレート" desc="速い回転（10手/秒前後）を追うには 60fps を推奨。実際の値は端末とカメラで決まり、画面上部に表示されます">
            <Select k="cameraFps" options={[[60, "60fps（推奨）"], [30, "30fps"]]} />
          </Field>
          <Field label="鏡像表示" desc="インカメラで自分を見るときは ON が自然です（認識には影響しません）">
            <Toggle k="mirror" />
          </Field>
          <div>
            <button class="btn small" onClick={() => controller.startCamera()}>
              この設定でカメラを再起動
            </button>
          </div>
        </div>
      </div>

      <div class="card" style={{ marginTop: 16 }}>
        <div class="card-head">キューブと表示</div>
        <div class="card-body form">
          <Field label="手順の表記" desc="持ち方基準: 今の持ち方で見た R/U など。センター色基準: 白=U、緑=F のように色で固定（スマートキューブと同じ）">
            <Select k="notation" options={[["relative", "持ち方基準"], ["absolute", "センター色基準"]]} />
          </Field>
          <Field label="持ち方基準の向き" desc="カメラが自分の方を向いている（インカメラ・PCのカメラ）なら「自分から見た向き」。R・U などの表記がこの向きで決まります">
            <Select k="viewpoint" options={[["user", "自分から見た向き"], ["camera", "カメラから見た向き"]]} />
          </Field>
          <Field label="3D キューブの向き" desc="カメラの映像と同じ傾き: 映っているキューブの角度にそのまま追従（鏡像表示なら 3D も鏡像）。自分から見た傾き: 手元で見えている側を同じ角度で表示">
            <Select k="cube3dView" options={[["camera", "カメラの映像と同じ傾きで追従"], ["user", "自分から見た傾きで追従"], ["fixed", "固定（標準の向き）"]]} />
          </Field>
          <Field label="インスペクション（15秒）">
            <Toggle k="inspection" />
          </Field>
          <Field
            label="録画を精密解析（追跡に反映）"
            desc={
              FrameRecorder.available()
                ? "映像を端末内に一時的に録画し、追跡を始めたときから全フレームを重い設定で1枚ずつ解き直して、追跡の手順を直します。完成したとき（タイマーでは止めたとき）は、完成を終わりとして前後から解き直し、タイムと手順を確定します。キューブが止まっている間に追いつきます（映像は保存も送信もしません）"
                : "このブラウザは録画（WebCodecs）に対応していないため、リアルタイムの結果だけを使います"
            }
          >
            <Toggle k="analyzeSolves" />
          </Field>
          <Field label="効果音">
            <Toggle k="sound" />
          </Field>
        </div>
      </div>

      <div class="card" style={{ marginTop: 16 }}>
        <div class="card-head">認識</div>
        <div class="card-body form">
          <Field
            label="ステッカー"
            desc="各ステッカーに貼った色付きの ArUco マーカーの種類（印刷用 PDF は docs/stickers/）。色を読まずにマーカーの ID でステッカーを判定するので、揃ったキューブならスキャンなしで始められます。切り替えると追跡をやめます"
          >
            <Select k="stickers" options={[["unique54", "54 種類・3×3・マスごとに違う（推奨）"], ["aruco12", "12 種類・3×3"], ["aruco", "54 種類・4×4・最初に印刷した版"]]} />
          </Field>
          <Field label="処理の解像度（長辺 px）" desc="映像の長辺をこの大きさに縮めて認識・精密解析します。大きいほど小さく映ったマーカーも読めますが重くなります">
            <NumberInput k="workWidth" min={960} max={1920} step={160} />
          </Field>
          <Field label="安定判定の時間（ms）" desc="層がそろって見える時間がこれ以上あれば読み取ります。短いほど速い回転に追従しますが、誤読が増えます（30fpsのカメラでは33で1フレーム）">
            <NumberInput k="stableMs" min={15} max={120} step={1} />
          </Field>
          <Field label="1回の観測で探す最大手数" desc="観測と観測の間に進んだかもしれない手数。速く回す人は 3〜4（4 は重くなります）">
            <NumberInput k="maxMovesPerStep" min={1} max={4} step={1} />
          </Field>
          <Field label="ビーム幅（仮説の数）">
            <NumberInput k="beamWidth" min={8} max={96} step={8} />
          </Field>
          <Field label="持ち替えのコスト" desc="大きいほど「持ち替え」より「回した」と解釈しやすくなります">
            <NumberInput k="rotationCost" min={0.5} max={4} step={0.25} />
          </Field>
          <Field label="デバッグ表示" desc="検出したマーカーの四角形と処理時間を映像に重ねます">
            <Toggle k="debug" />
          </Field>
          <div class="btn-row">
            <button
              class="btn small"
              onClick={() => {
                const { workWidth, stableMs, maxMovesPerStep, beamWidth, rotationCost, debug } = DEFAULT_SETTINGS;
                settingsStore.set({ workWidth, stableMs, maxMovesPerStep, beamWidth, rotationCost, debug });
              }}
            >
              認識設定を初期値に戻す
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
