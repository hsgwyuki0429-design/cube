// カメラのフレームを VideoFrame のまま渡す（vframe）か、今までのやり方（bitmap・canvas に描く）に戻すかを決める。
// ライブ（src/vision/visionClient.ts）と録画（src/vision/recorder.ts）で同じ考え方にする。
//
// 一時的な失敗では戻さない: 映像のフレームがまだない（video.readyState が HAVE_CURRENT_DATA より前・作るときの InvalidStateError
// 「Video element has no video frame」）ときは、そのフレームだけ渡さずに次を待つ。実機の iPhone では、カメラの映像が届く前の
// 1 回の失敗でそのページの間ずっと bitmap に戻り、ソルブ中のカメラが 52〜55 → 42fps に落ちていた（docs/history.md の「ライブ 2.5」）。
// 戻すのは、映像が届いているのに続けて作れない・渡せない（MAX_FAILS 回）とき・Worker で描けないと分かったとき・VideoFrame がないときだけ。

// HTMLMediaElement.HAVE_CURRENT_DATA（Node のテストでも使えるように数で持つ）
export const HAVE_CURRENT_DATA = 2;
// 映像が届いているのに続けて作れない・渡せない回数がこれに届いたら戻す（60fps で 0.5 秒）
export const MAX_FAILS = 30;

export interface VideoLike {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
}

export type MakeResult =
  | { kind: "frame"; frame: VideoFrame }
  | { kind: "wait" } // このフレームだけ渡さない（次を待つ）
  | { kind: "off" }; // 今までのやり方で（戻した・はじめから使わない）

export class FrameGate {
  enabled = false; // VideoFrame のまま渡す（既定。?solveload=default で使わない）
  note: string | null = null; // 戻した理由（調査用）
  waits = 0; // 一時的に渡さなかった回数（調査用。書き出しの framePath）
  waitNote: string | null = null; // 最後に一時的に渡さなかった理由（調査用）
  private fails = 0; // 映像が届いているのに続けて作れない・渡せなかった回数

  constructor(
    private readonly label: string,
    private readonly create: ((video: VideoLike, timestamp: number) => VideoFrame) | null = typeof VideoFrame !== "undefined"
      ? (video, timestamp) => new VideoFrame(video as unknown as CanvasImageSource, { timestamp })
      : null,
  ) {}

  // 戻す（そのページの間は使わない）
  disable(why: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.note = why;
    console.warn(`${this.label}: VideoFrame を使わずに渡します:`, why);
  }

  // カメラの映像から VideoFrame を作る（timestamp: µs）
  make(video: VideoLike, timestamp: number): MakeResult {
    if (!this.enabled) return { kind: "off" };
    if (!this.create) {
      this.disable("VideoFrame がない");
      return { kind: "off" };
    }
    if (video.readyState < HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      this.wait(`映像のフレームがまだない（readyState ${video.readyState}）`);
      return { kind: "wait" };
    }
    try {
      const frame = this.create(video, timestamp);
      return { kind: "frame", frame };
    } catch (e) {
      return this.failed(video, `作れない: ${String(e)}`);
    }
  }

  // 作った VideoFrame を渡せた（続けて失敗した回数を戻す）
  sent(): void {
    this.fails = 0;
  }

  // 作った VideoFrame を渡せなかった（frame は呼んだ側で閉じる）
  sendFailed(video: VideoLike, e: unknown): MakeResult {
    return this.failed(video, `送れない: ${String(e)}`);
  }

  private wait(why: string): void {
    this.waits++;
    this.waitNote = why;
  }

  // 失敗: 映像のフレームがまだないなら待つだけ。映像が届いているのに MAX_FAILS 回続いたら戻す
  private failed(video: VideoLike, why: string): MakeResult {
    if (video.readyState < HAVE_CURRENT_DATA) {
      this.wait(why);
      return { kind: "wait" };
    }
    this.fails++;
    if (this.fails >= MAX_FAILS) {
      this.disable(`${why}（映像があるのに ${this.fails} 回続けて）`);
      return { kind: "off" };
    }
    this.wait(why);
    return { kind: "wait" };
  }
}

// 実際に使ったカメラのフレームの渡し方（書き出しに残す: vframe = VideoFrame のまま・bitmap = 今までのやり方）と、戻した理由・
// 一時的にそのフレームだけ渡さなかった回数（controller.framePath）
export interface FramePath {
  requested: boolean;
  live: "vframe" | "bitmap";
  liveNote: string | null;
  liveWaits: number;
  liveWaitNote: string | null;
  recorder: "vframe" | "bitmap";
  recorderNote: string | null;
  recorderWaits: number;
  recorderWaitNote: string | null;
}
