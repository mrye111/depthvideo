/**
 * 片2：核心推理链路。
 * 上传/拖放 → 元数据 → 逐帧 seek 解码 → transformers.js depth-estimation（ModelScope 源）→
 * 灰度深度图实时预览 → 进度/取消/错误提示。
 * 行为按 research/inference-pipeline.md 与 research/video-export-pipeline.md 1:1 复刻：
 * 主线程推理 + 每帧 requestAnimationFrame 让出；单线程 WASM（无 COOP/COEP）；
 * Cache API 键 transformers-cache-v2；HTML 假响应拦截与缓存清理。
 * 导出（MP4/WebM）、样式/平滑/仅人物、胶片条裁剪 UI 在后续片实现；
 * 本片裁剪仅维护入点/出点状态（默认全片），帧循环读取该状态。
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import type { DepthEstimationPipeline, DepthEstimationOutput } from '@huggingface/transformers';

// ---------------------------------------------------------------------------
// transformers.js 环境（照抄原站：ModelScope 默认源 + 缓存键 + 单线程 WASM）
// ---------------------------------------------------------------------------
const MODELSCOPE_HOST = 'https://modelscope.cn/';
const MODELSCOPE_PATH_TEMPLATE = 'models/{model}/resolve/master/';
const CACHE_KEY = 'transformers-cache-v2';
const LEGACY_CACHE_KEYS = ['transformers-cache'];

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = MODELSCOPE_HOST;
env.remotePathTemplate = MODELSCOPE_PATH_TEMPLATE;
env.cacheKey = CACHE_KEY;
env.experimental_useCrossOriginStorage = false;
const onnxWasmEnv = env.backends.onnx.wasm;
if (onnxWasmEnv) {
  onnxWasmEnv.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 4)
    : 1;
}

/** 防镜像站返回 HTML 错误页：text/html 响应与「内容以 < 开头的 json/config」改写为 404 */
const nativeFetch = window.fetch.bind(window);
env.fetch = async (input: string | URL, init?: unknown) => {
  const resp = await nativeFetch(input as RequestInfo | URL, init as RequestInit | undefined);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return new Response('Not Found', { status: 404, statusText: 'HTML response rejected' });
  }
  if (/\.json(\?|#|$)/i.test(url)) {
    const buf = await resp.arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 64)).trimStart();
    if (head.startsWith('<')) {
      return new Response('Not Found', { status: 404, statusText: 'HTML-in-JSON rejected' });
    }
    return new Response(buf, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  return resp;
};

/** 启动时清理旧缓存键与 transformers-cache-v2 中被 HTML 错误页污染的条目 */
async function cleanupCaches(): Promise<void> {
  if (!('caches' in window)) return;
  for (const key of LEGACY_CACHE_KEYS) {
    await caches.delete(key).catch(() => {});
  }
  try {
    const cache = await caches.open(CACHE_KEY);
    for (const req of await cache.keys()) {
      const resp = await cache.match(req);
      if (!resp) continue;
      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        await cache.delete(req);
        continue;
      }
      if (/\.json(\?|#|$)/i.test(req.url)) {
        const head = new TextDecoder()
          .decode((await resp.arrayBuffer()).slice(0, 64))
          .trimStart();
        if (head.startsWith('<')) await cache.delete(req);
      }
    }
  } catch {
    /* 缓存清理失败不阻塞启动 */
  }
}

// ---------------------------------------------------------------------------
// DOM 引用
// ---------------------------------------------------------------------------
function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
}

// DOM 引用在 initApp() 内赋值（模板在 main.ts 中注入后才能取到元素）
let dropZone: HTMLDivElement;
let fileInput: HTMLInputElement;
let sourceVideo: HTMLVideoElement;
let inputEmpty: HTMLDivElement;
let inputBadge: HTMLSpanElement;
let sourceFileName: HTMLElement;
let sourceMeta: HTMLElement;
let outputBadge: HTMLSpanElement;
let outputEmpty: HTMLDivElement;
let depthCanvas: HTMLCanvasElement;
let liveFrameTag: HTMLDivElement;
let liveFrameText: HTMLSpanElement;
let outputMeta: HTMLElement;
let frameMeta: HTMLElement;
let speedMeta: HTMLElement;
let modelSelect: HTMLSelectElement;
let deviceSelect: HTMLSelectElement;
let sizeSelect: HTMLSelectElement;
let fpsSelect: HTMLSelectElement;
let modelCacheHint: HTMLSpanElement;
let startButton: HTMLButtonElement;
let cancelButton: HTMLButtonElement;
let progressTitle: HTMLSpanElement;
let progressText: HTMLElement;
let progressTrack: HTMLDivElement;
let progressBar: HTMLDivElement;
let statusLine: HTMLParagraphElement;
let gpuBadge: HTMLSpanElement;

