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
  cellSamplePoints, loadRois, saveRois, defaultRois, validateRoi, makeRoi, MAX_ROIS,
  DEFAULT_SAMPLES_PER_AXIS, type RoiConfig,
} from '../vision/roi';
import { Tracker, defaultThresholds, type RoiObservation, type TrackerStep } from '../core/tracker';
import { FACE_NAMES, solvedState, applySequence, isSolved, type FaceIndex } from '../core/cube';
import {
  classifyCells, adaptRef, refMinDistance, FaceAccumulator, labToRgb,
  loadProfiles, saveProfiles, getActiveProfileId, setActiveProfileId,
  MIN_SEPARATION_WARN, MIN_SEPARATION_FAIL, type ColorProfile,
} from '../vision/color';
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

  private showRaw = false;
  private showGrid = true;

  // --- 色 ---
  private profiles: ColorProfile[] = loadProfiles();
  private activeProfile: ColorProfile | null = null;
  /** 実行中の代表ベクトル（EMA でここだけが動く。プロファイル本体は触らない） */
  private ref: Float32Array | null = null;
  private labels: Int8Array[] = [];
  private conf: Float32Array[] = [];
  private confThreshold = 0.15;
  private adaptOn = false;
  private adaptAlpha = 0.02;
  private adaptMinConf = 0.5;

  // --- キャリブレーション ---
  private calib: {
    active: boolean;
    roi: number;
    index: number;
    target: number;
    acc: FaceAccumulator;
    capturing: boolean;
    result: { lab: [number, number, number]; spread: number }[];
  } = { active: false, roi: 0, index: 0, target: 30, acc: new FaceAccumulator(), capturing: false, result: [] };

  // --- 追跡 ---
  private tracker = new Tracker(solvedState(), defaultThresholds());
  private tracking = false;
  private lastStep: TrackerStep | null = null;
  private moveLog: string[] = [];
  private trackerBody!: HTMLElement;
  private trackerStatsEl!: HTMLElement;

  // --- 色分類精度の集計 ---
  private accuracy = {
    running: false,
    t0: 0,
    frames: 0,
    cells: 0,
    matched: 0,
    faceMatched: 0,
    lowConf: 0,
    confSum: 0,
  };
  private editor!: ReturnType<typeof attachRoiEditor>;

  private cameraStatsEl!: HTMLElement;
  private perfStatsEl!: HTMLElement;
  private cellsEl!: HTMLElement;
  private colorBody!: HTMLElement;
  private accuracyEl!: HTMLElement;
  private logEl!: HTMLElement;
  private deviceSelect!: HTMLSelectElement;

  constructor(private root: HTMLElement) {}

  // -------------------------------------------------------------------------
  // 起動
  // -------------------------------------------------------------------------

  init(): void {
    const activeId = getActiveProfileId();
    this.setActiveProfile(this.profiles.find((p) => p.id === activeId) ?? this.profiles[0] ?? null, false);
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
    this.panel.appendChild(this.buildColorSection());
    this.panel.appendChild(this.buildTrackerSection());
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
    this.classifyFrame(frame);
    if (this.calib.active && this.calib.capturing) this.stepCalibration(frame);
    if (this.accuracy.running) this.accumulateAccuracy(frame);
    if (this.tracking) this.trackFrame(frame);
    this.procMs.push(frame.procMs);
    this.latencyMs.push(performance.now() - this.tStart - frame.t);
    const now = performance.now();
    this.procFpsTimes.push(now);
    while (this.procFpsTimes.length > 2 && now - this.procFpsTimes[0] > 1000) this.procFpsTimes.shift();
  }

  /** Worker が返した Lab を分類し、必要なら代表ベクトルを EMA 更新する。 */
  private classifyFrame(frame: FrameSample): void {
    const ref = this.ref;
    while (this.labels.length < frame.rois.length) {
      this.labels.push(new Int8Array(9));
      this.conf.push(new Float32Array(9));
    }
    for (let i = 0; i < frame.rois.length; i++) {
      if (!ref) {
        this.labels[i].fill(-1);
        this.conf[i].fill(0);
        continue;
      }
      classifyCells(frame.rois[i].lab, ref, this.labels[i], this.conf[i]);
      if (this.adaptOn) {
        adaptRef(ref, frame.rois[i].lab, this.labels[i], this.conf[i], this.adaptMinConf, this.adaptAlpha);
      }
    }
  }

  /** 分類結果を追跡エンジンに渡す。 */
  private trackFrame(frame: FrameSample): void {
    const active = this.activeRoiIndices();
    const obs: RoiObservation[] = [];
    for (let k = 0; k < frame.rois.length; k++) {
      const roi = this.rois[active[k]];
      if (!roi) continue;
      obs.push({ face: roi.face, labels: this.labels[k], conf: this.conf[k] });
    }
    if (!obs.length) return;
    const step = this.tracker.step(obs, frame.t);
    this.lastStep = step;
    for (const m of step.applied) {
      this.moveLog.push(`${(frame.t / 1000).toFixed(2)}s ${m}`);
      if (this.moveLog.length > 200) this.moveLog.shift();
    }
    if (step.applied.length) this.onMovesApplied(step, frame.t);
  }

  /** 計測モード（ステップ7）が差し込むフック。 */
  private onMovesApplied(_step: TrackerStep, _t: number): void { /* step7 で使う */ }

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
        if (s) cells[roiIdx] = { rgb: s.rgb, labels: this.labels[k] ?? null, conf: this.conf[k] ?? null };
      });
    }
    this.overlay.draw({
      rois: this.rois,
      cells,
      palette: this.palette(),
      confThreshold: this.confThreshold,
      showRaw: this.showRaw,
      showGrid: this.showGrid,
      hoverCorner: this.editor?.hover ?? null,
      candidates: this.lastStep?.candidates.map((c) => ({
        label: c.label + (c.aliases.length ? `=${c.aliases.length}` : ''),
        score: c.score,
      })) ?? [],
      status: this.tracking ? this.tracker.status : this.running ? 'CAPTURING' : 'IDLE',
      moveLog: this.moveLog,
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
    this.renderAccuracy();
    this.renderTrackerStats();
    if (this.calib.active && this.calib.capturing) this.refreshColorSection();
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
    const { root, body } = section('ROI（最大3枚）');
    const rebuild = () => {
      body.replaceChildren(
        el('div', { class: 'hint' }, [
          '四隅の丸をドラッグして面に合わせる。番号 0→1→2→3 が facelet の (0,0)→(0,2)→(2,2)→(2,0) に対応。' +
          ' 向きが合わないときは rot を回す。',
        ]),
        ...this.rois.map((r) => this.roiRow(r, rebuild)),
        el('div', { class: 'row' }, [
          el('button', {
            disabled: this.rois.length >= MAX_ROIS,
            title: '固定カメラで見えるのは最大3面。3枚目を足すと恒等と区別できない手が消える。',
            onclick: () => {
              const used = new Set(this.rois.map((r) => r.face));
              const face = ([1, 0, 2, 3, 4, 5] as FaceIndex[]).find((f) => !used.has(f)) ?? 1;
              this.rois.push(makeRoi(`roi${this.rois.length}`, face as FaceIndex));
              saveRois(this.rois); this.pushConfig(); rebuild();
            },
          }, ['ROI追加']),
          el('button', {
            disabled: this.rois.length <= 1,
            onclick: () => { this.rois.pop(); saveRois(this.rois); this.pushConfig(); rebuild(); },
          }, ['末尾を削除']),
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


  // -------------------------------------------------------------------------
  // 色: プロファイル / キャリブレーション / 精度計測
  // -------------------------------------------------------------------------

  /** 6色の表示用 RGB。オーバーレイの塗りに使う。 */
  private palette(): [number, number, number][] | null {
    if (!this.ref) return null;
    const out: [number, number, number][] = [];
    for (let f = 0; f < 6; f++) out.push(labToRgb(this.ref[f * 3], this.ref[f * 3 + 1], this.ref[f * 3 + 2]));
    return out;
  }

  private setActiveProfile(p: ColorProfile | null, persist = true): void {
    this.activeProfile = p;
    this.ref = p ? Float32Array.from(p.refLab) : null;
    if (persist) setActiveProfileId(p?.id ?? null);
  }

  private startCalibration(): void {
    if (!this.running) {
      this.log('先にカメラを開始してください。', 'warn');
      return;
    }
    this.calib.active = true;
    this.calib.index = 0;
    this.calib.capturing = false;
    this.calib.result = [];
    this.calib.acc.reset();
    this.log('キャリブレーション開始。完成状態のキューブを用意し、指示された面を ROI に合わせてください。');
    this.refreshColorSection();
  }

  private captureCalibFace(): void {
    this.calib.acc.reset();
    this.calib.capturing = true;
    this.refreshColorSection();
  }

  /** フレームごとに呼ばれ、規定枚数たまったら次の面へ進む。 */
  private stepCalibration(frame: FrameSample): void {
    const active = this.activeRoiIndices();
    const k = active.indexOf(this.calib.roi);
    const sample = k >= 0 ? frame.rois[k] : undefined;
    if (!sample) {
      this.calib.capturing = false;
      this.log('キャリブレーション対象の ROI が無効です。', 'bad');
      return;
    }
    this.calib.acc.add(sample.lab);
    if (this.calib.acc.count < this.calib.target * 9) return;

    const res = this.calib.acc.result();
    this.calib.result.push(res);
    this.calib.capturing = false;
    this.log(`${FACE_NAMES[this.calib.index]} 面を記録: L*a*b* = ${res.lab.map((v) => v.toFixed(1)).join(', ')} / ばらつき ${res.spread.toFixed(2)}`,
      res.spread > 8 ? 'warn' : 'ok');
    if (res.spread > 8) this.log('  ばらつきが大きい。影・反射・ROI ずれを疑う。', 'warn');
    this.calib.index++;
    if (this.calib.index >= 6) this.finishCalibration();
    this.refreshColorSection();
  }

  private finishCalibration(): void {
    const refLab: number[] = [];
    const spread: number[] = [];
    for (const r of this.calib.result) {
      refLab.push(r.lab[0], r.lab[1], r.lab[2]);
      spread.push(r.spread);
    }
    const { d, a, b } = refMinDistance(refLab);
    const profile: ColorProfile = {
      id: `p${Date.now().toString(36)}`,
      name: `cube ${new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      refLab,
      spread,
      createdAt: Date.now(),
    };
    this.profiles.push(profile);
    saveProfiles(this.profiles);
    this.setActiveProfile(profile);
    this.calib.active = false;
    this.log(`キャリブレーション完了: ${profile.name}`, 'ok');
    this.log(`6色間の最小距離 ΔE=${d.toFixed(1)} (${FACE_NAMES[a]} vs ${FACE_NAMES[b]})`,
      d < MIN_SEPARATION_FAIL ? 'bad' : d < MIN_SEPARATION_WARN ? 'warn' : 'ok');
    if (d < MIN_SEPARATION_FAIL) {
      this.log('  この配色は判別困難。照明を変えるか別のキューブを使うこと。', 'bad');
    } else if (d < MIN_SEPARATION_WARN) {
      this.log('  判別が苦しい配色。誤分類が増える可能性が高い。', 'warn');
    }
    this.refreshColorSection();
  }

  private cancelCalibration(): void {
    this.calib.active = false;
    this.calib.capturing = false;
    this.refreshColorSection();
  }

  // --- 精度計測 -------------------------------------------------------------

  private startAccuracy(): void {
    if (!this.ref) {
      this.log('先にキャリブレーションが必要です。', 'warn');
      return;
    }
    this.accuracy = { running: true, t0: performance.now(), frames: 0, cells: 0, matched: 0, faceMatched: 0, lowConf: 0, confSum: 0 };
    this.log('色分類精度の計測開始。完成状態のキューブを ROI に映したまま静止させる。');
    this.refreshColorSection();
  }

  private stopAccuracy(): void {
    this.accuracy.running = false;
    const a = this.accuracy;
    const acc = a.cells ? (a.matched / a.cells) * 100 : NaN;
    this.log(`精度計測終了: ${fmt(acc, 2)}% (${a.matched}/${a.cells} セル, ${a.frames} フレーム, ${fmt((performance.now() - a.t0) / 1000)}秒)`,
      acc >= 98 ? 'ok' : 'bad');
    this.refreshColorSection();
  }

  /**
   * 完成状態の面は9セルすべて同色なので、ROI 内の最頻ラベルを正解とみなして一致率を出す
   * （CLAUDE.md「色分類精度（完成状態など既知状態での一致率）」）。
   * あわせて、最頻ラベルが ROI に設定した面と一致するか（= 本当の正解）も数える。
   */
  private accumulateAccuracy(frame: FrameSample): void {
    const a = this.accuracy;
    const active = this.activeRoiIndices();
    a.frames++;
    for (let k = 0; k < frame.rois.length; k++) {
      const labels = this.labels[k];
      const conf = this.conf[k];
      if (!labels) continue;
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 9; i++) if (labels[i] >= 0) counts[labels[i]]++;
      let mode = 0;
      for (let f = 1; f < 6; f++) if (counts[f] > counts[mode]) mode = f;
      for (let i = 0; i < 9; i++) {
        a.cells++;
        if (labels[i] === mode) a.matched++;
        a.confSum += conf[i];
        if (conf[i] < this.confThreshold) a.lowConf++;
      }
      if (mode === this.rois[active[k]]?.face) a.faceMatched += 9;
    }
  }

  // --- パネル ---------------------------------------------------------------

  private buildColorSection(): HTMLElement {
    const { root, body } = section('色キャリブレーション / 分類');
    this.colorBody = body;
    this.accuracyEl = el('div');
    this.refreshColorSection();
    return root;
  }

  private refreshColorSection(): void {
    if (!this.colorBody) return;
    const b = this.colorBody;
    const children: (HTMLElement | null)[] = [];

    // プロファイル選択
    const sel = el('select', {
      class: 'grow',
      onchange: (e: Event) => {
        const id = (e.target as HTMLSelectElement).value;
        this.setActiveProfile(this.profiles.find((p) => p.id === id) ?? null);
        this.refreshColorSection();
      },
    }, [
      el('option', { value: '' }, ['(なし: 未キャリブレーション)']),
      ...this.profiles.map((p) => el('option', { value: p.id }, [p.name])),
    ]) as HTMLSelectElement;
    sel.value = this.activeProfile?.id ?? '';
    children.push(el('div', { class: 'row' }, [el('label', {}, ['プロファイル']), sel]));
    children.push(el('div', { class: 'row' }, [
      el('button', { onclick: () => this.startCalibration(), disabled: this.calib.active }, ['新規キャリブレーション']),
      el('button', {
        disabled: !this.activeProfile,
        onclick: () => {
          const p = this.activeProfile!;
          const name = prompt('プロファイル名', p.name);
          if (name) { p.name = name; saveProfiles(this.profiles); this.refreshColorSection(); }
        },
      }, ['名前変更']),
      el('button', {
        class: 'danger', disabled: !this.activeProfile,
        onclick: () => {
          this.profiles = this.profiles.filter((p) => p.id !== this.activeProfile!.id);
          saveProfiles(this.profiles);
          this.setActiveProfile(this.profiles[0] ?? null);
          this.refreshColorSection();
        },
      }, ['削除']),
    ]));

    // 代表色スウォッチと最小距離
    if (this.ref) {
      const pal = this.palette()!;
      children.push(el('div', { class: 'swatches' }, pal.map((c, f) =>
        el('div', { class: 'swatch', style: { background: `rgb(${c[0]},${c[1]},${c[2]})` } }, [FACE_NAMES[f]]))));
      const { d, a, bIdx } = (() => { const r = refMinDistance(this.ref!); return { d: r.d, a: r.a, bIdx: r.b }; })();
      children.push(el('div', { class: d < MIN_SEPARATION_FAIL ? 'bad' : d < MIN_SEPARATION_WARN ? 'warn' : 'ok' },
        [`6色間の最小距離 ΔE=${d.toFixed(1)} (${FACE_NAMES[a]}↔${FACE_NAMES[bIdx]})` +
          (d < MIN_SEPARATION_FAIL ? ' — 判別困難' : d < MIN_SEPARATION_WARN ? ' — 苦しい' : ' — 良好')]));
    }

    // ウィザード
    if (this.calib.active) {
      const f = this.calib.index;
      children.push(el('div', { class: 'row' }, [
        el('label', {}, ['対象ROI']),
        el('select', {
          onchange: (e: Event) => { this.calib.roi = Number((e.target as HTMLSelectElement).value); },
        }, this.rois.map((r, i) => el('option', { value: String(i), selected: i === this.calib.roi }, [r.id]))),
        el('label', {}, ['平均フレーム']),
        el('input', {
          type: 'number', value: String(this.calib.target), min: '5', max: '200',
          style: { width: '60px' },
          onchange: (e: Event) => { this.calib.target = Number((e.target as HTMLInputElement).value); },
        }),
      ]));
      children.push(el('div', { class: 'big' }, [
        this.calib.capturing
          ? `${FACE_NAMES[f]} 面を撮影中… ${Math.floor(this.calib.acc.count / 9)}/${this.calib.target}`
          : `${FACE_NAMES[f]} 面を ROI に向けてください（${f + 1}/6）`,
      ]));
      children.push(el('div', { class: 'row' }, [
        el('button', { class: 'primary', disabled: this.calib.capturing, onclick: () => this.captureCalibFace() }, ['この面を記録']),
        el('button', { class: 'danger', onclick: () => this.cancelCalibration() }, ['中止']),
      ]));
      children.push(el('div', { class: 'hint' }, [
        '完成状態のキューブの各面を、同じ ROI に順に見せる。キューブを回して面を変えてよい（内部状態はまだ使っていない）。',
      ]));
    }

    // 分類パラメータ
    children.push(slider('信頼度しきい値', 0, 0.6, 0.01, this.confThreshold, (v) => { this.confThreshold = v; }));
    children.push(el('div', { class: 'row' }, [
      el('button', {
        class: this.adaptOn ? 'on' : '',
        onclick: (e: Event) => { this.adaptOn = !this.adaptOn; (e.target as HTMLElement).classList.toggle('on', this.adaptOn); },
      }, ['EMA オンライン適応']),
      el('button', {
        disabled: !this.activeProfile,
        onclick: () => {
          if (!this.ref || !this.activeProfile) return;
          this.activeProfile.refLab = Array.from(this.ref);
          saveProfiles(this.profiles);
          this.log('適応後の代表ベクトルをプロファイルに保存しました。', 'ok');
        },
      }, ['適応結果を保存']),
      el('button', {
        disabled: !this.activeProfile,
        onclick: () => { this.setActiveProfile(this.activeProfile); this.log('代表ベクトルをプロファイルの値に戻しました。'); },
      }, ['適応をリセット']),
    ]));
    children.push(slider('EMA alpha', 0.001, 0.2, 0.001, this.adaptAlpha, (v) => { this.adaptAlpha = v; }));
    children.push(slider('EMA 最低信頼度', 0, 1, 0.01, this.adaptMinConf, (v) => { this.adaptMinConf = v; }));

    // 精度計測
    children.push(el('div', { class: 'row' }, [
      el('button', {
        class: this.accuracy.running ? 'danger' : 'primary',
        onclick: () => (this.accuracy.running ? this.stopAccuracy() : this.startAccuracy()),
      }, [this.accuracy.running ? '精度計測を止める' : '色分類精度を計測']),
    ]));
    children.push(this.accuracyEl);
    b.replaceChildren(...(children.filter(Boolean) as HTMLElement[]));
  }

  private renderAccuracy(): void {
    const a = this.accuracy;
    if (!a.cells) { this.accuracyEl.replaceChildren(); return; }
    const acc = (a.matched / a.cells) * 100;
    const faceAcc = (a.faceMatched / a.cells) * 100;
    this.accuracyEl.innerHTML = `
      <table class="kv">
        <tr><td>経過</td><td>${fmt((performance.now() - a.t0) / 1000)}s / ${a.frames}フレーム</td></tr>
        <tr><td>一致率(面内最頻)</td><td><span class="${acc >= 98 ? 'ok' : 'bad'}">${fmt(acc, 2)}%</span></td></tr>
        <tr><td>期待面と一致</td><td>${fmt(faceAcc, 2)}%</td></tr>
        <tr><td>平均信頼度</td><td>${fmt(a.confSum / a.cells, 3)}</td></tr>
        <tr><td>低信頼セル</td><td>${((a.lowConf / a.cells) * 100).toFixed(2)}%</td></tr>
        <tr><td>判定セル数</td><td>${a.matched} / ${a.cells}</td></tr>
      </table>`;
  }


  // -------------------------------------------------------------------------
  // 追跡パネル
  // -------------------------------------------------------------------------

  private buildTrackerSection(): HTMLElement {
    const { root, body } = section('追跡エンジン');
    this.trackerBody = body;
    this.trackerStatsEl = el('div');
    this.refreshTrackerSection();
    return root;
  }

  private refreshTrackerSection(): void {
    if (!this.trackerBody) return;
    const th = this.tracker.thresholds;
    this.trackerBody.replaceChildren(
      el('div', { class: 'row' }, [
        el('button', {
          class: this.tracking ? 'danger' : 'primary',
          onclick: () => {
            this.tracking = !this.tracking;
            if (this.tracking) {
              this.moveLog.length = 0;
              this.log('追跡開始。内部状態は現在の値のまま。');
            }
            this.refreshTrackerSection();
          },
        }, [this.tracking ? '追跡停止' : '追跡開始']),
        el('button', {
          onclick: () => {
            this.tracker.reset(solvedState());
            this.moveLog.length = 0;
            this.lastStep = null;
            this.log('内部状態を完成状態にリセット。');
          },
        }, ['完成状態にリセット']),
        el('button', {
          onclick: () => {
            const n = prompt('内部状態にする手順（例: R U R\' U\'）', '');
            if (n === null) return;
            try {
              this.tracker.reset(applySequence(solvedState(), n));
              this.moveLog.length = 0;
              this.log(`内部状態を「${n}」適用後にセット。`);
            } catch (e) {
              this.log(`記法エラー: ${e instanceof Error ? e.message : String(e)}`, 'bad');
            }
          },
        }, ['手順から状態設定']),
      ]),
      slider('SCORE_THRESHOLD', 0.3, 1, 0.005, th.scoreThreshold, (v) => { th.scoreThreshold = v; }),
      slider('MARGIN_THRESHOLD', 0, 0.5, 0.005, th.marginThreshold, (v) => { th.marginThreshold = v; }),
      slider('ヒステリシス(フレーム)', 1, 8, 1, th.hysteresisFrames, (v) => { th.hysteresisFrames = v; }),
      slider('LOST判定(フレーム)', 3, 120, 1, th.lostFrames, (v) => { th.lostFrames = v; }),
      slider('セル信頼度の下限', 0, 0.8, 0.01, th.minCellConf, (v) => { th.minCellConf = v; }),
      slider('最低可視セル数', 1, 27, 1, th.minVisibleCells, (v) => { th.minVisibleCells = v; }),
      el('div', { class: 'row' }, [
        el('button', {
          class: th.twoMoveEnabled ? 'on' : '',
          onclick: (e: Event) => {
            th.twoMoveEnabled = !th.twoMoveEnabled;
            (e.target as HTMLElement).classList.toggle('on', th.twoMoveEnabled);
          },
        }, ['2手同時展開']),
        el('button', {
          class: th.preferIdentityOnTie ? 'on' : '',
          onclick: (e: Event) => {
            th.preferIdentityOnTie = !th.preferIdentityOnTie;
            (e.target as HTMLElement).classList.toggle('on', th.preferIdentityOnTie);
          },
          title: '同点候補に恒等が含まれるとき恒等を採る。OFF にすると曖昧なフレームは全て TRANSITION。',
        }, ['同点時は恒等優先']),
      ]),
      slider('2手展開の刈り込みK', 1, 12, 1, th.twoMoveTopK, (v) => { th.twoMoveTopK = v; }),
      this.trackerStatsEl,
    );
  }

  private renderTrackerStats(): void {
    if (!this.trackerStatsEl) return;
    const tr = this.tracker;
    const st = this.lastStep;
    const moves = tr.moves;
    const span = moves.length > 1 ? (moves[moves.length - 1].t - moves[0].t) / 1000 : 0;
    const tps = span > 0 ? (moves.length - 1) / span : 0;
    const confMean = moves.length ? moves.reduce((a, m) => a + m.confidence, 0) / moves.length : NaN;
    this.trackerStatsEl.innerHTML = `
      <table class="kv">
        <tr><td>状態</td><td><span class="pill ${this.tracking ? tr.status : 'IDLE'}">${this.tracking ? tr.status : 'IDLE'}</span></td></tr>
        <tr><td>確定手数</td><td>${moves.length}</td></tr>
        <tr><td>TPS</td><td>${fmt(tps, 2)}</td></tr>
        <tr><td>LOST回数</td><td><span class="${tr.lostCount ? 'bad' : 'ok'}">${tr.lostCount}</span></td></tr>
        <tr><td>TRANSITIONフレーム</td><td>${tr.transitionFrames} / ${tr.frameCount}</td></tr>
        <tr><td>最良スコア</td><td>${fmt(st?.best ?? NaN, 3)}</td></tr>
        <tr><td>2位とのマージン</td><td>${fmt(st?.margin ?? NaN, 3)}</td></tr>
        <tr><td>可視セル</td><td>${st?.visibleCells ?? '-'}</td></tr>
        <tr><td>平均信頼度(採用手)</td><td>${fmt(confMean, 3)}</td></tr>
        <tr><td>内部状態</td><td>${isSolved(tr.state) ? '<span class="ok">完成</span>' : '未完成'}</td></tr>
      </table>`;
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
