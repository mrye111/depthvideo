/**
 * 本地运镜分析服务客户端（spec #26 契约）。
 * 服务：FastAPI 绑 127.0.0.1:8788（票 #30）；离线时全部调用快速失败，
 * 由页面按 /health 探测结果做降级（按钮禁用 + 提示）。
 */

const BASE = 'http://127.0.0.1:8788';
const HEALTH_TIMEOUT_MS = 1_500;
const ANALYZE_TIMEOUT_MS = 300_000;

export type ServiceHealth = { online: boolean; modelLoaded: boolean };
export type MotionLabels = Record<string, { label: string; prob: number }>;
export type MotionResult = { labels: MotionLabels; description: string };
export type UploadResult = { videoId: string; durationSec: number; fps: number };

export async function probeService(): Promise<ServiceHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/health`, { signal: ctrl.signal });
    if (!resp.ok) return { online: false, modelLoaded: false };
    const data = (await resp.json()) as { status?: string; modelLoaded?: boolean };
    return { online: data.status === 'ok', modelLoaded: data.modelLoaded !== false };
  } catch {
    return { online: false, modelLoaded: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadVideo(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const resp = await fetch(`${BASE}/videos`, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`上传失败：HTTP ${resp.status}`);
  return (await resp.json()) as UploadResult;
}

export async function analyzeShot(
  videoId: string,
  startSec: number,
  endSec: number,
): Promise<MotionResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANALYZE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, startSec, endSec }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`分析失败：HTTP ${resp.status}`);
    return (await resp.json()) as MotionResult;
  } finally {
    clearTimeout(timer);
  }
}