function bindRefs(): void {
  dropZone = $<HTMLDivElement>('dropZone');
  fileInput = $<HTMLInputElement>('fileInput');
  sourceVideo = $<HTMLVideoElement>('sourceVideo');
  inputEmpty = $<HTMLDivElement>('inputEmpty');
  inputBadge = $<HTMLSpanElement>('inputBadge');
  sourceFileName = $<HTMLElement>('sourceFileName');
  sourceMeta = $<HTMLElement>('sourceMeta');
  outputBadge = $<HTMLSpanElement>('outputBadge');
  outputEmpty = $<HTMLDivElement>('outputEmpty');
  depthCanvas = $<HTMLCanvasElement>('depthCanvas');
  liveFrameTag = $<HTMLDivElement>('liveFrameTag');
  liveFrameText = $<HTMLSpanElement>('liveFrameText');
  outputMeta = $<HTMLElement>('outputMeta');
  frameMeta = $<HTMLElement>('frameMeta');
  speedMeta = $<HTMLElement>('speedMeta');
  modelSelect = $<HTMLSelectElement>('modelSelect');
  deviceSelect = $<HTMLSelectElement>('deviceSelect');
  sizeSelect = $<HTMLSelectElement>('sizeSelect');
  fpsSelect = $<HTMLSelectElement>('fpsSelect');
  modelCacheHint = $<HTMLSpanElement>('modelCacheHint');
  startButton = $<HTMLButtonElement>('startButton');
  cancelButton = $<HTMLButtonElement>('cancelButton');
  progressTitle = $<HTMLSpanElement>('progressTitle');
  progressText = $<HTMLElement>('progressText');
  progressTrack = $<HTMLDivElement>('progressTrack');
  progressBar = $<HTMLDivElement>('progressBar');
  statusLine = $<HTMLParagraphElement>('statusLine');
  gpuBadge = $<HTMLSpanElement>('gpuBadge');
  depthCtx = depthCanvas.getContext('2d')!;
}

// ---------------------------------------------------------------------------
// 文案（取自 research-snapshot/cn_strings.txt，逐字）
// ---------------------------------------------------------------------------
const S = {
  badgeLoaded: '已载入',
  badgeConverting: '转换中',
  badgeDone: '已完成',
  badgeCancelled: '已取消',
  badgeError: '出错',
  titlePreparing: '准备中',
  titleDownloading: '下载模型',
  titleGenerating: '生成中',
  titleCancelling: '取消中',
  titleDone: '完成',
  titleCancelled: '已取消',
  titleError: '出错',
  videoReady: '视频已准备好，可裁剪区间后点击开始生成。',
  metadataTimeout: '读取视频元数据超时',
  videoReadFail: '视频读取失败',
  badFileType: '不支持的文件格式，请选择 mp4 / webm / mov 视频（仅 1 个）。',
  firstDownload: (host: string, name: string, size: string) =>
    `首次使用，正在从 ${host} 下载 ${name}（${size}）...`,
  cachedLoad: (device: string, size: string) =>
    `模型已缓存。正在快速读入并初始化 ${device}（${size}）...`,
  downloading: (pct: number, sec: number) => `正在下载模型（${pct}% · 已用 ${sec}s）...`,
  downloaded: (device: string, dtype: string) =>
    `模型已下载完成，正在初始化 ${device}/${dtype}...`,
  initTimeout: (model: string, device: string, dtype: string) =>
    `${model} (${device}/${dtype}) 初始化超时。可切换到 WASM，或取消后重试。`,
  tryNext: '加载失败，尝试下一候选...',
  startFrames: (start: string, end: string, frames: number) =>
    `开始逐帧生成深度图（${start}s–${end}s · 共 ${frames} 帧）...`,
  processing: (done: number, total: number, fps: number) =>
    `处理中：${done}/${total} 帧。输出窗口实时刷新深度图，时间轴固定 ${fps}fps。`,
  framesFps: (done: number, total: number, fps: string) => `${done}/${total} 帧 · ${fps} fps`,
  doneFrames: (frames: number, fps: number) => `已生成 ${frames} 帧 · ${fps}fps`,
  cancelling: '正在取消，当前帧结束后停止...',
  cancelled: '已取消。可以调整参数后重新开始。',
  aborted: '用户取消',
  failWithHint: (message: string, hint: string) => `处理失败：${message}${hint}`,
  fetchHint:
    '（无法下载模型。请硬刷新后确认下载源为 modelscope.cn；若仍失败可改官方源并开代理，或在 Application → Cache Storage 删除 transformers-cache* 后重试。）',
  unknownError: '未知错误',
  seekTimeout: (time: string) => `跳转到 ${time}s 超时`,
  seekFail: '视频 seek 失败',
  gpuOk: '硬件加速：支持 WebGPU ✓',
  gpuWasm: '硬件加速：WASM 模式',
  cacheYes: '✓ 已缓存',
  cacheNo: '尚未缓存',
};

