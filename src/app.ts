/**
 * 片2：核心推理链路。
 * 上传/拖放 → 元数据 → 逐帧 seek 解码 → transformers.js depth-estimation（ModelScope 源）→
 * 灰度深度图实时预览 → 进度/取消/错误提示。
 * 行为按 research/inference-pipeline.md 与 research/video-export-pipeline.md 1:1 复刻：
 * 主线程推理 + 每帧 requestAnimationFrame 让出；单线程 WASM（无 COOP/COEP）；
 * Cache API 键 transformers-cache-v2；HTML 假响应拦截与缓存清理。
 * 片3：MP4/WebM 导出链路。行为照 research/video-export-pipeline.md §2/§3 1:1 复刻：
 * 主路径 WebCodecs VideoEncoder（10 个 avc1 候选逐级探测，bitrate=clamp(1.5M,w*h*fps*0.1,40M)，
 * avc:{format:'avc'}，关键帧每 2s，encodeQueueSize>8 flush 背压）+ mp4-muxer ArrayBufferTarget；
 * 无 VideoEncoder/VideoFrame 或 avc1 全不支持时降级 captureStream(fps)+MediaRecorder（vp9→vp8→webm，
 * start(1000)，帧间 sleep(1000/fps) 按墙钟喂帧）；导出卡 idle/busy/ok/warn 4 态与文案照原站。
 * 片4：设置项补齐。行为照 research/video-export-pipeline.md §4 与 ui-ux-inventory.md §2.4 复刻：
 * 样式（灰度/热力——选项名 turbo 但数学是 Jet 三角近似 255·clamp(1.5−|4x−{3,2,1}|)，非真 turbo LUT）、
 * 深度方向（near-white 原值 / far-white 255−v）、时域平滑（out=prev·k+cur·(1−k)，k 0–0.85 默认 0.35，
 * 作用于 colormap 前的标量，换参数/重跑时重置上一帧状态）逐帧实时读取，改动下一帧即生效；
 * 分辨率/帧率在每次处理开始时读取，导出规格跟随；胶片条裁剪手柄（拖拽/键盘/重置，最短 0.1s）
 * 真实作用于帧范围与导出时长；同步播放对照源/结果视频。
 * 片5：仅人物分割与 base 模型选项。行为照 research/video-export-pipeline.md §5 1:1 复刻：
 * tasks-vision 0.10.35 ImageSegmenter，VIDEO 模式 + confidenceMasks，wasm 固定 npmmirror，
 * tflite 自托管 /mediapipe/selfie_segmenter[_landscape].tflite；GPU delegate 120s 超时降级 CPU 180s；
 * person 通道（labels 正则，缺省 masks[1]，再缺省 masks[0]）float32→0-255 灰度，alpha>128 硬阈值合成，
 * 背景按 personBgSelect 涂黑/保留原图；加载或单帧分割失败回退全白掩码（=全图），不中断处理；
 * 分割与深度推理在同一帧循环内串行 await（先深度后分割）。base 选项旁显示 CC-BY-NC 非商用警示。
 * 片6：i18n 接入。全部动态文案走 src/i18n.ts 双字典（zh/en 195 key 逐字照原站），
 * 状态类文案以 token（key+params）记录，语言切换时按 token 重渲染（原站 HW 函数行为）；
 * 模型下拉选项与缓存提示按原站 eK/iU 重渲染（含 ✓ 已缓存后缀与 {device} · 缓存统计）；
 * env.fetch 防护对齐原站 tU（仅 ok 响应、clone 读取、config/preprocessor/tokenizer 文件名正则）。
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import type {
  DepthEstimationPipeline,
  DepthEstimationOutput,
  BackgroundRemovalPipeline,
} from '@huggingface/transformers';
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { t, getLang, setLang, applyI18n, applyDocMeta, syncLangButtons } from './i18n';

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

/** 防镜像站返回 HTML 错误页（原站 tU）：仅检查 ok 响应；text/html 与
 *  「内容以 < 开头的 json/config 类文件」改写为 404，clone 读取不消耗原响应 */
