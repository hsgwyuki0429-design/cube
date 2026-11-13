// 設定（localStorage に保存）
import { createStore } from "./store";

export interface Settings {
  cameraId: string;
  facingMode: "user" | "environment";
  resolution: 720 | 1080;
  mirror: boolean; // プレビューを鏡像表示（インカメラ向け）
  notation: "relative" | "absolute"; // 持ち方基準 / 色（センター）基準
  viewpoint: "user" | "camera"; // 持ち方基準の表記を、自分から見た向きにするか、カメラから見た向きにするか
  cube3dView: "camera" | "user" | "fixed"; // 3D: カメラの映像と同じ傾きで追従 / 自分から見た傾きで追従 / 固定
  debug: boolean;
  inspection: boolean;
  sound: boolean;
  analyzeSolves: boolean; // 録画を追跡の開始から精密解析し、追跡に反映する（タイマーでは止めたときにタイムと手順を確定する）
  workWidth: number; // 認識・精密解析で映像の長辺を縮める大きさ（px）
  beamWidth: number;
  maxMovesPerStep: number;
  stableMs: number;
  cameraFps: number;
  rotationCost: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraId: "",
  facingMode: "user",
  resolution: 720,
  mirror: true,
  notation: "relative",
  viewpoint: "user",
  cube3dView: "camera",
  debug: false,
  inspection: true,
  sound: true,
  analyzeSolves: true,
  workWidth: 1280,
  beamWidth: 32,
  maxMovesPerStep: 3,
  stableMs: 33,
  cameraFps: 60,
  rotationCost: 1.5,
};

const KEY = "cubevision.settings.v1";

// 画面では選ばない（常に既定の値・カメラから決める）: 鏡像・持ち方基準の向き（使っているカメラの向きから: facingOf）・カメラの解像度・fps、精密解析、認識の調整、デバッグ表示
const FIXED: (keyof Settings)[] = ["mirror", "resolution", "cameraFps", "analyzeSolves", "workWidth", "beamWidth", "maxMovesPerStep", "stableMs", "rotationCost", "viewpoint", "debug"];
// デバッグ表示は URL に ?debug を付けたときだけ
const urlFlags = (): Partial<Settings> => (typeof location !== "undefined" && new URLSearchParams(location.search).has("debug") ? { debug: true } : {});

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // 旧版（高速回転対応前）の認識設定は新しい既定値に置き換える
      if (saved.stableMs === undefined) delete saved.maxMovesPerStep;
      delete saved.stableFrames;
      // 旧版の「3D をキューブの向きに合わせる」
      if (saved.follow === false && saved.cube3dView === undefined) saved.cube3dView = "fixed";
      delete saved.follow;
      // 普通の色のステッカー（色を読む認識）はなくした。ArUco マーカーの認識は長辺 1280 以上で読む
      if (saved.stickers === "color") delete saved.stickers;
      if (typeof saved.workWidth === "number" && saved.workWidth < 1280) delete saved.workWidth;
      // ステッカーは 54 種類（マスごとに違う）・4 個・幅 1/2 だけにした（STICKERS）
      for (const k of ["scheme", "detection", "handMask", "maxColorDistance", "stickers", "stickerDesign"]) delete saved[k];
      // 性能に関わる値は画面で選ばせず、いつも最適な値で動かす（以前に変えて保存された値も使わない）
      for (const k of FIXED) delete saved[k];
      // 3D の向きは「追従 / 固定」の 2 つにした
      if (saved.cube3dView === "user") saved.cube3dView = "camera";
      return { ...DEFAULT_SETTINGS, ...saved, ...urlFlags() };
    }
  } catch {
    // 保存領域が使えない（プライベートモードなど）
  }
  return { ...DEFAULT_SETTINGS, ...urlFlags() };
}

export const settingsStore = createStore<Settings>(load());

settingsStore.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても動作は続ける
  }
});

export const updateSettings = (patch: Partial<Settings>) => settingsStore.set(patch);

// 使っているカメラの向き: カメラが教える向き（facingMode）、なければ名前（「背面…」「前面…」など）、それもなければ頼んだ向き。
// インカメラ（自分側。向きが分からない PC のカメラも）なら、プレビューは鏡像・持ち方基準の表記は自分から見た向き（カメラの反対側）。
// 背面カメラは自分と同じ側からキューブを見るので、鏡像にせず、表記はカメラから見た向きのまま（自分から見た向きに固定していた間は、
// 背面カメラでスクランブルの案内の左右・前後が逆になっていた）
export function facingOf(info: { facingMode?: string; label?: string } | null, requested: Settings["facingMode"]): "user" | "environment" {
  if (info?.facingMode === "environment" || info?.facingMode === "user") return info.facingMode;
  const label = info?.label ?? "";
  if (/背面|後ろ|back|rear|environment/i.test(label)) return "environment";
  if (/前面|front|user|facetime/i.test(label)) return "user";
  return requested;
}