// ---------------------------------------------------------------------------
// 模型表（research/inference-pipeline.md §2）
// ---------------------------------------------------------------------------
type ModelSpec = {
  id: string;
  dtype: string;
  name: string;
  size: string;
  cachedBytesThreshold: number;
  timeoutMs: number;
};

function currentModelSpec(): ModelSpec {
  const [id, dtype] = modelSelect.value.split('::');
  const isBase = id.includes('-base');
  const isFp16 = dtype === 'fp16';
  return {
    id,
    dtype,
    name: isBase ? 'V2 Base · ONNX' : 'V2 Small · ONNX',
    size: isBase ? (isFp16 ? '~187MB' : '~371MB') : isFp16 ? '~48MB' : '~94MB',
    cachedBytesThreshold: isFp16 ? 20e6 : 40e6,
    timeoutMs: isBase ? 360_000 : 180_000,
  };
}

/** -ONNX 后缀变体失败时回退同名无后缀变体（反之亦然） */
function modelVariants(id: string): string[] {
  return id.endsWith('-ONNX') ? [id, id.replace(/-ONNX$/, '')] : [id, `${id}-ONNX`];
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let videoFile: File | null = null;
let videoUrl: string | null = null;
let videoDuration = 0;
/** 裁剪入点/出点（秒）。本片裁剪 UI 不接，默认全片；帧循环读取该状态。 */
let trimStart = 0;
let trimEnd = 0;
let depthPipe: DepthEstimationPipeline | null = null;
let depthPipeKey = '';
let cancelled = false;
let processing = false;

const processCanvas = document.createElement('canvas');
const processCtx = processCanvas.getContext('2d', { willReadFrequently: true })!;
let depthCtx: CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function isCancelError(e: unknown): boolean {
  const s = String(e);
  return s.includes(S.aborted) || s.includes('Cancelled by user');
}

function setProgress(pct: number): void {
  progressBar.style.width = `${pct.toFixed(1)}%`;
  progressText.textContent = `${Math.round(pct)}%`;
}

/** 探测模型权重是否已在 Cache API（research §4：权重字节数超阈值 + config.json 存在） */
async function probeCached(spec: ModelSpec, modelId: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(CACHE_KEY);
    const keys = await cache.keys();
    const onnxRe =
      spec.dtype === 'fp16'
        ? /\/onnx\/model_fp16\.onnx(_data)?(\?|$)/i
        : /\/onnx\/model\.onnx(\?|$)/i;
    let bytes = 0;
    let hasConfig = false;
    for (const req of keys) {
      if (!req.url.includes(`/${modelId}/`)) continue;
      if (/config\.json(\?|$)/i.test(req.url)) hasConfig = true;
      if (onnxRe.test(req.url)) {
        const resp = await cache.match(req);
        if (resp) bytes += Number(resp.headers.get('content-length') ?? 0) || (await resp.blob()).size;
      }
    }
    return hasConfig && bytes > spec.cachedBytesThreshold;
  } catch {
    return false;
  }
}

async function refreshCacheHint(): Promise<void> {
  const spec = currentModelSpec();
  modelCacheHint.textContent = '';
  const cached = await probeCached(spec, spec.id);
  modelCacheHint.textContent = cached ? S.cacheYes : S.cacheNo;
}

// ---------------------------------------------------------------------------
// 上传与元数据
// ---------------------------------------------------------------------------
function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name);
}

function waitMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(S.metadataTimeout));
    }, 10_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(S.videoReadFail));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
  });
}

