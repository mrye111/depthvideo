/**
 * 镜头分析页（/shots.html）：上传视频 → 浏览器内 TransNet V2 转场检测 →
 * 时间轴（概率曲线/切点/分段）+ 镜头卡片 + 结果记忆 + JSON 导出。
 * 全程离线可用；不修改、不依赖深度工具主页的任何模块（i18n/样式为共享只读）。
 * 流水线：抽帧与推理窗口级交叠（当前窗口 GPU 推理时预取下一窗口帧）。
 */
import '../style.css';
import { t, getLang, setLang, applyI18n, syncLangButtons } from '../i18n';
import { loadTransnet, transnetBackend, inferWindow } from './transnet';
import { createFrameExtractor, type FrameExtractor } from './extract';
import { Timeline } from './timeline';
import { saveResult, loadResult } from './memory';
import { buildExport, downloadJson } from './exporter';

const WIN = 100;
const FRAME_LEN = 27 * 48 * 3;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const fileInput = $<HTMLInputElement>('fileInput');
const pickButton = $<HTMLButtonElement>('pickButton');
const dropZone = $<HTMLElement>('dropZone');
const fileNameEl = $<HTMLElement>('fileName');
const previewCard = $<HTMLElement>('previewCard');
const preview = $<HTMLVideoElement>('preview');
const metaRes = $<HTMLElement>('metaRes');
const metaDur = $<HTMLElement>('metaDur');
const metaFps = $<HTMLElement>('metaFps');
const longVideoHint = $<HTMLElement>('longVideoHint');
const startButton = $<HTMLButtonElement>('startButton');
const cancelButton = $<HTMLButtonElement>('cancelButton');
const progressBar = $<HTMLElement>('progressBar');
const statusLine = $<HTMLElement>('statusLine');
const resultCard = $<HTMLElement>('resultCard');
const shotCards = $<HTMLElement>('shotCards');
const emptyHint = $<HTMLElement>('emptyHint');
const epBadge = $<HTMLElement>('epBadge');
const exportButton = $<HTMLButtonElement>('exportButton');
const timelineCanvas = $<HTMLCanvasElement>('timelineCanvas');
const thumbCanvas = $<HTMLCanvasElement>('thumbCanvas');

type Bound = { frame: number; prob: number };
type Shot = {
  index: number;
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  boundaryProbBefore: number | null;
};
type StatusDyn = { key: string; params?: Record<string, string | number> };

const timeline = new Timeline(timelineCanvas);

let videoFile: File | null = null;
let videoUrl: string | null = null;
let extractor: FrameExtractor | null = null;
let fps = 25;
let detecting = false;
let cancelled = false;
let lastShots: Shot[] = [];
let lastBounds: Bound[] = [];
let lastProbs: Float32Array | null = null;
let selectedShot = -1;
let statusDyn: StatusDyn | null = null;

function setStatus(dyn: StatusDyn | null): void {
  statusDyn = dyn;
  statusLine.textContent = dyn ? t(dyn.key, dyn.params) : '';
}

function setProgress(pct: number): void {
  progressBar.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
}

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name);
}

function waitMetadata(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('视频元数据读取超时')), 10_000);
    preview.addEventListener(
      'loadedmetadata',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function seekPreview(tSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('preview seek 超时'));
    }, 5_000);
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('preview seek 失败'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      preview.removeEventListener('seeked', onSeeked);
      preview.removeEventListener('error', onError);
    };
    preview.addEventListener('seeked', onSeeked);
    preview.addEventListener('error', onError);
    preview.pause();
    preview.currentTime = Math.min(tSec, Math.max(0, preview.duration - 0.001));
  });
}

