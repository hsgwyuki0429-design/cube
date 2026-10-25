import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { type Plugin, defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const root = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = resolve(root, "node_modules/@mediapipe/tasks-vision/wasm");
const WASM_FILES = ["vision_wasm_module_internal.js", "vision_wasm_module_internal.wasm"];
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_CACHE = resolve(root, "node_modules/.cache/cubevision/hand_landmarker.task");

// 手の検出モデルを（取れれば）手元にキャッシュする。取れなくても実行時に CDN から読む
async function ensureModel(): Promise<boolean> {
  if (existsSync(MODEL_CACHE)) return true;
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) return false;
    mkdirSync(dirname(MODEL_CACHE), { recursive: true });
    writeFileSync(MODEL_CACHE, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

// MediaPipe の wasm とモデルを /mediapipe/ 以下で配信（開発時）・出力（ビルド時）する
function mediapipeAssets(): Plugin {
  return {
    name: "cubevision-mediapipe-assets",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (url.startsWith("/mediapipe/wasm/")) {
          const file = url.slice("/mediapipe/wasm/".length);
          if (!WASM_FILES.includes(file)) return next();
          res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          createReadStream(join(WASM_DIR, file)).pipe(res);
          return;
        }
        if (url === "/mediapipe/hand_landmarker.task") {
          if (!(await ensureModel())) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/octet-stream");
          createReadStream(MODEL_CACHE).pipe(res);
          return;
        }
        next();
      });
    },
    async generateBundle() {
      for (const file of WASM_FILES) this.emitFile({ type: "asset", fileName: `mediapipe/wasm/${file}`, source: readFileSync(join(WASM_DIR, file)) });
      if (await ensureModel()) this.emitFile({ type: "asset", fileName: "mediapipe/hand_landmarker.task", source: readFileSync(MODEL_CACHE) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [
    preact(),
    mediapipeAssets(),
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
        // 手の検出（約21MB）は任意機能なので、最初に使ったときにキャッシュする
        // ArUco の検証ページ（OpenCV.js を自前の Worker に持つ）もアプリの利用者には要らないので入れない
        globIgnores: ["mediapipe/**", "**/hands.worker-*.js", "**/aruco.worker-*.js", "aruco.html", "**/aruco-*.js", "**/aruco-*.css"],
        // 本体の Service Worker は画面の移動を index.html で返す。検証ページへの移動は横取りしない
        navigateFallbackDenylist: [/aruco\.html$/],
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/mediapipe/") || /hands\.worker-/.test(url.pathname),
            handler: "CacheFirst",
            options: { cacheName: "mediapipe-local", expiration: { maxEntries: 8 } },
          },
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/mediapipe-models\//,
            handler: "CacheFirst",
            options: { cacheName: "mediapipe-models", expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
  worker: { format: "es" },
  // cubing.js のソルバーは自前の Worker で動く。プリロード補助コードがメインのチャンクから
  // 読み込まれると Worker 内で document を参照して落ちるので、注入しない
  // aruco.html は色付き ArUco ステッカーの検証ページ（src/aruco）
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 16000,
    modulePreload: false,
    rollupOptions: { input: { main: resolve(root, "index.html"), aruco: resolve(root, "aruco.html") } },
  },
  optimizeDeps: { exclude: ["cubing"] },
  server: { host: mode === "lan" ? true : undefined },
}));
