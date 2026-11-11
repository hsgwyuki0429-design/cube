// scripts/wasm/thresh.wat → src/aruco/threshWasm.ts（base64 で埋め込む）。wabt は依存に入れていない:
//   npm i --no-save wabt && node scripts/wasm/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import wabtInit from "wabt";

const wabt = await wabtInit();
const src = readFileSync(new URL("./thresh.wat", import.meta.url)); // バイト列のまま渡す（文字列で渡すと日本語のコメントを読めない）
const mod = wabt.parseWat("thresh.wat", src, { simd: true, bulk_memory: true });
mod.validate();
const { buffer } = mod.toBinary({});
const b64 = Buffer.from(buffer).toString("base64");
const out = `// scripts/wasm/build.mjs が作る（手で直さない）。元は scripts/wasm/thresh.wat（二値化。WASM SIMD）
export const THRESH_WASM = "${b64}";
`;
writeFileSync(new URL("../../src/aruco/threshWasm.ts", import.meta.url), out);
console.log(`thresh.wasm ${buffer.length} bytes`);
