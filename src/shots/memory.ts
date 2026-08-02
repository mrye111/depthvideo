/**
 * 切分结果本地记忆：按视频文件指纹（名字+大小+最后修改）存 localStorage。
 * 逐帧概率数组较大，仅当帧数 ≤ 30000（约 20 分钟）时保存，否则只存切点
 * （恢复时时间轴无曲线但分段/卡片完整可用）。
 */
export type StoredBound = { frame: number; prob: number };
export type StoredResult = {
  v: 1;
  fps: number;
  nFrames: number;
  bounds: StoredBound[];
  probs: number[] | null;
  savedAt: number;
};

const PREFIX = 'shots.result.v1.';
const PROBS_CAP = 30_000;

export function fileFingerprint(file: File): string {
  const s = `${file.name}:${file.size}:${file.lastModified}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function saveResult(
  file: File,
  fps: number,
  nFrames: number,
  bounds: StoredBound[],
  probs: Float32Array,
): void {
  try {
    const stored: StoredResult = {
      v: 1,
      fps,
      nFrames,
      bounds,
      probs: nFrames <= PROBS_CAP ? Array.from(probs, (x) => Math.round(x * 1000) / 1000) : null,
      savedAt: Date.now(),
    };
    localStorage.setItem(PREFIX + fileFingerprint(file), JSON.stringify(stored));
  } catch (e) {
    console.warn('切分结果保存失败（配额？）', e);
  }
}

export function loadResult(file: File): StoredResult | null {
  try {
    const raw = localStorage.getItem(PREFIX + fileFingerprint(file));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredResult;
    if (parsed?.v !== 1 || !Array.isArray(parsed.bounds) || typeof parsed.fps !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
