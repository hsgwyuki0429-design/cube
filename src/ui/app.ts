/**
 * フェーズ0 検証ハーネス本体。
 *
 * 責務は「配線」のみ。アルゴリズムは core/ と vision/ の純粋モジュールに置き、
 * ここには入れない（リプレイと回帰テストが同じコードを通るようにするため）。
 */

import { el, section, slider, fmt } from './dom';
import { Overlay, type OverlayCellData } from './overlay';
import { attachRoiEditor } from './roiEditor';
import { Rolling } from './metrics';
import { Camera } from '../vision/camera';
import {
  cellSamplePoints, loadRois, saveRois, defaultRois, validateRoi,
  DEFAULT_SAMPLES_PER_AXIS, type RoiConfig,
} from '../vision/roi';
import { FACE_NAMES, type FaceIndex } from '../core/cube';
import type { FrameSample, WorkerRequest, WorkerResponse } from '../vision/types';

export class App {
  private stage!: HTMLElement;
  private panel!: HTMLElement;
  private overlay = new Overlay();
  private camera = new Camera();
  private worker: Worker | null = null;

  private rois: RoiConfig[] = loadRois();
  private procWidth = 480;
  private samplesPerAxis = DEFAULT_SAMPLES_PER_AXIS;
  private idealFps = 120;
  private resizeOnCapture = false;

  private running = false;
  private busy = false;
  private seq = 0;
  private tStart = 0;
  private lastFrame: FrameSample | null = null;
  private skippedFrames = 0;

  private captureMs = new Rolling(120);
  private procMs = new Rolling(120);
  private latencyMs = new Rolling(120);
  private procFpsTimes: number[] = [];

  private showRaw = true;
  private showGrid = true;
  private editor!: ReturnType<typeof attachRoiEditor>;

  private cameraStatsEl!: HTMLElement;
  private perfStatsEl!: HTMLElement;
  private cellsEl!: HTMLElement;
  private logEl!: HTMLElement;
  private deviceSelect!: HTMLSelectElement;

  constructor(private root: HTMLElement) {}

  // -------------------------------------------------------------------------
  // 起動
  // -------------------------------------------------------------------------

  init(): void {
    this.buildLayout();
    this.startWorker();
    this.pushConfig();
    requestAnimationFrame(this.renderLoop);
    this.log('起動。[カメラ開始] を押してください。HTTPS または localhost が必要です。');
  }