async function loadVideo(file: File): Promise<void> {
  if (!isVideoFile(file)) {
    setStatus({ key: 'shots.badFile' });
    return;
  }
  if (detecting) return;
  videoFile = file;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  preview.src = videoUrl;
  fileNameEl.hidden = false;
  fileNameEl.textContent = file.name;
  emptyHint.hidden = true;
  resultCard.hidden = true;
  lastShots = [];
  lastBounds = [];
  lastProbs = null;
  selectedShot = -1;
  exportButton.disabled = true;
  await waitMetadata();
  previewCard.hidden = false;
  metaRes.textContent = `${preview.videoWidth}×${preview.videoHeight}`;
  metaDur.textContent = `${preview.duration.toFixed(2)} s`;
  metaFps.textContent = '…';
  startButton.disabled = true;

  extractor = createFrameExtractor(preview);

  // 结果记忆：同一文件（名字+大小+最后修改）直接恢复，免重检
  const stored = loadResult(file);
  if (stored && stored.nFrames > 0) {
    fps = stored.fps;
    metaFps.textContent = String(fps);
    lastBounds = stored.bounds;
    lastProbs = stored.probs ? new Float32Array(stored.probs) : null;
    lastShots = buildShots(lastBounds, stored.nFrames);
    timeline.setData(lastProbs, lastBounds, lastShots, fps);
    renderCards();
    exportButton.disabled = false;
    updateLongVideoHint(stored.nFrames);
    setStatus({ key: 'shots.restored', params: { shots: lastShots.length } });
    startButton.disabled = false;
    void fillThumbs();
    return;
  }

  try {
    fps = await extractor.probeFps();
  } catch (e) {
    console.warn('帧率探测失败，按 25 处理', e);
    fps = 25;
  }
  metaFps.textContent = String(fps);
  updateLongVideoHint(extractor.totalFrames(fps));
  startButton.disabled = false;
  setStatus(null);
}

function updateLongVideoHint(frames: number): void {
  if (frames > 15000) {
    longVideoHint.hidden = false;
    longVideoHint.textContent = t('shots.longVideo', {
      frames,
      min: Math.ceil((frames * 0.006 + (frames / 100) * 0.3) / 60),
    });
  } else {
    longVideoHint.hidden = true;
  }
}

/** 逐帧概率 → 切点帧：连续 >0.5 的区段合并，取概率峰值帧 */
function pickBoundaries(probs: Float32Array): number[] {
  const TH = 0.5;
  const bounds: number[] = [];
  let runStart = -1;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > TH && runStart < 0) runStart = i;
    if ((probs[i] <= TH || i === probs.length - 1) && runStart >= 0) {
      const end = probs[i] <= TH ? i - 1 : i;
      let maxI = runStart;
      for (let j = runStart; j <= end; j++) if (probs[j] > probs[maxI]) maxI = j;
      bounds.push(maxI);
      runStart = -1;
    }
  }
  return bounds;
}

/** 切点（切在该帧之后）→ 镜头区间（含入侧边界置信度） */
function buildShots(bounds: Bound[], nFrames: number): Shot[] {
  const shots: Shot[] = [];
  let start = 0;
  const edges = [...bounds.map((b) => ({ endExclusive: b.frame + 1, prob: b.prob })), { endExclusive: nFrames, prob: -1 }];
  for (const e of edges) {
    shots.push({
      index: shots.length + 1,
      startFrame: start,
      endFrame: e.endExclusive - 1,
      startSec: start / fps,
      endSec: e.endExclusive / fps,
      boundaryProbBefore: shots.length === 0 ? null : e.prob >= 0 ? e.prob : null,
    });
    start = e.endExclusive;
  }
  // boundaryProbBefore 语义：该镜头「开始处」的切点置信——第 i 个镜头取其前面的切点概率
  for (let i = 1; i < shots.length; i++) {
    shots[i].boundaryProbBefore = bounds[i - 1] ? bounds[i - 1].prob : null;
  }
  return shots;
}

