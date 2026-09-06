import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia は HTTPS または localhost が必須。
// スマホ実機テストは `npm run dev:lan` で LAN 公開 + 自己署名 HTTPS。
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  worker: { format: 'es' },
});