async function loadVideo(file: File): Promise<void> {
  if (!isVideoFile(file)) {
    statusLine.textContent = S.badFileType;
    return;
  }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  progressTitle.textContent = S.titlePreparing;
  try {
    sourceVideo.src = videoUrl;
    await waitMetadata(sourceVideo);
  } catch (e) {
    progressTitle.textContent = S.titleError;
    statusLine.textContent = (e as Error).message;
    return;
  }
  videoFile = file;
  videoDuration = sourceVideo.duration;
  trimStart = 0;
  trimEnd = videoDuration;

  inputEmpty.hidden = true;
  sourceVideo.hidden = false;
  inputBadge.textContent = S.badgeLoaded;
  sourceFileName.textContent = file.name;
  sourceFileName.title = file.name;
  sourceMeta.textContent = `${sourceVideo.videoWidth}×${sourceVideo.videoHeight} · ${videoDuration.toFixed(2)}s`;

  progressTitle.textContent = '等待中';
  statusLine.textContent = S.videoReady;
  startButton.disabled = false;
}

// ---------------------------------------------------------------------------
// 逐帧 seek 解码（5s 超时，research/video-export-pipeline.md §1）
// ---------------------------------------------------------------------------
function seekVideo(t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(sourceVideo.currentTime - t) < 0.01 && sourceVideo.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(S.seekTimeout(t.toFixed(2))));
    }, 5_000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(S.seekFail));
    };
    const cleanup = () => {
      clearTimeout(timer);
      sourceVideo.removeEventListener('seeked', onSeeked);
      sourceVideo.removeEventListener('error', onError);
    };
    sourceVideo.addEventListener('seeked', onSeeked);
    sourceVideo.addEventListener('error', onError);
    sourceVideo.pause();
    sourceVideo.currentTime = t;
  });
}

