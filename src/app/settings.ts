// 設定（localStorage に保存）
import type { Scheme } from "../scan/scan";
import { createStore } from "./store";

export interface Settings {
  cameraId: string;
  facingMode: "user" | "environment";
  resolution: 720 | 1080;
  mirror: boolean; // プレビューを鏡像表示（インカメラ向け）
  scheme: Scheme;
  notation: "relative" | "absolute"; // 持ち方基準 / 色（センター）基準
  viewpoint: "user" | "camera"; // 3D 表示を自分から見た向きにするか、カメラから見た向きにするか
  follow: boolean; // 3D をキューブの向きに追従させる
  detection: "auto" | "guide";
  handMask: boolean;
  debug: boolean;
  inspection: boolean;
  sound: boolean;
  workWidth: number;
  beamWidth: number;
  maxMovesPerStep: number;
  stableFrames: number;
  rotationCost: number;
  maxColorDistance: number;
}

export const DEFAULT_SETTINGS: Settings = {
  cameraId: "",
  facingMode: "user",
  resolution: 720,
  mirror: true,
  scheme: "standard",
  notation: "relative",
  viewpoint: "user",
  follow: true,
  detection: "auto",
  handMask: true,
  debug: false,
  inspection: true,
  sound: true,
  workWidth: 800,
  beamWidth: 32,
  maxMovesPerStep: 2,
  stableFrames: 3,
  rotationCost: 1.5,
  maxColorDistance: 32,
};

const KEY = "cubevision.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // 保存領域が使えない（プライベートモードなど）
  }
  return { ...DEFAULT_SETTINGS };
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
