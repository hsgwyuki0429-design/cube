import { App } from './ui/app';

const app = new App(document.getElementById('app')!);
app.init();
// デバッグ用にコンソールから触れるようにしておく（フェーズ0）
(window as unknown as Record<string, unknown>).cv = app;
