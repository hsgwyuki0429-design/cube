import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [
    preact(),
    ...(mode === "lan" ? [basicSsl()] : []),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "CubeVision — カメラでキューブ追跡",
        short_name: "CubeVision",
        description: "カメラ1つで、手持ちのルービックキューブの回転を追跡して画面に再現します。",
        lang: "ja",
        theme_color: "#10131a",
        background_color: "#10131a",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        // いちばん大きいのは OpenCV.js の SIMD 版（約 4MB）。ArUco の画面の解析 Worker も同じファイルを読む
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: "es" },
  // cubing.js のソルバーは自前の Worker で動く。プリロード補助コードがメインのチャンクから
  // 読み込まれると Worker 内で document を参照して落ちるので、注入しない
  // aruco.html は本体の ArUco の画面へ移動するだけのページ（以前の検証ページの URL を残す）
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 16000,
    modulePreload: false,
    rollupOptions: { input: { main: resolve(root, "index.html"), aruco: resolve(root, "aruco.html") } },
  },
  optimizeDeps: { exclude: ["cubing"] },
  server: { host: mode === "lan" ? true : undefined },
}));