function renderCards(): void {
  shotCards.innerHTML = '';
  for (const s of lastShots) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className =
      'shot-card flex items-center gap-3 rounded-lg border border-line p-2 text-left hover:border-accent' +
      (s.index - 1 === selectedShot ? ' border-accent ring-1 ring-accent' : '');
    card.dataset.index = String(s.index);
    const conf =
      s.boundaryProbBefore !== null
        ? ` · ${t('shots.boundaryProb', { prob: s.boundaryProbBefore.toFixed(2) })}`
        : '';
    card.innerHTML =
      `<img class="shot-thumb h-[54px] w-[96px] shrink-0 rounded bg-black object-cover" alt="" />` +
      `<span class="min-w-0 flex-1">` +
      `<span class="block truncate font-mono text-sm">#${s.index} · ${s.startSec.toFixed(2)}s – ${s.endSec.toFixed(2)}s</span>` +
      `<span class="block text-xs text-muted">${(s.endSec - s.startSec).toFixed(2)}s · ${s.startFrame}–${s.endFrame}${t('shots.framesSuffix')}${conf}</span>` +
      `</span>`;
    card.addEventListener('click', () => selectShot(s.index - 1, true));
    shotCards.appendChild(card);
  }
  resultCard.hidden = lastShots.length === 0;
}

function selectShot(idx: number, seek: boolean): void {
  selectedShot = idx;
  timeline.setSelected(idx);
  Array.from(shotCards.children).forEach((el, i) => {
    (el as HTMLElement).classList.toggle('border-accent', i === idx);
    (el as HTMLElement).classList.toggle('ring-1', i === idx);
    (el as HTMLElement).classList.toggle('ring-accent', i === idx);
  });
  if (seek && lastShots[idx]) {
    preview.currentTime = lastShots[idx].startSec + 0.001;
  }
}

/** 逐镜头中帧缩略图（检测完成/恢复后顺序填充） */
async function fillThumbs(): Promise<void> {
  const tc = thumbCanvas.getContext('2d')!;
  for (const s of lastShots) {
    const img = shotCards.querySelector<HTMLImageElement>(
      `[data-index="${s.index}"] .shot-thumb`,
    );
    if (!img) continue;
    try {
      await seekPreview((s.startSec + s.endSec) / 2);
      tc.drawImage(preview, 0, 0, 160, 90);
      img.src = thumbCanvas.toDataURL('image/jpeg', 0.7);
    } catch {
      /* 单张失败保留占位 */
    }
  }
  preview.currentTime = 0;
}

async function extractWindow(k: number, nFrames: number, buf: Float32Array): Promise<number> {
  const s = k * WIN;
  const len = Math.min(WIN, nFrames - s);
  for (let i = 0; i < len; i++) {
    if (cancelled) throw new Error('cancelled');
    await (extractor as FrameExtractor).grab(s + i, fps, buf, i * FRAME_LEN);
    if (i % 25 === 24) {
      setStatus({ key: 'shots.extracting', params: { done: s + i + 1, total: nFrames } });
      setProgress(((s + i + 1) / nFrames) * 60);
    }
  }
  // 尾部不足一窗：重复末帧补齐（票 #24 集成参数）
  for (let i = len; i < WIN; i++) {
    buf.copyWithin(i * FRAME_LEN, (len - 1) * FRAME_LEN, len * FRAME_LEN);
  }
  return len;
}