// ---------------------------------------------------------------------------
// 模型加载（变体回退 + 下载进度 + 超时）
// ---------------------------------------------------------------------------
async function loadDepthModel(): Promise<DepthEstimationPipeline> {
  const spec = currentModelSpec();
  const device = deviceSelect.value;
  const key = `${spec.id}:${spec.dtype}:${device}`;
  if (depthPipe && depthPipeKey === key) return depthPipe;
  (depthPipe as unknown as { dispose?: () => Promise<void> } | null)?.dispose?.().catch(() => {});
  depthPipe = null;
  depthPipeKey = '';

  const host = new URL(env.remoteHost).host;
  let lastErr: unknown = new Error(S.unknownError);
  for (const variant of modelVariants(spec.id)) {
    if (cancelled) throw new Error(S.aborted);
    try {
      const cached = await probeCached(spec, variant);
      modelCacheHint.textContent = cached ? S.cacheYes : S.cacheNo;
      progressTitle.textContent = cached ? '读缓存' : S.titleDownloading;
      statusLine.textContent = cached
        ? S.cachedLoad(device, spec.size)
        : S.firstDownload(host, spec.name, spec.size);

      const t0 = performance.now();
      const fileProgress = new Map<string, { loaded: number; total: number }>();
      const pipe = await withTimeout(
        pipeline('depth-estimation', variant, {
          device: device as 'webgpu' | 'wasm',
          dtype: spec.dtype as 'fp16' | 'fp32',
          progress_callback: (info: {
            status: string;
            file?: string;
            loaded?: number;
            total?: number;
          }) => {
            if (cancelled) return; // 加载 Promise 不被 abort，仅停止文案更新
            if (info.status === 'progress' && info.file) {
              fileProgress.set(info.file, {
                loaded: info.loaded ?? 0,
                total: info.total ?? 0,
              });
              let loaded = 0;
              let total = 0;
              for (const f of fileProgress.values()) {
                loaded += f.loaded;
                total += f.total;
              }
              const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
              const sec = Math.round((performance.now() - t0) / 1000);
              progressTitle.textContent = `下载模型 ${pct}%`;
              statusLine.textContent = S.downloading(pct, sec);
              setProgress(pct);
            } else if (info.status === 'done') {
              statusLine.textContent = S.downloaded(device, spec.dtype);
            }
          },
        }),
        spec.timeoutMs,
        () => new Error(S.initTimeout(variant, device, spec.dtype)),
      );
      depthPipe = pipe;
      depthPipeKey = key;
      progressTitle.textContent = '初始化';
      modelCacheHint.textContent = S.cacheYes;
      return pipe;
    } catch (e) {
      if (isCancelError(e)) throw e;
      lastErr = e;
      console.warn(`模型候选 ${variant} 加载失败`, e);
      statusLine.textContent = S.tryNext;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 灰度深度图渲染（本片仅默认灰度；样式/方向/平滑在片4 接）
// ---------------------------------------------------------------------------
function renderDepthGray(depth: RawImage): void {
  const src = depth.toCanvas() as HTMLCanvasElement;
  depthCtx.drawImage(src, 0, 0, depthCanvas.width, depthCanvas.height);
}

/** 处理画布尺寸：长边缩到设定值、保宽高比、两维向下取偶 */
function computeOutputSize(): { w: number; h: number } {
  const vw = sourceVideo.videoWidth;
  const vh = sourceVideo.videoHeight;
  let w = vw;
  let h = vh;
  const sizeVal = sizeSelect.value;
  if (sizeVal !== 'original' && vw > 0 && vh > 0) {
    const target = Number(sizeVal);
    const scale = target / Math.max(vw, vh);
    w = Math.round(vw * scale);
    h = Math.round(vh * scale);
  }
  w -= w % 2;
  h -= h % 2;
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function startProcessing(): Promise<void> {
  if (!videoFile || processing) return;
  processing = true;
  cancelled = false;
  startButton.disabled = true;
  cancelButton.disabled = false;
  progressTrack.classList.add('is-active');
  setProgress(0);

  try {
    progressTitle.textContent = S.titlePreparing;
    statusLine.textContent = '正在准备模型...';
    const pipe = await loadDepthModel();
    if (cancelled) throw new Error(S.aborted);

    const fps = Number(fpsSelect.value);
    const { w, h } = computeOutputSize();
    processCanvas.width = w;
    processCanvas.height = h;
    depthCanvas.width = w;
    depthCanvas.height = h;

    outputEmpty.hidden = true;
    depthCanvas.hidden = false;
    liveFrameTag.hidden = false;
    outputBadge.textContent = S.badgeConverting;
    outputMeta.textContent = `${w}×${h}`;

    const start = trimStart;
    const end = Math.min(Math.max(trimStart + 0.1, trimEnd), videoDuration);
    const clipDuration = end - start;
    const total = Math.max(1, Math.ceil(clipDuration * fps));
    progressTitle.textContent = S.titleGenerating;
    statusLine.textContent = S.startFrames(start.toFixed(1), end.toFixed(1), total);

    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (cancelled) throw new Error(S.aborted);
      const tSec = Math.min(start + i / fps, Math.max(start, end - 0.001));
      await seekVideo(tSec);
      processCtx.drawImage(sourceVideo, 0, 0, w, h);
      const output = (await pipe(RawImage.fromCanvas(processCanvas))) as DepthEstimationOutput;
      renderDepthGray(output.depth);

      const done = i + 1;
      const instantFps = done / ((performance.now() - t0) / 1000);
      setProgress((done / total) * 100);
      statusLine.textContent = S.processing(done, total, fps);
      liveFrameText.textContent = `FRAME ${done} / ${total}`;
      frameMeta.textContent = S.framesFps(done, total, instantFps.toFixed(1));
      speedMeta.textContent = `${instantFps.toFixed(1)} fps`;
      await nextFrame();
    }

    outputBadge.textContent = S.badgeDone;
    progressTitle.textContent = S.titleDone;
    statusLine.textContent = S.doneFrames(total, fps);
  } catch (e) {
    if (isCancelError(e)) {
      outputBadge.textContent = S.badgeCancelled;
      progressTitle.textContent = S.titleCancelled;
      statusLine.textContent = S.cancelled;
    } else {
      console.error('处理失败', e);
      outputBadge.textContent = S.badgeError;
      progressTitle.textContent = S.titleError;
      const message = (e as Error)?.message || S.unknownError;
      const hint = /failed to fetch|unexpected token|not valid json/i.test(message)
        ? S.fetchHint
        : '';
      statusLine.textContent = S.failWithHint(message, hint);
    }
  } finally {
    processing = false;
    startButton.disabled = !videoFile;
    cancelButton.disabled = true;
    progressTrack.classList.remove('is-active');
  }
}

function cancelProcessing(): void {
  if (!processing) return;
  cancelled = true;
  progressTitle.textContent = S.titleCancelling;
  statusLine.textContent = S.cancelling;
  cancelButton.disabled = true;
}

// ---------------------------------------------------------------------------
// 事件绑定与初始化
// ---------------------------------------------------------------------------
export function initApp(): void {
  bindRefs();
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void loadVideo(file);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadVideo(file);
  });

  startButton.addEventListener('click', () => void startProcessing());
  cancelButton.addEventListener('click', cancelProcessing);
  modelSelect.addEventListener('change', () => void refreshCacheHint());
  deviceSelect.addEventListener('change', () => void refreshCacheHint());

  gpuBadge.textContent = 'gpu' in navigator ? S.gpuOk : S.gpuWasm;

  void cleanupCaches().then(() => refreshCacheHint());
}
