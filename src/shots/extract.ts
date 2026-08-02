/**
 * 镜头分析页抽帧器：视频 seek 抽帧 → 48×27 RGB（TransNet 输入预处理）。
 * 与票 #24 验证管线一致：全尺寸画布 → 缩到 48×27（smoothing high）→ 读像素。
 * HTMLVideoElement 不暴露源帧率，用 1.2s 窗口内去重帧数估算（映射到常见帧率档）。
 */

export type FrameExtractor = {
  /** 估算源帧率（探测约 1s） */
  probeFps(): Promise<number>;
  /** 给定帧率下的总帧数 */
  totalFrames(fps: number): number;
  /** 抽第 i 帧（时间 (i+0.5)/fps），写入 out 的 offset 处（27×48×3 长度） */
  grab(frameIndex: number, fps: number, out: Float32Array, offset: number): Promise<void>;
};

const SMALL_W = 48;
const SMALL_H = 27;
const FRAME_LEN = SMALL_W * SMALL_H * 3;

export function createFrameExtractor(video: HTMLVideoElement): FrameExtractor {
  const full = document.createElement('canvas');
  const small = document.createElement('canvas');
  small.width = SMALL_W;
  small.height = SMALL_H;
  const fullCtx = full.getContext('2d', { willReadFrequently: true })!;
  const smallCtx = small.getContext('2d', { willReadFrequently: true })!;
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.imageSmoothingQuality = 'high';
  let inited = false;

  function ensureSize(): void {
    if (inited) return;
    full.width = video.videoWidth;
    full.height = video.videoHeight;
    inited = true;
  }

  function seek(tSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - tSec) < 0.005 && video.readyState >= 2) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`seek 超时（${tSec.toFixed(2)}s）`));
      }, 5_000);
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('视频 seek 失败'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.pause();
      video.currentTime = Math.min(tSec, Math.max(0, video.duration - 0.001));
    });
  }

  async function grabAt(tSec: number, out: Float32Array, offset: number): Promise<void> {
    await seek(tSec);
    fullCtx.drawImage(video, 0, 0);
    smallCtx.drawImage(full, 0, 0, SMALL_W, SMALL_H);
    const d = smallCtx.getImageData(0, 0, SMALL_W, SMALL_H).data;
    for (let p = 0, j = 0; p < SMALL_W * SMALL_H; p++, j += 4) {
      out[offset + p * 3] = d[j];
      out[offset + p * 3 + 1] = d[j + 1];
      out[offset + p * 3 + 2] = d[j + 2];
    }
  }

  return {
    async probeFps(): Promise<number> {
      ensureSize();
      const SAMPLES = 120;
      const t0 = 0.2;
      const t1 = Math.max(t0 + 0.2, Math.min(1.4, video.duration - 0.1));
      const span = t1 - t0;
      const tmp = new Float32Array(FRAME_LEN);
      let prev: Float32Array | null = null;
      let distinct = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const t = t0 + span * (i / (SAMPLES - 1));
        await grabAt(t, tmp, 0);
        if (prev) {
          let sum = 0;
          let cnt = 0;
          for (let k = 0; k < FRAME_LEN; k += 97) {
            sum += Math.abs(tmp[k] - prev[k]);
            cnt++;
          }
          if (sum / cnt > 0.5) distinct++; // 同帧重解码差值≈0，换帧≈1.3+：阈值取中间
        }
        prev = tmp.slice();
      }
      const measured = distinct / span;
      if (measured < 8) return 25; // 静态/渐变开头无法可靠估计时的兜底
      const COMMON = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
      return COMMON.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a));
    },
    totalFrames(fps: number): number {
      return Math.max(1, Math.round(video.duration * fps));
    },
    async grab(frameIndex: number, fps: number, out: Float32Array, offset: number): Promise<void> {
      ensureSize();
      await grabAt((frameIndex + 0.5) / fps, out, offset);
    },
  };
}