const nativeFetch = window.fetch.bind(window);
const HTML_BODY_RE = /^\s*</;
env.fetch = async (input: string | URL, init?: unknown) => {
  const resp = await nativeFetch(input as RequestInfo | URL, init as RequestInit | undefined);
  if (!resp.ok) return resp;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    return new Response('Not Found', { status: 404, statusText: 'HTML response rejected' });
  }
  if (
    /\.json(\?|$)/i.test(url) ||
    /(?:^|\/)(config|preprocessor_config|tokenizer_config)\.json/i.test(url)
  ) {
    const buf = await resp.clone().arrayBuffer();
    if (HTML_BODY_RE.test(new TextDecoder().decode(buf.slice(0, 64)))) {
      return new Response('Not Found', { status: 404, statusText: 'HTML response rejected' });
    }
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
let pickVideoLabel: HTMLSpanElement;
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
let resultVideo: HTMLVideoElement;
let exportSlot: HTMLDivElement;
let exportCard: HTMLDivElement;
let exportStatusLabel: HTMLElement;
let exportStatusDetail: HTMLElement;
let downloadButton: HTMLButtonElement;
let modelSelect: HTMLSelectElement;
let deviceSelect: HTMLSelectElement;
let baseNcWarning: HTMLParagraphElement;
let sizeSelect: HTMLSelectElement;
let fpsSelect: HTMLSelectElement;
let styleSelect: HTMLSelectElement;
let directionSelect: HTMLSelectElement;
let smoothRange: HTMLInputElement;
let smoothValue: HTMLOutputElement;
let personModeSelect: HTMLSelectElement;
let segModelSelect: HTMLSelectElement;
let personBgSelect: HTMLSelectElement;
let syncPlayButton: HTMLButtonElement;
let trimWrap: HTMLDivElement;
let trimBar: HTMLDivElement;
let trimStrip: HTMLCanvasElement;
let shadeL: HTMLDivElement;
let shadeR: HTMLDivElement;
let trimRegion: HTMLDivElement;
let trimL: HTMLDivElement;
let trimR: HTMLDivElement;
let rangeInfo: HTMLSpanElement;
let rangeResetBtn: HTMLButtonElement;
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
  pickVideoLabel = $<HTMLSpanElement>('pickVideoLabel');
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
  resultVideo = $<HTMLVideoElement>('resultVideo');
  exportSlot = $<HTMLDivElement>('exportSlot');
  exportCard = $<HTMLDivElement>('exportCard');
  exportStatusLabel = $<HTMLElement>('exportStatusLabel');
  exportStatusDetail = $<HTMLElement>('exportStatusDetail');
  downloadButton = $<HTMLButtonElement>('downloadButton');
  modelSelect = $<HTMLSelectElement>('modelSelect');
  deviceSelect = $<HTMLSelectElement>('deviceSelect');
  baseNcWarning = $<HTMLParagraphElement>('baseNcWarning');
  sizeSelect = $<HTMLSelectElement>('sizeSelect');
  fpsSelect = $<HTMLSelectElement>('fpsSelect');
  styleSelect = $<HTMLSelectElement>('styleSelect');
  directionSelect = $<HTMLSelectElement>('directionSelect');
  smoothRange = $<HTMLInputElement>('smoothRange');
  smoothValue = $<HTMLOutputElement>('smoothValue');
  personModeSelect = $<HTMLSelectElement>('personModeSelect');
  segModelSelect = $<HTMLSelectElement>('segModelSelect');
  personBgSelect = $<HTMLSelectElement>('personBgSelect');
  syncPlayButton = $<HTMLButtonElement>('syncPlayButton');
  trimWrap = $<HTMLDivElement>('trimWrap');
  trimBar = $<HTMLDivElement>('trimBar');
  trimStrip = $<HTMLCanvasElement>('trimStrip');
  shadeL = $<HTMLDivElement>('shadeL');
  shadeR = $<HTMLDivElement>('shadeR');
  trimRegion = $<HTMLDivElement>('trimRegion');
  trimL = $<HTMLDivElement>('trimL');
  trimR = $<HTMLDivElement>('trimR');
  rangeInfo = $<HTMLSpanElement>('rangeInfo');
  rangeResetBtn = $<HTMLButtonElement>('rangeResetBtn');
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
// 动态文案：全部走 i18n 双字典（src/i18n.ts，key 逐字照原站）。
// 状态类文案以 token（key + 插值参数）记录当前值，语言切换时按 token 重渲染
// （原站 HW 函数行为）；raw 用于错误消息等字典外原文。
// ---------------------------------------------------------------------------
type Params = Record<string, string | number>;
type Dyn = { key: string; params?: Params } | { raw: string };

function renderDyn(d: Dyn): string {
  return 'raw' in d ? d.raw : t(d.key, d.params);
}

let statusDyn: Dyn = { key: 'footer.idleHint' };
let titleDyn: Dyn = { key: 'footer.waiting' };
let inputBadgeDyn: Dyn = { key: 'badge.noVideo' };
let outputBadgeDyn: Dyn = { key: 'badge.waiting' };
let exportDyn: { label: Dyn; detail: Dyn; state: string } = {
  label: { key: 'export.idleLabel' },
  detail: { key: 'export.idleDetail' },
  state: 'idle',
};
let frameMetaDyn: Dyn | null = null;

function setStatus(d: Dyn): void {
  statusDyn = d;
  statusLine.textContent = renderDyn(d);
}

function setTitle(d: Dyn): void {
  titleDyn = d;
  progressTitle.textContent = renderDyn(d);
}

function setInputBadge(d: Dyn): void {
  inputBadgeDyn = d;
  inputBadge.textContent = renderDyn(d);
  inputBadge.className = 'key' in d && d.key === 'badge.loaded' ? 'chip chip-ok' : 'chip';
}

function setOutputBadge(d: Dyn): void {
  outputBadgeDyn = d;
  outputBadge.textContent = renderDyn(d);
}

// ---------------------------------------------------------------------------
// 模型表（research/inference-pipeline.md §2，原站 KH 常量：2 模型 × fp16/fp32）
// ---------------------------------------------------------------------------
type ModelOption = {
  id: string;
  dtype: 'fp16' | 'fp32';
  /** 下拉显示名（语言中性，含 f16/f32 后缀） */
  name: string;
  /** 下载量标注（MB 数字） */
  mb: number;
  /** 是否带「推荐」标记（仅 small fp16 档） */
  recommended: boolean;
  cachedBytesThreshold: number;
  timeoutMs: number;
};

const MODEL_OPTIONS: ModelOption[] = (
  [
    {
      id: 'onnx-community/depth-anything-v2-small-ONNX',
      base: 'V2 Small · ONNX',
      recommended: true,
      sizes: { fp16: 48, fp32: 94 },
      timeoutMs: 180_000,
    },
    {
      id: 'onnx-community/depth-anything-v2-base-ONNX',
      base: 'V2 Base · ONNX',
      recommended: false,
      sizes: { fp16: 187, fp32: 371 },
      timeoutMs: 360_000,
    },
  ] as const
).flatMap((m) =>
  (['fp16', 'fp32'] as const).map((dtype) => ({
    id: m.id,
    dtype,
    name: `${m.base} · ${dtype === 'fp16' ? 'f16' : 'f32'}`,
    mb: m.sizes[dtype],
    recommended: m.recommended && dtype === 'fp16',
    cachedBytesThreshold: dtype === 'fp16' ? 20e6 : 40e6,
    timeoutMs: m.timeoutMs,
  })),
);

function modelOptionOf(key: string): ModelOption {
  return MODEL_OPTIONS.find((o) => `${o.id}::${o.dtype}` === key) ?? MODEL_OPTIONS[0];
}

type ModelSpec = {
  id: string;
  dtype: string;
  name: string;
  size: string;
  cachedBytesThreshold: number;
  timeoutMs: number;
};

function currentModelSpec(): ModelSpec {
  const o = modelOptionOf(modelSelect.value);
  return {
    id: o.id,
    dtype: o.dtype,
    name: o.name,
    size: `~${o.mb}MB`,
    cachedBytesThreshold: o.cachedBytesThreshold,
    timeoutMs: o.timeoutMs,
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
/** 裁剪入点/出点（秒）。胶片条手柄实时改写，帧循环与导出时长读取该状态。 */
let trimStart = 0;
let trimEnd = 0;
/** 本次导出实际使用的入点（同步播放时把源时间轴映射到结果时间轴） */
let exportTrimStart = 0;
let depthPipe: DepthEstimationPipeline | null = null;
let depthPipeKey = '';
let cancelled = false;
let processing = false;
/** 最近一次完成导出的产物（供下载按钮使用） */
let resultUrl: string | null = null;
let resultName = '';
/** 时域平滑的上一帧标量（深度 tensor 分辨率，每像素一个 0-255 值）；重跑/换参数时重置 */
let prevSmooth: Uint8ClampedArray | null = null;
/** 同步播放状态 */
let syncing = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;

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
  return (
    s.includes(t('status.aborted')) ||
    s.includes('用户取消') ||
    s.includes('Cancelled by user')
  );
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

/** 字节数格式化（缓存提示「本地 {bytes}」用） */
function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`;
  return `${Math.round(bytes / 1e3)}KB`;
}

/** 原站 $G：聚合 4 档模型选项的缓存命中（权重字节数超阈值 + config.json 存在）与总占用字节数 */
async function probeAllCached(): Promise<{ cachedKeys: Set<string>; occupiedBytes: number }> {
  const cachedKeys = new Set<string>();
  let occupiedBytes = 0;
  if (!('caches' in window)) return { cachedKeys, occupiedBytes };
  try {
    const cache = await caches.open(CACHE_KEY);
    const keys = await cache.keys();
    for (const opt of MODEL_OPTIONS) {
      const onnxRe =
        opt.dtype === 'fp16'
          ? /\/onnx\/model_fp16\.onnx(_data)?(\?|$)/i
          : /\/onnx\/model\.onnx(\?|$)/i;
      let bytes = 0;
      let hasConfig = false;
      for (const req of keys) {
        if (!req.url.includes(`/${opt.id}/`)) continue;
        if (/config\.json(\?|$)/i.test(req.url)) hasConfig = true;
        if (onnxRe.test(req.url)) {
          const resp = await cache.match(req);
          if (resp)
            bytes += Number(resp.headers.get('content-length') ?? 0) || (await resp.blob()).size;
        }
      }
      if (hasConfig && bytes > opt.cachedBytesThreshold) cachedKeys.add(`${opt.id}::${opt.dtype}`);
      occupiedBytes += bytes;
    }
  } catch {
    /* 探测失败按未缓存处理 */
  }
  return { cachedKeys, occupiedBytes };
}

/** 原站 iU：单选项文案 `{name}（~{size}MB{note}）`，命中缓存追加「· ✓ 已缓存」 */
function renderModelOptions(cachedKeys: Set<string>): void {
  const current = modelSelect.value;
  for (const option of Array.from(modelSelect.options)) {
    const opt = MODEL_OPTIONS.find((o) => `${o.id}::${o.dtype}` === option.value);
    if (!opt) continue;
    const note = opt.recommended
      ? getLang() === 'zh'
        ? `，${t('model.recommended')}`
        : `, ${t('model.recommended')}`
      : '';
    option.textContent = t(
      cachedKeys.has(`${opt.id}::${opt.dtype}`) ? 'model.optionCached' : 'model.option',
      { name: opt.name, size: opt.mb, note },
    );
  }
  modelSelect.value = current;
}

/** 原站 eK：重渲染模型下拉各选项（含缓存后缀）+ 缓存提示 {device} · 已缓存统计/尚未缓存 */
async function refreshModelCacheUI(): Promise<void> {
  const { cachedKeys, occupiedBytes } = await probeAllCached();
  renderModelOptions(cachedKeys);
  const device = deviceSelect.value;
  modelCacheHint.textContent =
    cachedKeys.size > 0
      ? t('model.cacheHint', {
          device,
          cached: cachedKeys.size,
          total: MODEL_OPTIONS.length,
          bytes: fmtBytes(occupiedBytes),
        })
      : t('model.cacheEmpty', { device });
}

/** base 档位为 CC-BY-NC-4.0（非商用），选中时显示警示（#7 硬性要求） */
function syncNcWarning(): void {
  baseNcWarning.hidden = !modelSelect.value.includes('-base');
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
      reject(new Error(t('error.metadataTimeout')));
    }, 10_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(t('error.videoReadFailed')));
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
    setStatus({ key: 'status.badFileType' });
    return;
  }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  setTitle({ key: 'title.preparing' });
  try {
    sourceVideo.src = videoUrl;
    await waitMetadata(sourceVideo);
  } catch (e) {
    setTitle({ key: 'title.error' });
    setStatus({ raw: (e as Error).message });
    return;
  }
  videoFile = file;
  videoDuration = sourceVideo.duration;
  trimStart = 0;
  trimEnd = videoDuration;

  clearResult();
  inputEmpty.hidden = true;
  sourceVideo.hidden = false;
  setInputBadge({ key: 'badge.loaded' });
  pickVideoLabel.textContent = t('btn.reselect');
  sourceFileName.textContent = file.name;
  sourceFileName.title = file.name;
  sourceMeta.textContent = `${sourceVideo.videoWidth}×${sourceVideo.videoHeight} · ${videoDuration.toFixed(2)}s`;

  exportSlot.hidden = false;
  setExportCard({ key: 'export.idleLabel' }, { key: 'export.readyDetail' }, 'idle');
  setTitle({ key: 'badge.waiting' });
  setStatus({ key: 'status.ready' });
  startButton.disabled = false;
  stopSyncPlay();
  syncPlayButton.disabled = true;
  trimWrap.hidden = false;
  updateTrimUI();
  void buildTrimStrip();
}

// ---------------------------------------------------------------------------
// 逐帧 seek 解码（5s 超时，research/video-export-pipeline.md §1）
// ---------------------------------------------------------------------------
function seekVideo(target: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(sourceVideo.currentTime - target) < 0.01 && sourceVideo.readyState >= 2) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t('error.seekTimeout', { time: target.toFixed(2) })));
    }, 5_000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(t('error.seekFailed')));
    };
    const cleanup = () => {
      clearTimeout(timer);
      sourceVideo.removeEventListener('seeked', onSeeked);
      sourceVideo.removeEventListener('error', onError);
    };
    sourceVideo.addEventListener('seeked', onSeeked);
    sourceVideo.addEventListener('error', onError);
    sourceVideo.pause();
    sourceVideo.currentTime = target;
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
  let lastErr: unknown = new Error(t('status.unknownError'));
  for (const variant of modelVariants(spec.id)) {
    if (cancelled) throw new Error(t('status.aborted'));
    try {
      const cached = await probeCached(spec, variant);
      setTitle({ key: cached ? 'badge.readingCache' : 'title.downloadModel' });
      setStatus(
        cached
          ? { key: 'status.loadCache', params: { device, size: spec.size } }
          : { key: 'status.firstDownload', params: { host, name: spec.name, size: spec.size } },
      );

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
              setTitle({ key: 'export.downloadModelPct', params: { pct } });
              setStatus({ key: 'status.downloadModel', params: { pct, sec } });
              setProgress(pct);
            } else if (info.status === 'done') {
              setStatus({
                key: 'status.modelReadyInit',
                params: { device, dtype: spec.dtype },
              });
            }
          },
        }),
        spec.timeoutMs,
        () => new Error(t('status.modelTimeout', { model: variant, device, dtype: spec.dtype })),
      );
      depthPipe = pipe;
      depthPipeKey = key;
      setTitle({ key: 'title.init' });
      void refreshModelCacheUI();
      return pipe;
    } catch (e) {
      if (isCancelError(e)) throw e;
      lastErr = e;
      console.warn(`模型候选 ${variant} 加载失败`, e);
      setStatus({ key: 'status.loadNextGeneric' });
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 仅人物分割（research/video-export-pipeline.md §5）
// MediaPipe ImageSegmenter（VIDEO + confidenceMasks）或 transformers background-removal；
// 任何加载/单帧失败回退全白掩码（=全图效果），不中断处理。
// ---------------------------------------------------------------------------
/** wasm 运行时固定走 npmmirror（原站国内源分支；本站 hub 固定 ModelScope） */
const MP_WASM_URL =
  'https://cdn.npmmirror.com/packages/@mediapipe/tasks-vision/0.10.35/files/wasm';
/** tflite 权重自托管，与下载源无关 */
const MP_TFLITE_PATHS: Record<string, string> = {
  mediapipe: '/mediapipe/selfie_segmenter.tflite',
  'mediapipe-landscape': '/mediapipe/selfie_segmenter_landscape.tflite',
};
const TF_SEG_MODEL = 'onnx-community/mediapipe_selfie_segmentation';

/** 人物掩码：0-255 灰度，>128 视为人物 */
type PersonMask = { data: Uint8ClampedArray; width: number; height: number };

let mpSegmenter: ImageSegmenter | null = null;
let mpSegmenterKey = '';
let tfSegPipe: BackgroundRemovalPipeline | null = null;
let tfSegPipeKey = '';
/** 分割整体不可用（加载失败）：本帧起回退全白掩码 */
let segBroken = false;

function whiteMask(w: number, h: number): PersonMask {
  return { data: new Uint8ClampedArray(w * h).fill(255), width: w, height: h };
}

function closeSegmenter(): void {
  if (mpSegmenter) {
    try {
      mpSegmenter.close();
    } catch {
      /* 已关闭 */
    }
  }
  mpSegmenter = null;
  mpSegmenterKey = '';
  (tfSegPipe as unknown as { dispose?: () => Promise<void> } | null)?.dispose?.().catch(() => {});
  tfSegPipe = null;
  tfSegPipeKey = '';
}

/** 加载 MediaPipe 分割：wasm 60s / GPU 120s 超时，GPU 失败降级 CPU（180s）；失败返回 null（=回退全图） */
async function loadMpSegmenter(kind: string): Promise<ImageSegmenter | null> {
  const tflite = MP_TFLITE_PATHS[kind] ?? MP_TFLITE_PATHS.mediapipe;
  const key = `mp:${kind}`;
  if (mpSegmenter && mpSegmenterKey === key) return mpSegmenter;
  closeSegmenter();

  const label = kind === 'mediapipe-landscape' ? 'Landscape' : 'Selfie';
  setStatus({ key: 'status.segMp', params: { label } });
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (cancelled) return;
    setStatus({ key: 'status.initMp', params: { sec: Math.round((performance.now() - t0) / 1000) } });
  }, 1000);
  try {
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(MP_WASM_URL),
      60_000,
      () => new Error(t('status.mpTimeoutWasm')),
    );
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: tflite, delegate },
      runningMode: 'VIDEO' as const,
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    try {
      mpSegmenter = await withTimeout(
        ImageSegmenter.createFromOptions(vision, options('GPU')),
        120_000,
        () => new Error(t('status.mpTimeoutGpu')),
      );
    } catch (e) {
      console.warn(t('status.mpCpuFallback'), e);
      setStatus({ key: 'status.mpCpuFallback' });
      mpSegmenter = await withTimeout(
        ImageSegmenter.createFromOptions(vision, options('CPU')),
        180_000,
        () => new Error(t('status.mpTimeoutCpu')),
      );
    }
    mpSegmenterKey = key;
    return mpSegmenter;
  } catch (e) {
    console.warn('MediaPipe 分割模型加载失败，回退全图处理', e);
    segBroken = true;
    return null;
  } finally {
    clearInterval(tick);
  }
}

/** 加载 transformers 分割（background-removal，fp32，跟随深度模型的 device）；失败返回 null */
async function loadTfSegmenter(): Promise<BackgroundRemovalPipeline | null> {
  const device = deviceSelect.value;
  const key = `tf:${device}`;
  if (tfSegPipe && tfSegPipeKey === key) return tfSegPipe;
  closeSegmenter();
  setStatus({ key: 'status.segTf' });
  const t0 = performance.now();
  try {
    tfSegPipe = (await pipeline('background-removal', TF_SEG_MODEL, {
      device: device as 'webgpu' | 'wasm',
      dtype: 'fp32',
      progress_callback: (info: { status: string; loaded?: number; total?: number }) => {
        if (cancelled) return;
        if (info.status === 'progress') {
          const pct = info.total ? Math.round(((info.loaded ?? 0) / info.total) * 100) : 0;
          setStatus({
            key: 'status.downloadSeg',
            params: { pct, sec: Math.round((performance.now() - t0) / 1000) },
          });
        }
      },
    })) as BackgroundRemovalPipeline;
    tfSegPipeKey = key;
    return tfSegPipe;
  } catch (e) {
    console.warn('Transformers 分割模型加载失败，回退全图处理', e);
    segBroken = true;
    return null;
  }
}

/** 处理开始时按需加载分割模型；失败不抛出（segBroken 标记，全白掩码回退） */
async function ensureSegmenter(): Promise<void> {
  if (personModeSelect.value !== 'person') return;
  setTitle({ key: 'export.prepareSeg' });
  const kind = segModelSelect.value;
  if (kind === 'transformers') await loadTfSegmenter();
  else await loadMpSegmenter(kind);
  if (segBroken) setStatus({ key: 'status.segFallback' });
}

/** 单帧分割：对处理画布出掩码；推理异常回退全白掩码（不中断处理） */
async function getPersonMask(timestampMs: number): Promise<PersonMask> {
  const w = processCanvas.width;
  const h = processCanvas.height;
  if (segBroken) return whiteMask(w, h);
  try {
    if (segModelSelect.value === 'transformers') {
      if (!tfSegPipe) return whiteMask(w, h);
      const out = (await tfSegPipe(RawImage.fromCanvas(processCanvas))) as unknown;
      const rgba = (Array.isArray(out) ? out[0] : out) as RawImage;
      const n = rgba.width * rgba.height;
      const data = new Uint8ClampedArray(n);
      for (let p = 0; p < n; p++) data[p] = rgba.data[p * 4 + 3]; // alpha = 前景置信度
      return { data, width: rgba.width, height: rgba.height };
    }
    if (!mpSegmenter) return whiteMask(w, h);
    const result = mpSegmenter.segmentForVideo(processCanvas, Math.max(0, timestampMs));
    const masks = result.confidenceMasks;
    if (!masks || masks.length === 0) {
      result.close();
      return whiteMask(w, h);
    }
    // 选 person 通道：labels 正则，缺省 masks[1]（selfie 2 类：背景/人物），再缺省 masks[0]
    let idx = -1;
    try {
      idx = mpSegmenter.getLabels().findIndex((l) => /person|human|selfie/i.test(l));
    } catch {
      /* labels 不可用时走缺省 */
    }
    const m = masks[idx >= 0 ? idx : masks.length > 1 ? 1 : 0];
    const f = m.getAsFloat32Array();
    const data = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) {
      data[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 255);
    }
    const mask = { data, width: m.width, height: m.height };
    result.close();
    return mask;
  } catch (e) {
    console.warn('单帧分割失败，本帧回退全图', e);
    return whiteMask(w, h);
  }
}

/** 掩码灰度画布（合成前按需平滑拉伸到输出尺寸） */
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
const maskFitCanvas = document.createElement('canvas');
const maskFitCtx = maskFitCanvas.getContext('2d', { willReadFrequently: true })!;

/**
 * 掩码与深度图合成（原站 pG 函数）：alpha>128 保留深度像素（硬阈值，无羽化）；
 * 其余按 personBgSelect —— 'original' 拷回原始帧 RGB（同尺寸时），否则涂黑；输出恒不透明。
 * 逐帧实时读取背景下拉，处理中改动下一帧即生效。
 */
function compositePersonMask(mask: PersonMask): void {
  const w = depthCanvas.width;
  const h = depthCanvas.height;
  // 掩码尺寸与输出不一致时用 drawImage 平滑拉伸
  let alpha = mask.data;
  if (mask.width !== w || mask.height !== h) {
    maskCanvas.width = mask.width;
    maskCanvas.height = mask.height;
    const img = maskCtx.createImageData(mask.width, mask.height);
    for (let i = 0, p = 0; p < mask.data.length; i += 4, p++) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = mask.data[p];
      img.data[i + 3] = 255;
    }
    maskCtx.putImageData(img, 0, 0);
    maskFitCanvas.width = w;
    maskFitCanvas.height = h;
    maskFitCtx.drawImage(maskCanvas, 0, 0, w, h);
    alpha = maskFitCtx.getImageData(0, 0, w, h).data.filter((_, i) => i % 4 === 0);
  }
  const out = depthCtx.getImageData(0, 0, w, h);
  const od = out.data;
  const keepOriginal = personBgSelect.value === 'original';
  const src = keepOriginal ? processCtx.getImageData(0, 0, w, h).data : null;
  for (let i = 0, p = 0; i < od.length; i += 4, p++) {
    if (alpha[p] > 128) continue; // 人物：保留深度
    if (src) {
      od[i] = src[i];
      od[i + 1] = src[i + 1];
      od[i + 2] = src[i + 2];
    } else {
      od[i] = od[i + 1] = od[i + 2] = 0;
    }
    od[i + 3] = 255;
  }
  depthCtx.putImageData(out, 0, 0);
}

// ---------------------------------------------------------------------------
// 深度图渲染：方向反转 → 时域平滑（colormap 前的标量）→ 灰度/Jet 着色
// （research/video-export-pipeline.md §4，原站 mG/hG 函数）
// ---------------------------------------------------------------------------
const mapCanvas = document.createElement('canvas');
const mapCtx = mapCanvas.getContext('2d', { willReadFrequently: true })!;

/** Jet 三角近似（原站选项名叫 turbo，但数学是经典 Jet，严禁换成真 turbo LUT） */
function jet(x: number): [number, number, number] {
  const c = (a: number) => Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - a))));
  return [c(3), c(2), c(1)];
}

/** 重置时域平滑状态（重新开始导出 / 换方向 / 换平滑系数 / 深度尺寸变化时调用） */
function resetSmoothState(): void {
  prevSmooth = null;
}

function renderDepth(depth: RawImage, mask: PersonMask | null = null): void {
  const src = depth.toCanvas() as HTMLCanvasElement;
  const sw = src.width;
  const sh = src.height;
  if (mapCanvas.width !== sw || mapCanvas.height !== sh) {
    mapCanvas.width = sw;
    mapCanvas.height = sh;
    prevSmooth = null;
  }
  mapCtx.drawImage(src, 0, 0);
  const img = mapCtx.getImageData(0, 0, sw, sh);
  const d = img.data;
  const pixels = d.length / 4;

  // 逐帧实时读取样式设置，处理中改动下一帧即生效
  const invert = directionSelect.value === 'far-white';
  const turbo = styleSelect.value === 'turbo';
  const k = Math.min(0.85, Math.max(0, Number(smoothRange.value) || 0));

  const primed = prevSmooth !== null && prevSmooth.length === pixels;
  if (!primed) prevSmooth = new Uint8ClampedArray(pixels);
  const prev = prevSmooth as Uint8ClampedArray;

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = invert ? 255 - d[i] : d[i];
    // 一阶 IIR：out = prev*k + cur*(1-k)，与上一帧输出做指数平均；首帧无平滑
    if (primed && k > 0) v = Math.round(prev[p] * k + v * (1 - k));
    prev[p] = v;
    if (turbo) {
      const [r, g, b] = jet(v / 255);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    } else {
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
    d[i + 3] = 255;
  }
  mapCtx.putImageData(img, 0, 0);
  depthCtx.drawImage(mapCanvas, 0, 0, depthCanvas.width, depthCanvas.height);
  if (mask) compositePersonMask(mask);
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
// 胶片条裁剪条：缩略图条 + 左右手柄拖拽/键盘 + 整段拖动 + 重置（最短 0.1s）
// 状态 trimStart/trimEnd 被帧循环与导出时长直接读取，改动即生效于下次处理。
// ---------------------------------------------------------------------------
const MIN_CLIP = 0.1;
const STRIP_THUMBS = 12;

function fmt1(v: number): string {
  return v.toFixed(1);
}

/** 按当前 trimStart/trimEnd 刷新遮罩/选区/手柄位置与「已选」文案 */
function updateTrimUI(): void {
  if (!videoFile || videoDuration <= 0) {
    rangeInfo.textContent = t('trim.selectedEmpty');
    return;
  }
  const W = trimBar.clientWidth || 1;
  const x1 = (trimStart / videoDuration) * W;
  const x2 = (trimEnd / videoDuration) * W;
  shadeL.style.left = '0px';
  shadeL.style.width = `${x1}px`;
  shadeR.style.left = `${x2}px`;
  shadeR.style.width = `${Math.max(0, W - x2)}px`;
  trimRegion.style.left = `${x1}px`;
  trimRegion.style.width = `${Math.max(0, x2 - x1)}px`;
  trimL.style.left = `${Math.max(0, x1 - 7)}px`;
  trimR.style.left = `${Math.min(Math.max(0, W - 14), x2 - 7)}px`;
  trimL.setAttribute('aria-valuemin', '0');
  trimL.setAttribute('aria-valuemax', videoDuration.toFixed(2));
  trimL.setAttribute('aria-valuenow', trimStart.toFixed(2));
  trimR.setAttribute('aria-valuemin', '0');
  trimR.setAttribute('aria-valuemax', videoDuration.toFixed(2));
  trimR.setAttribute('aria-valuenow', trimEnd.toFixed(2));
  const dur = trimEnd - trimStart;
  const frames = Math.max(1, Math.ceil(dur * Number(fpsSelect.value)));
  rangeInfo.textContent = t('trim.selected', {
    start: fmt1(trimStart),
    end: fmt1(trimEnd),
    duration: fmt1(dur),
    frames,
  });
}

/** 设定裁剪区间（钳制到 [0, videoDuration] 且保持最短 0.1s） */
function setTrim(start: number, end: number): void {
  start = Math.min(Math.max(0, start), videoDuration - MIN_CLIP);
  end = Math.min(Math.max(start + MIN_CLIP, end), videoDuration);
  trimStart = start;
  trimEnd = end;
  updateTrimUI();
}

/** 生成胶片条缩略图：独立 video 元素均匀取 12 帧画入 trimStrip，不干扰源视频播放位置 */
async function buildTrimStrip(): Promise<void> {
  const W = Math.max(1, trimBar.clientWidth);
  const H = 48;
  trimStrip.width = W;
  trimStrip.height = H;
  const ctx = trimStrip.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, W, H);
  if (!videoUrl || videoDuration <= 0) return;

  const stripVideo = document.createElement('video');
  stripVideo.muted = true;
  stripVideo.preload = 'auto';
  stripVideo.src = videoUrl;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        stripVideo.addEventListener('loadedmetadata', () => resolve(), { once: true });
        stripVideo.addEventListener('error', () => reject(new Error(t('error.trimStripFailed'))), {
          once: true,
        });
      }),
      10_000,
      () => new Error(t('error.trimStripTimeout')),
    );
    const tw = W / STRIP_THUMBS;
    const vw = stripVideo.videoWidth;
    const vh = stripVideo.videoHeight;
    for (let i = 0; i < STRIP_THUMBS; i++) {
      const thumbT = ((i + 0.5) / STRIP_THUMBS) * videoDuration;
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          stripVideo.addEventListener('seeked', () => resolve(), { once: true });
          stripVideo.addEventListener('error', () => reject(new Error(t('error.trimStripFailed'))), {
            once: true,
          });
          stripVideo.currentTime = Math.min(thumbT, Math.max(0, videoDuration - 0.001));
        }),
        5_000,
        () => new Error(t('error.trimStripTimeout')),
      );
      // cover 适配：保持源宽高比居中裁切
      const scale = Math.max(tw / vw, H / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      ctx.drawImage(stripVideo, i * tw + (tw - dw) / 2, (H - dh) / 2, dw, dh);
    }
  } catch (e) {
    console.warn((e as Error).message || t('error.trimStripFailed'), e);
  } finally {
    stripVideo.removeAttribute('src');
    stripVideo.load();
  }
}

/** 手柄/选区拖拽（Pointer Events，处理中禁用） */
function bindTrimDrag(el: HTMLElement, which: 'L' | 'R' | 'region'): void {
  el.addEventListener('pointerdown', (e) => {
    if (processing || !videoFile || videoDuration <= 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    if (which === 'region') trimRegion.classList.add('is-dragging');
    const startX = e.clientX;
    const s0 = trimStart;
    const e0 = trimEnd;
    const onMove = (ev: PointerEvent) => {
      const dt = ((ev.clientX - startX) / (trimBar.clientWidth || 1)) * videoDuration;
      if (which === 'L') {
        setTrim(s0 + dt, e0);
      } else if (which === 'R') {
        setTrim(s0, e0 + dt);
      } else {
        const dur = e0 - s0;
        const ns = Math.min(Math.max(0, s0 + dt), videoDuration - dur);
        setTrim(ns, ns + dur);
      }
    };
    const onUp = () => {
      trimRegion.classList.remove('is-dragging');
      el.removeEventListener('pointermove', onMove);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp, { once: true });
    el.addEventListener('pointercancel', onUp, { once: true });
  });
}

/** 手柄键盘操作（role=slider）：←/→ ±0.1s，Shift ±1s */
function bindTrimKeys(el: HTMLElement, which: 'L' | 'R'): void {
  el.addEventListener('keydown', (e) => {
    if (processing || !videoFile) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowRight' ? 1 : -1);
    if (which === 'L') setTrim(trimStart + step, trimEnd);
    else setTrim(trimStart, trimEnd + step);
  });
}

// ---------------------------------------------------------------------------
// 同步播放：源视频与结果视频对照播放（结果时间轴 = 源时间轴 − 导出时入点）
// ---------------------------------------------------------------------------
function setSyncLabel(text: string): void {
  const span = syncPlayButton.querySelector('span');
  if (span) span.textContent = text;
}

function stopSyncPlay(): void {
  if (!syncing) return;
  syncing = false;
  if (syncTimer !== null) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  sourceVideo.pause();
  resultVideo.pause();
  setSyncLabel(t('btn.syncPlay'));
}

function startSyncPlay(): void {
  if (!resultUrl || syncing) return;
  syncing = true;
  setSyncLabel(t('btn.stopSync'));
  const syncTime = () => {
    const target = Math.min(
      Math.max(0, sourceVideo.currentTime - exportTrimStart),
      resultVideo.duration || 0,
    );
    if (Math.abs(resultVideo.currentTime - target) > 0.15) resultVideo.currentTime = target;
  };
  syncTime();
  void sourceVideo.play().catch(() => {});
  void resultVideo.play().catch(() => {});
  syncTimer = setInterval(() => {
    syncTime();
    if (sourceVideo.paused && !resultVideo.paused) resultVideo.pause();
    if (!sourceVideo.paused && resultVideo.paused && !resultVideo.ended) {
      void resultVideo.play().catch(() => {});
    }
    if (sourceVideo.ended) stopSyncPlay();
  }, 250);
}

// ---------------------------------------------------------------------------
// 导出：MP4（WebCodecs + mp4-muxer）主路径 / WebM（MediaRecorder）降级
// （research/video-export-pipeline.md §2/§3）
// ---------------------------------------------------------------------------
type ExportSession = {
  format: 'MP4' | 'WebM';
  /** 每帧渲染到 depthCanvas 后调用；MP4 编码 VideoFrame，WebM 按墙钟 sleep */
  encodeFrame(index: number): Promise<void>;
  /** 正常结束：flush/封装，产出 Blob */
  finalize(): Promise<Blob>;
  /** 取消/出错时中止：关 encoder / 停 recorder 与轨道，幂等 */
  abort(): void;
};

/** 导出卡 4 态：idle/busy/ok/warn（原站 BG 函数；取消与出错同为 warn）。label/detail 记 token 供语言切换重渲染 */
function setExportCard(label: Dyn, detail: Dyn, state: string, showDownload = false): void {
  exportDyn = { label, detail, state };
  exportCard.className = `export-card export-${state}`;
  exportStatusLabel.textContent = renderDyn(label);
  exportStatusDetail.textContent = renderDyn(detail);
  downloadButton.hidden = !showDownload;
  downloadButton.disabled = !showDownload || !resultUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 逐级探测 H.264 编码配置（原站 gG 函数）：
 * bitrate = clamp(1.5Mbps, w*h*fps*0.1, 40Mbps)，10 个 avc1 候选，全部不支持返回 null → 降级 WebM。
 */
async function probeEncoderConfig(
  w: number,
  h: number,
  fps: number,
): Promise<VideoEncoderConfig | null> {
  const bitrate = Math.min(4e7, Math.max(15e5, Math.round(w * h * fps * 0.1)));
  const candidates = [
    'avc1.42001f',
    'avc1.4d001f',
    'avc1.420028',
    'avc1.4d0028',
    'avc1.640028',
    'avc1.4d0029',
    'avc1.640029',
    'avc1.640032',
    'avc1.640033',
    'avc1.640034',
  ];
  for (const codec of candidates) {
    const cfg: VideoEncoderConfig = {
      codec,
      width: w,
      height: h,
      framerate: fps,
      bitrate,
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) return support.config ?? cfg;
    } catch {
      /* 探测异常视为不支持，继续下一候选 */
    }
  }
  return null;
}

/** MP4 会话：ArrayBufferTarget 内存拼装 + 关键帧每 2s + encodeQueueSize>8 flush 背压，无音频轨 */
async function createMp4Session(
  w: number,
  h: number,
  fps: number,
  total: number,
): Promise<ExportSession | null> {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return null;
  const config = await probeEncoderConfig(w, h, fps);
  if (!config) return null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: { expectedVideoChunks: total },
    firstTimestampBehavior: 'strict',
  });
  let encErr: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encErr = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure(config);
  const frameUs = Math.round(1e6 / fps);
  let closed = false;

  return {
    format: 'MP4',
    async encodeFrame(index) {
      if (encErr) throw encErr;
      const frame = new VideoFrame(depthCanvas, {
        timestamp: index * frameUs,
        duration: frameUs,
      });
      encoder.encode(frame, { keyFrame: index % Math.max(1, fps * 2) === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 8) await encoder.flush();
    },
    async finalize() {
      if (encErr) throw encErr;
      await encoder.flush();
      encoder.close();
      closed = true;
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
    abort() {
      if (!closed && encoder.state !== 'closed') {
        closed = true;
        try {
          encoder.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  };
}

/** WebM 降级会话：captureStream(fps) + MediaRecorder，mimeType vp9→vp8→webm，start(1000) */
function createWebMSession(fps: number): ExportSession {
  const mimeType =
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    ) || '';
  if (!mimeType) throw new Error(t('status.noMediaRecorder'));

  const stream = depthCanvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(1000);
  const frameMs = Math.round(1000 / fps);
  let stopped = false;
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    format: 'WebM',
    async encodeFrame() {
      // captureStream 按 fps 实时抓画布，必须按墙钟节奏停留
      await sleep(frameMs);
    },
    async finalize() {
      recorder.stop();
      stopped = true;
      await new Promise<void>((r) => recorder.addEventListener('stop', () => r(), { once: true }));
      stopTracks();
      return new Blob(chunks, { type: mimeType });
    },
    abort() {
      if (!stopped) {
        stopped = true;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* 已停止 */
        }
        stopTracks();
      }
    },
  };
}

/** 导出完成：产物入库、导出卡 ok、结果视频可回放、可下载（原站 qW/XW） */
function finishExport(frames: number, fps: number, format: string, blob: Blob): void {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const base = videoFile?.name.replace(/\.[^.]+$/, '') || 'depth-video';
  resultName = `${base}-depth-${fps}fps.${format === 'MP4' ? 'mp4' : 'webm'}`;

  liveFrameTag.hidden = true;
  depthCanvas.hidden = true;
  outputEmpty.hidden = true;
  resultVideo.hidden = false;
  resultVideo.src = resultUrl;
  resultVideo.load();

  setExportCard(
    { key: 'export.success' },
    { key: 'export.successDetail', params: { frames, fps, format } },
    'ok',
    true,
  );
  setOutputBadge({ key: 'title.done' });
  setTitle({ key: 'badge.done' });
  setStatus({ key: 'status.done', params: { frames, fps, format } });
  setProgress(100);
  syncPlayButton.disabled = false;
}

function downloadResult(): void {
  if (!resultUrl) return;
  const a = document.createElement('a');
  a.href = resultUrl;
  a.download = resultName;
  document.body.append(a);
  a.click();
  a.remove();
}

/** 清理上一次导出产物并复位结果视频 */
function clearResult(): void {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  resultName = '';
  stopSyncPlay();
  syncPlayButton.disabled = true;
  resultVideo.hidden = true;
  resultVideo.removeAttribute('src');
  resultVideo.load();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function startProcessing(): Promise<void> {
  if (!videoFile || processing) return;
  processing = true;
  cancelled = false;
  resetSmoothState();
  stopSyncPlay();
  trimBar.classList.add('is-disabled');
  startButton.disabled = true;
  cancelButton.disabled = false;
  progressTrack.classList.add('is-active');
  setProgress(0);
  setExportCard({ key: 'export.busy' }, { key: 'export.prepare' }, 'busy');

  let session: ExportSession | null = null;
  let sessionDone = false;
  try {
    setTitle({ key: 'title.preparing' });
    setStatus({ key: 'status.preparing' });
    const pipe = await loadDepthModel();
    if (cancelled) throw new Error(t('status.aborted'));

    // 仅人物：处理开始前加载分割模型（失败回退全白掩码，不阻断）
    segBroken = false;
    const personMode = personModeSelect.value === 'person';
    if (personMode) {
      await ensureSegmenter();
      if (cancelled) throw new Error(t('status.aborted'));
    }

    const fps = Number(fpsSelect.value);
    const { w, h } = computeOutputSize();
    processCanvas.width = w;
    processCanvas.height = h;
    depthCanvas.width = w;
    depthCanvas.height = h;

    outputEmpty.hidden = true;
    resultVideo.hidden = true;
    depthCanvas.hidden = false;
    liveFrameTag.hidden = false;
    setOutputBadge({ key: 'export.busy' });
    outputMeta.textContent = `${w}×${h}`;

    const start = trimStart;
    const end = Math.min(Math.max(trimStart + 0.1, trimEnd), videoDuration);
    exportTrimStart = start;
    const clipDuration = end - start;
    const total = Math.max(1, Math.ceil(clipDuration * fps));

    // 编码路径：优先 MP4（WebCodecs），不可用则降级 WebM（MediaRecorder）
    session = await createMp4Session(w, h, fps, total);
    setTitle({ key: 'title.generating' });
    if (session) {
      setStatus({
        key: 'status.startFrames',
        params: { start: start.toFixed(1), end: end.toFixed(1), frames: total },
      });
      setExportCard({ key: 'export.busy' }, { key: 'export.generating' }, 'busy');
    } else {
      setStatus({
        key: 'status.fallbackWebm',
        params: { start: start.toFixed(1), end: end.toFixed(1) },
      });
      setExportCard({ key: 'export.busy' }, { key: 'export.generating' }, 'busy');
      session = createWebMSession(fps);
    }

    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (cancelled) throw new Error(t('status.aborted'));
      const tSec = Math.min(start + i / fps, Math.max(start, end - 0.001));
      await seekVideo(tSec);
      processCtx.drawImage(sourceVideo, 0, 0, w, h);
      const output = (await pipe(RawImage.fromCanvas(processCanvas))) as DepthEstimationOutput;
      // 分割与深度推理在同一帧循环内串行完成（先深度后分割），失败回退全白掩码
      const mask = personMode ? await getPersonMask(Math.round(tSec * 1000)) : null;
      renderDepth(output.depth, mask);
      await session.encodeFrame(i);

      const done = i + 1;
      const instantFps = done / ((performance.now() - t0) / 1000);
      setProgress((done / total) * 100);
      setStatus({ key: 'status.progress', params: { done, total, fps } });
      liveFrameText.textContent = `FRAME ${done} / ${total}`;
      frameMetaDyn = {
        key: 'export.progressDetail',
        params: { done, total, fps: instantFps.toFixed(1) },
      };
      frameMeta.textContent = renderDyn(frameMetaDyn);
      speedMeta.textContent = `${instantFps.toFixed(1)} fps`;
      await nextFrame();
    }

    if (session.format === 'MP4') {
      setTitle({ key: 'title.muxing' });
      setStatus({ key: 'status.muxing' });
      setExportCard({ key: 'export.busy' }, { key: 'export.muxing' }, 'busy');
    }
    const blob = await session.finalize();
    sessionDone = true;
    finishExport(total, fps, session.format, blob);
  } catch (e) {
    if (isCancelError(e)) {
      setOutputBadge({ key: 'title.cancelled' });
      setTitle({ key: 'title.cancelled' });
      setStatus({ key: 'status.cancelled' });
      setExportCard({ key: 'export.cancelled' }, { key: 'export.cancelledDetail' }, 'warn');
    } else {
      console.error('处理失败', e);
      setOutputBadge({ key: 'title.error' });
      setTitle({ key: 'title.error' });
      const message = (e as Error)?.message || t('status.unknownError');
      const hint = /failed to fetch|unexpected token|not valid json/i.test(message)
        ? t('status.fetchHint')
        : '';
      setStatus({ key: 'status.failed', params: { message, hint } });
      setExportCard({ key: 'export.failed' }, { raw: message }, 'warn');
    }
  } finally {
    if (!sessionDone) session?.abort();
    processing = false;
    startButton.disabled = !videoFile;
    cancelButton.disabled = true;
    trimBar.classList.remove('is-disabled');
    progressTrack.classList.remove('is-active');
  }
}

function cancelProcessing(): void {
  if (!processing) return;
  cancelled = true;
  setTitle({ key: 'title.cancelling' });
  setStatus({ key: 'status.cancelling' });
  setExportCard({ key: 'export.cancelling' }, { key: 'export.cancellingDetail' }, 'warn');
  cancelButton.disabled = true;
}

// ---------------------------------------------------------------------------
// 语言切换全量重渲染（原站 HW）：静态 data-i18n* + doc meta + 按钮激活态 +
// 动态状态 token（状态行/标题/徽标/导出卡/帧信息/选择视频钮/同步钮/裁剪信息/模型缓存）
// ---------------------------------------------------------------------------
function rerenderAll(): void {
  applyI18n();
  applyDocMeta();
  syncLangButtons();
  setStatus(statusDyn);
  setTitle(titleDyn);
  setInputBadge(inputBadgeDyn);
  setOutputBadge(outputBadgeDyn);
  exportCard.className = `export-card export-${exportDyn.state}`;
  exportStatusLabel.textContent = renderDyn(exportDyn.label);
  exportStatusDetail.textContent = renderDyn(exportDyn.detail);
  if (frameMetaDyn) frameMeta.textContent = renderDyn(frameMetaDyn);
  pickVideoLabel.textContent = t(videoFile ? 'btn.reselect' : 'btn.pickVideo');
  gpuBadge.textContent = 'gpu' in navigator ? t('gpu.webgpu') : t('gpu.wasm');
  setSyncLabel(syncing ? t('btn.stopSync') : t('btn.syncPlay'));
  updateTrimUI();
  void refreshModelCacheUI();
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
  downloadButton.addEventListener('click', downloadResult);
  modelSelect.addEventListener('change', () => {
    syncNcWarning();
    void refreshModelCacheUI();
  });
  deviceSelect.addEventListener('change', () => void refreshModelCacheUI());

  // 范围切「仅人物」时启用分割模型/背景下拉并预加载分割模型；切回「全图」时释放
  personModeSelect.addEventListener('change', () => {
    const person = personModeSelect.value === 'person';
    segModelSelect.disabled = !person;
    personBgSelect.disabled = !person;
    if (person) {
      if (!processing) void ensureSegmenter();
    } else {
      closeSegmenter();
    }
  });
  // 切换分割后端后下次处理重新加载对应模型
  segModelSelect.addEventListener('change', closeSegmenter);

  // 深度图样式：平滑滑杆实时显示数值；换方向/平滑系数时重置平滑状态（原站行为）
  smoothRange.addEventListener('input', () => {
    smoothValue.textContent = Number(smoothRange.value).toFixed(2);
    resetSmoothState();
  });
  directionSelect.addEventListener('change', resetSmoothState);
  // 帧率影响「已选」文案中的 ≈帧数
  fpsSelect.addEventListener('change', updateTrimUI);

  // 胶片条裁剪：手柄拖拽/键盘 + 选区整段拖动 + 重置
  bindTrimDrag(trimL, 'L');
  bindTrimDrag(trimR, 'R');
  bindTrimDrag(trimRegion, 'region');
  bindTrimKeys(trimL, 'L');
  bindTrimKeys(trimR, 'R');
  rangeResetBtn.addEventListener('click', () => {
    if (processing || !videoFile) return;
    setTrim(0, videoDuration);
  });

  // 同步播放开关
  syncPlayButton.addEventListener('click', () => {
    if (syncing) stopSyncPlay();
    else startSyncPlay();
  });

  // 语言切换（原站：lang-btn click → MH + HW）
  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      if ((lang !== 'zh' && lang !== 'en') || lang === getLang()) return;
      setLang(lang);
      rerenderAll();
    });
  });

  gpuBadge.textContent = 'gpu' in navigator ? t('gpu.webgpu') : t('gpu.wasm');

  syncNcWarning();
  // 启动：同步 <html lang> 与偏好（原站启动时 MH(AH)），按当前语言渲染全页，再清理缓存并刷新缓存提示
  setLang(getLang());
  rerenderAll();
  void cleanupCaches().then(() => refreshModelCacheUI());

  // e2e 自测钩子（仅 dev）：直接断言掩码合成逻辑
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__dv = {
      compositePersonMask,
      depthCanvas,
      processCanvas,
      personBgSelect,
    };
  }
}