async function startDetection(): Promise<void> {
  if (!extractor || !videoFile || detecting) return;
  detecting = true;
  cancelled = false;
  startButton.disabled = true;
  pickButton.disabled = true;
  exportButton.disabled = true;
  cancelButton.disabled = false;
  resultCard.hidden = true;
  setProgress(0);
  try {
    setStatus({ key: 'shots.modelLoading' });
    await loadTransnet();
    epBadge.hidden = false;
    epBadge.textContent = t('shots.backend', { ep: transnetBackend ?? '?' });
    if (cancelled) throw new Error('cancelled');

    const ex = extractor;
    const nFrames = ex.totalFrames(fps);
    const nWin = Math.ceil(nFrames / WIN);
    const probs = new Float32Array(nFrames);
    const bufA = new Float32Array(WIN * FRAME_LEN);
    const bufB = new Float32Array(WIN * FRAME_LEN);

    await extractWindow(0, nFrames, bufA);
    for (let k = 0; k < nWin; k++) {
      if (cancelled) throw new Error('cancelled');
      // 当前窗口推理（GPU）与下一窗口抽帧（CPU seek）交叠：双缓冲防竞争
      const cur = k % 2 === 0 ? bufA : bufB;
      const nxt = k % 2 === 0 ? bufB : bufA;
      const p = inferWindow(cur);
      p.catch(() => {
        /* 取消路径下该 Promise 可能无人 await，避免未处理拒绝 */
      });
      if (k + 1 < nWin) await extractWindow(k + 1, nFrames, nxt);
      const { probs: pa } = await p;
      const len = Math.min(WIN, nFrames - k * WIN);
      probs.set(pa.subarray(0, len), k * WIN);
      const found = pickBoundaries(probs.subarray(0, k * WIN + len)).length;
      setStatus({ key: 'shots.inferring', params: { done: k + 1, total: nWin, bounds: found } });
      setProgress(60 + ((k + 1) / nWin) * 40);
    }

    const bounds = pickBoundaries(probs);
    lastBounds = bounds.map((f) => ({ frame: f, prob: probs[f] }));
    lastProbs = probs;
    lastShots = buildShots(lastBounds, nFrames);
    selectedShot = -1;
    timeline.setData(probs, lastBounds, lastShots, fps);
    renderCards();
    saveResult(videoFile, fps, nFrames, lastBounds, probs);
    exportButton.disabled = false;
    setStatus({ key: 'shots.done', params: { shots: lastShots.length, bounds: bounds.length } });
    setProgress(100);
    void fillThumbs();
  } catch (e) {
    if (cancelled) {
      setStatus({ key: 'shots.cancelled' });
    } else {
      console.error('转场检测失败', e);
      setStatus({ key: 'shots.failed', params: { msg: (e as Error)?.message || String(e) } });
    }
  } finally {
    detecting = false;
    cancelButton.disabled = true;
    pickButton.disabled = false;
    startButton.disabled = !videoFile;
    exportButton.disabled = lastShots.length === 0;
  }
}

function rerender(): void {
  applyI18n();
  syncLangButtons();
  document.title = t('shots.docTitle');
  if (statusDyn) setStatus(statusDyn);
  if (transnetBackend && !epBadge.hidden) {
    epBadge.textContent = t('shots.backend', { ep: transnetBackend });
  }
  renderCards();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
timeline.setHandlers({
  onSeek: (sec) => {
    preview.currentTime = sec;
  },
  onSelect: (idx) => selectShot(idx, false),
});
preview.addEventListener('timeupdate', () => {
  if (!detecting) timeline.setCurrentTime(preview.currentTime);
});

exportButton.addEventListener('click', () => {
  if (!videoFile || lastShots.length === 0) return;
  const data = buildExport(
    videoFile,
    {
      durationSec: preview.duration,
      fps,
      width: preview.videoWidth,
      height: preview.videoHeight,
    },
    lastBounds,
    lastShots.map((s) => ({
      index: s.index,
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: s.endSec - s.startSec,
      boundaryProbBefore: s.boundaryProbBefore,
    })),
  );
  downloadJson(data, videoFile.name.replace(/\.[^.]+$/, ''));
});

pickButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadVideo(f);
  fileInput.value = '';
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('border-accent');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-accent'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('border-accent');
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadVideo(f);
});
startButton.addEventListener('click', () => void startDetection());
cancelButton.addEventListener('click', () => {
  if (detecting) cancelled = true;
});

document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const lang = btn.dataset.lang;
    if ((lang !== 'zh' && lang !== 'en') || lang === getLang()) return;
    setLang(lang);
    rerender();
  });
});

// 启动：同步 <html lang> 与偏好，渲染全页
setLang(getLang());
rerender();
