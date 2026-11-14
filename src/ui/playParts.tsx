// プレイ画面の部品: 追跡の状態・始め方（揃った状態から / 6 面スキャン）
import { controller } from "../app/controller";
import { useStore } from "../app/store";

// カメラの実測 fps が低いと速い回転を取りこぼす（暗い場所ではカメラが露光を伸ばして fps が落ちる）
function FpsWarning() {
  const w = useStore(controller.store, (s) => s.camera === "on" && !s.demo && s.stats.camFps > 0 && s.stats.camFps < 20);
  if (!w) return null;
  return <div class="status-banner warn small">カメラの fps が低くなっています。部屋を明るくすると、速い回転も追いやすくなります。</div>;
}

export function TrackStatus() {
  return (
    <>
      <TrackStatusBanner />
      <FpsWarning />
    </>
  );
}

function TrackStatusBanner() {
  const t = useStore(controller.store, (s) => ({ status: s.track?.status ?? "tracking", solved: s.track?.solved ?? false, faces: s.stats.faces, has: !!s.track }));
  if (t.status === "lost")
    return (
      <div class="status-banner bad">
        <strong>見失いました</strong>
        読み取った色が、どの手順でも説明できなくなりました。キューブを止めて2面をカメラに見せてください。戻らないときは「再スキャン」か、揃えてから「完成状態にリセット」を押してください。
      </div>
    );
  if (t.status === "uncertain")
    return (
      <div class="status-banner warn">
        <strong>確認中…</strong>
        読み取りが少し合いません。キューブを一瞬止めて、正面と上面がよく見えるように持ってください。
      </div>
    );
  if (t.solved && t.has)
    return (
      <div class="status-banner ok">
        <strong>完成しています 🎉</strong>
        回すとそのまま追跡を続けます。
      </div>
    );
  return (
    <div class={`status-banner ${t.faces ? "ok" : "warn"}`}>
      <strong>{t.faces ? "追跡中" : "キューブを映してください"}</strong>
      {t.faces >= 2 ? "2面以上見えています（良い状態です）。" : t.faces === 1 ? "1面だけ見えています。少し上から映して上面も見えるようにすると精度が上がります。" : "カメラにキューブを向けてください。"}
    </div>
  );
}

export function StartCard() {
  const camera = useStore(controller.store, (s) => s.camera);
  return (
    <div class="start-card">
      <p class="small" style={{ margin: 0 }}>
        揃ったキューブならスキャンなしで始められます。揃っていなければ、6 面を見せるとその状態からスクランブルを出します。
      </p>
      <div class="btn-row">
        <button class="btn primary" disabled={camera !== "on"} onClick={() => controller.startFromSolved()}>
          揃った状態から開始
        </button>
        <button class="btn" disabled={camera !== "on"} onClick={() => controller.beginScan()}>
          6面スキャン
        </button>
      </div>
      <details class="tips">
        <summary class="small">うまく追跡するコツ</summary>
        <ul class="small muted">
          <li>カメラを少し上に置き、キューブの「正面」と「上面」の2面が映るようにする</li>
          <li>明るい場所で。強い反射や逆光は避ける</li>
          <li>キューブは画面の中央付近に。マーカーが小さすぎると読めません（マスの間隔が 40px 以上）</li>
          <li>最初はゆっくり（1秒に1〜2手）。慣れたら速く</li>
        </ul>
      </details>
    </div>
  );
}