  private buildLayout(): void {
    this.stage = el('div', { class: 'stage', style: { aspectRatio: '16 / 9' } });
    this.stage.appendChild(this.camera.video);
    this.stage.appendChild(this.overlay.canvas);

    this.panel = el('div', { class: 'panel' });
    this.root.appendChild(this.stage);
    this.root.appendChild(this.panel);

    this.panel.appendChild(this.buildCameraSection());
    this.panel.appendChild(this.buildRoiSection());
    this.panel.appendChild(this.buildRawSection());
    this.panel.appendChild(this.buildLogSection());

    this.editor = attachRoiEditor(
      this.overlay.canvas,
      () => this.rois,
      (final) => {
        this.pushConfig();
        if (final) saveRois(this.rois);
      },
    );
    window.addEventListener('resize', () => this.overlay.resize());
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  private startWorker(): void {
    this.worker = new Worker(new URL('../vision/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'error') {
        this.log(`worker error: ${msg.message}`, 'bad');
        this.busy = false;
        return;
      }
      if (msg.type === 'result') this.onFrameResult(msg.frame);
    };
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  /** ROI 設定が変わるたびにサンプリング点を作り直して Worker に送る。 */
  private pushConfig(): void {
    const rois = this.rois
      .filter((r) => r.enabled)
      .map((r) => {
        try {
          return { samples: cellSamplePoints(r, this.samplesPerAxis), samplesPerAxis: this.samplesPerAxis };
        } catch {
          return { samples: new Float32Array(9 * this.samplesPerAxis ** 2 * 2), samplesPerAxis: this.samplesPerAxis };
        }
      });
    this.post({ type: 'config', rois, procWidth: this.procWidth });
  }

  /** enabled な ROI のインデックス（Worker 側の並びと対応させる） */
  private activeRoiIndices(): number[] {
    const out: number[] = [];
    this.rois.forEach((r, i) => { if (r.enabled) out.push(i); });
    return out;
  }

  // -------------------------------------------------------------------------
  // フレームループ
  // -------------------------------------------------------------------------

  private async startCamera(): Promise<void> {
    try {
      await this.camera.start({
        idealFps: this.idealFps,
        deviceId: this.deviceSelect.value || undefined,
        facingMode: 'environment',
      });
    } catch (e) {
      this.log(`カメラ取得失敗: ${e instanceof Error ? e.message : String(e)}`, 'bad');
      return;
    }
    const st = this.camera.stats();
    this.stage.style.aspectRatio = `${st.width} / ${st.height}`;
    this.overlay.resize();
    this.log(`カメラ開始 ${st.width}x${st.height} / negotiated ${st.negotiatedFps ?? '?'}fps / rVFC=${st.usingVideoFrameCallback}`, 'ok');
    if (!st.usingVideoFrameCallback) {
      this.log('requestVideoFrameCallback が無いため rAF フォールバック。実測fpsは表示レートに縛られる。', 'warn');
    }
    await this.refreshDevices();
    this.tStart = performance.now();
    this.seq = 0;
    this.running = true;
    this.camera.onFrame(() => this.onCameraFrame());
    this.camera.startLoop();
  }

  private stopCamera(): void {
    this.running = false;
    this.camera.stop();
    this.log('カメラ停止');
  }

  private async onCameraFrame(): Promise<void> {
    if (!this.running || !this.camera.ready) return;
    if (this.busy) {
      // 認識が追いつかないフレームは落とす。落とした数は必ず出す。
      this.skippedFrames++;
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      // キャプチャ時縮小: GPU があるとビットマップ転送と Worker 側 drawImage が軽くなるが、
      // ソフトウェアレンダリング環境では逆に重くなる（実測済み）。端末ごとに測って決める。
      let bitmap: ImageBitmap;
      if (this.resizeOnCapture) {
        const vw = this.camera.video.videoWidth;
        const vh = this.camera.video.videoHeight;
        const rw = Math.min(vw, this.procWidth);
        bitmap = await createImageBitmap(this.camera.video, {
          resizeWidth: rw,
          resizeHeight: Math.max(1, Math.round((vh * rw) / vw)),
          resizeQuality: 'low',
        });
      } else {
        bitmap = await createImageBitmap(this.camera.video);
      }
      this.captureMs.push(performance.now() - t0);
      this.post({ type: 'frame', seq: this.seq++, t: t0 - this.tStart, bitmap }, [bitmap]);
    } catch (e) {
      this.busy = false;
      this.log(`frame capture 失敗: ${e instanceof Error ? e.message : String(e)}`, 'bad');
    }
  }

  private onFrameResult(frame: FrameSample): void {
    this.busy = false;
    this.lastFrame = frame;
    this.procMs.push(frame.procMs);
    this.latencyMs.push(performance.now() - this.tStart - frame.t);
    const now = performance.now();
    this.procFpsTimes.push(now);
    while (this.procFpsTimes.length > 2 && now - this.procFpsTimes[0] > 1000) this.procFpsTimes.shift();
  }

  private get processedFps(): number {
    const n = this.procFpsTimes.length;
    if (n < 2) return 0;
    const span = this.procFpsTimes[n - 1] - this.procFpsTimes[0];
    return span > 0 ? ((n - 1) * 1000) / span : 0;
  }

  // -------------------------------------------------------------------------
  // 描画ループ（認識ループとは独立）
  // -------------------------------------------------------------------------

  private renderLoop = (): void => {
    this.overlay.resize();
    const active = this.activeRoiIndices();
    const cells: (OverlayCellData | null)[] = this.rois.map(() => null);
    if (this.lastFrame) {
      active.forEach((roiIdx, k) => {
        const s = this.lastFrame!.rois[k];
        if (s) cells[roiIdx] = { rgb: s.rgb, labels: null, conf: null };
      });
    }
    this.overlay.draw({
      rois: this.rois,
      cells,
      palette: null,
      confThreshold: 0,
      showRaw: this.showRaw,
      showGrid: this.showGrid,
      hoverCorner: this.editor?.hover ?? null,
      candidates: [],
      status: this.running ? 'CAPTURING' : 'IDLE',
      moveLog: [],
    });
    this.updateStats();
    requestAnimationFrame(this.renderLoop);
  };

  private statsTick = 0;
  private updateStats(): void {
    if (this.statsTick++ % 10 !== 0) return;
    const st = this.camera.stats();
    const warn = (ok: boolean, s: string) => `<span class="${ok ? 'ok' : 'bad'}">${s}</span>`;
    this.cameraStatsEl.innerHTML = `
      <table class="kv">
        <tr><td>解像度</td><td>${st.width}x${st.height}</td></tr>
        <tr><td>要求fps</td><td>${st.requestedFps}</td></tr>
        <tr><td>折衝fps</td><td>${st.negotiatedFps ?? '-'}</td></tr>
        <tr><td>実測fps(カメラ)</td><td>${warn(st.presentedFps >= 60, fmt(st.presentedFps))}</td></tr>
        <tr><td>実測fps(コールバック)</td><td>${fmt(st.callbackFps)}</td></tr>
        <tr><td>rVFC</td><td>${st.usingVideoFrameCallback ? 'yes' : 'no (rAF)'}</td></tr>
        <tr><td>取りこぼし(カメラ)</td><td>${st.droppedFrames}</td></tr>
      </table>`;
    const total = this.captureMs.mean + this.procMs.mean;
    this.perfStatsEl.innerHTML = `
      <table class="kv">
        <tr><td>処理fps</td><td>${fmt(this.processedFps)}</td></tr>
        <tr><td>capture ms</td><td>${fmt(this.captureMs.mean, 2)}</td></tr>
        <tr><td>worker ms</td><td>${fmt(this.procMs.mean, 2)}</td></tr>
        <tr><td>合計 ms</td><td><span class="${total <= 16 ? 'ok' : 'bad'}">${fmt(total, 2)}</span></td></tr>
        <tr><td>p95 worker ms</td><td>${fmt(this.procMs.percentile(0.95), 2)}</td></tr>
        <tr><td>end-to-end ms</td><td>${fmt(this.latencyMs.mean, 2)}</td></tr>
        <tr><td>認識スキップ</td><td>${this.skippedFrames}</td></tr>
      </table>`;
    this.renderRawCells();
  }

  private renderRawCells(): void {
    if (!this.lastFrame) return;
    const active = this.activeRoiIndices();
    this.cellsEl.replaceChildren(
      ...active.map((roiIdx, k) => {
        const s = this.lastFrame!.rois[k];
        const grid = el('div', { class: 'cells' });
        for (let i = 0; i < 9; i++) {
          const r = s.rgb[i * 3] | 0, g = s.rgb[i * 3 + 1] | 0, b = s.rgb[i * 3 + 2] | 0;
          grid.appendChild(
            el('div', { style: { background: `rgb(${r},${g},${b})` }, title: `L*a*b* ${s.lab[i * 3].toFixed(1)} ${s.lab[i * 3 + 1].toFixed(1)} ${s.lab[i * 3 + 2].toFixed(1)}` }, [`${r},${g},${b}`]),
          );
        }
        return el('div', {}, [el('div', { class: 'dim' }, [`${this.rois[roiIdx].id} (${FACE_NAMES[this.rois[roiIdx].face]})`]), grid]);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // パネル
  // -------------------------------------------------------------------------

  private buildCameraSection(): HTMLElement {
    const { root, body } = section('カメラ');
    this.deviceSelect = el('select', { class: 'grow' }) as HTMLSelectElement;
    const startBtn = el('button', { class: 'primary', onclick: () => this.startCamera() }, ['カメラ開始']);
    const stopBtn = el('button', { onclick: () => this.stopCamera() }, ['停止']);
    this.cameraStatsEl = el('div');
    this.perfStatsEl = el('div');
    body.append(
      el('div', { class: 'row' }, [el('label', {}, ['デバイス']), this.deviceSelect]),
      el('div', { class: 'row' }, [
        startBtn, stopBtn,
        el('button', { onclick: () => this.refreshDevices() }, ['一覧更新']),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['要求fps']),
        ...[30, 60, 120, 240].map((f) =>
          el('button', {
            class: f === this.idealFps ? 'on' : '',
            onclick: (e: Event) => {
              this.idealFps = f;
              body.querySelectorAll('button').forEach((b) => {
                if (['30', '60', '120', '240'].includes(b.textContent ?? '')) b.classList.remove('on');
              });
              (e.target as HTMLElement).classList.add('on');
              this.log('要求fpsを変更。カメラを開始し直すと反映される。');
            },
          }, [String(f)]),
        ),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['キャプチャ']),
        el('button', {
          class: this.resizeOnCapture ? 'on' : '',
          onclick: (e: Event) => {
            this.resizeOnCapture = !this.resizeOnCapture;
            (e.target as HTMLElement).classList.toggle('on', this.resizeOnCapture);
            this.captureMs.clear();
            this.log(`キャプチャ時縮小: ${this.resizeOnCapture ? 'ON' : 'OFF'}（capture ms を見て速い方を選ぶ）`);
          },
        }, ['取得時に縮小']),
      ]),
      slider('処理解像度 幅', 160, 960, 40, this.procWidth, (v) => { this.procWidth = v; this.pushConfig(); }),
      slider('セル内サンプル', 2, 8, 1, this.samplesPerAxis, (v) => { this.samplesPerAxis = v; this.pushConfig(); }),
      this.cameraStatsEl,
      this.perfStatsEl,
    );
    return root;
  }

  private async refreshDevices(): Promise<void> {
    try {
      const cams = await Camera.listCameras();
      const cur = this.deviceSelect.value;
      this.deviceSelect.replaceChildren(
        el('option', { value: '' }, ['(自動: 背面カメラ)']),
        ...cams.map((c) => el('option', { value: c.deviceId }, [c.label || c.deviceId.slice(0, 12)])),
      );
      this.deviceSelect.value = cur;
    } catch { /* 権限前は列挙できない */ }
  }

  private buildRoiSection(): HTMLElement {
    const { root, body } = section('ROI（2枚）');
    const rebuild = () => {
      body.replaceChildren(
        el('div', { class: 'hint' }, [
          '四隅の丸をドラッグして面に合わせる。番号 0→1→2→3 が facelet の (0,0)→(0,2)→(2,2)→(2,0) に対応。' +
          ' 向きが合わないときは rot を回す。',
        ]),
        ...this.rois.map((r) => this.roiRow(r, rebuild)),
        el('div', { class: 'row' }, [
          el('button', { onclick: () => { this.rois = defaultRois(); saveRois(this.rois); this.pushConfig(); rebuild(); } }, ['初期位置に戻す']),
          el('button', {
            class: this.showRaw ? 'on' : '',
            onclick: (e: Event) => { this.showRaw = !this.showRaw; (e.target as HTMLElement).classList.toggle('on', this.showRaw); },
          }, ['生RGBで塗る']),
          el('button', {
            class: this.showGrid ? 'on' : '',
            onclick: (e: Event) => { this.showGrid = !this.showGrid; (e.target as HTMLElement).classList.toggle('on', this.showGrid); },
          }, ['グリッド']),
        ]),
      );
    };
    rebuild();
    return root;
  }

  private roiRow(r: RoiConfig, rebuild: () => void): HTMLElement {
    const err = validateRoi(r);
    const faceSel = el('select', {
      onchange: (e: Event) => { r.face = Number((e.target as HTMLSelectElement).value) as FaceIndex; saveRois(this.rois); },
    }, FACE_NAMES.map((n, f) => el('option', { value: String(f), selected: f === r.face }, [n]))) as HTMLSelectElement;
    faceSel.value = String(r.face);
    return el('div', { class: 'row' }, [
      el('label', {}, [r.id]),
      faceSel,
      el('button', { onclick: () => { r.rotate = ((r.rotate + 1) % 4) as 0 | 1 | 2 | 3; this.pushConfig(); saveRois(this.rois); rebuild(); } }, [`rot ${r.rotate}`]),
      el('button', { class: r.mirror ? 'on' : '', onclick: () => { r.mirror = !r.mirror; this.pushConfig(); saveRois(this.rois); rebuild(); } }, ['mirror']),
      el('button', { class: r.enabled ? 'on' : '', onclick: () => { r.enabled = !r.enabled; this.pushConfig(); saveRois(this.rois); rebuild(); } }, ['有効']),
      err ? el('span', { class: 'bad' }, [err]) : null,
    ]);
  }

  private buildRawSection(): HTMLElement {
    const { root, body } = section('セル生値（RGB / hover で Lab）');
    this.cellsEl = el('div', { class: 'row' });
    body.appendChild(this.cellsEl);
    return root;
  }

  private buildLogSection(): HTMLElement {
    const { root, body } = section('ログ');
    this.logEl = el('div', { class: 'log' });
    body.append(
      this.logEl,
      el('div', { class: 'row' }, [el('button', { onclick: () => (this.logEl.textContent = '') }, ['クリア'])]),
    );
    return root;
  }

  log(msg: string, cls = ''): void {
    const t = ((performance.now() - (this.tStart || performance.now())) / 1000).toFixed(1);
    this.logEl.appendChild(el('div', { class: cls }, [`[${t}s] ${msg}`]));
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
