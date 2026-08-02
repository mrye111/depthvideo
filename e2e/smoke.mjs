/**
 * 片2 端到端自测：上传 → 模型下载（ModelScope）→ 逐帧深度渲染 → 完成 → 取消 → 缓存命中。
 * 运行前先起 dev server（默认 http://localhost:5173），并生成 .recon/e2e/sample.mp4。
 * 用法：node e2e/smoke.mjs   （E2E_DEVICE=wasm 可强制后端）
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = path.join(root, '.recon', 'e2e', 'sample.mp4');
const profile = path.join(root, '.recon', 'e2e', 'profile');
const outDir = path.join(root, '.recon', 'e2e');
const baseURL = process.env.E2E_URL || 'http://localhost:5173';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitBadge(page, badges, timeoutMs) {
  await page.waitForFunction(
    (list) => list.includes(document.getElementById('outputBadge').textContent.trim()),
    badges,
    { timeout: timeoutMs, polling: 500 },
  );
  return (await page.textContent('#outputBadge')).trim();
}

async function runOnce(page, label, statusSamples) {
  const t0 = Date.now();
  await page.click('#startButton');
  await page.waitForFunction(
    () => /FRAME [1-9]/.test(document.getElementById('liveFrameText').textContent || ''),
    null,
    { timeout: 900_000, polling: 500 },
  );
  const firstFrameSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${label}] 首帧渲染耗时: ${firstFrameSec}s`);

  const stats = await page.evaluate(() => {
    const c = document.getElementById('depthCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let min = 255;
    let max = 0;
    let sum = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    return { w: c.width, h: c.height, min, max, mean: +(sum / n).toFixed(1) };
  });
  console.log(`[${label}] depthCanvas:`, JSON.stringify(stats));
  if (stats.max - stats.min < 10) throw new Error(`[${label}] 深度图疑似空白`);
  await page.screenshot({ path: path.join(outDir, `${label}-rendering.png`) });

  const badge = await waitBadge(page, ['已完成', '出错', '已取消'], 900_000);
  const status = ((await page.textContent('#statusLine')) || '').slice(0, 160);
  const frameMeta = (await page.textContent('#frameMeta')) || '';
  console.log(`[${label}] badge=${badge} frameMeta=${frameMeta} status=${status}`);
  await page.screenshot({ path: path.join(outDir, `${label}-done.png`) });
  return { badge, status, firstFrameSec: +firstFrameSec, elapsedSec: (Date.now() - t0) / 1000 };
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', // 使用系统已装 Chrome，免去 playwright chromium 下载
  headless: true,
  locale: 'zh-CN', // 片6：固定中文环境（原站按 navigator.language 探测默认语言）
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});
let sampler = null;
try {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 300));
  });

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#startButton', { timeout: 15_000 });
  console.log('gpuBadge:', (await page.textContent('#gpuBadge'))?.trim());

  // 小参数跑链路（真实推理，缩短耗时）
  await page.selectOption('#sizeSelect', '384');
  await page.selectOption('#fpsSelect', '8');
  let device = process.env.E2E_DEVICE || 'webgpu';
  await page.selectOption('#deviceSelect', device);

  // ---- run1：上传 + 首次下载模型 + 完整处理 ----
  await page.setInputFiles('#fileInput', sample);
  await page.waitForFunction(
    () => (document.getElementById('sourceMeta').textContent || '').includes('640×360'),
    null,
    { timeout: 20_000 },
  );
  console.log('sourceMeta:', (await page.textContent('#sourceMeta'))?.trim());
  console.log('inputBadge:', (await page.textContent('#inputBadge'))?.trim());

  const runStatuses = new Set();
  sampler = setInterval(async () => {
    try {
      const s = await page.textContent('#statusLine');
      if (s) runStatuses.add(s.trim());
    } catch { /* 页面跳转中忽略 */ }
  }, 200);

  let run1 = await runOnce(page, 'run1');
  if (run1.badge === '出错' && device === 'webgpu') {
    console.log('[run1] WebGPU 失败，改用 WASM 重试');
    device = 'wasm';
    await page.selectOption('#deviceSelect', 'wasm');
    run1 = await runOnce(page, 'run1b');
  }
  if (run1.badge !== '已完成') throw new Error(`run1 未完成：${run1.status}`);
  console.log(`[run1] 后端=${device} 总耗时=${run1.elapsedSec.toFixed(1)}s`);

  // ---- 取消测试 ----
  await page.click('#startButton');
  await page.waitForFunction(
    () => /FRAME [2-9]/.test(document.getElementById('liveFrameText').textContent || ''),
    null,
    { timeout: 300_000, polling: 300 },
  );
  await page.click('#cancelButton');
  const cancelBadge = await waitBadge(page, ['已取消', '出错'], 120_000);
  const cancelStatus = ((await page.textContent('#statusLine')) || '').trim();
  console.log(`[cancel] badge=${cancelBadge} status=${cancelStatus.slice(0, 120)}`);
  if (cancelBadge !== '已取消') throw new Error(`取消未生效：${cancelStatus}`);
  const startEnabled = await page.evaluate(
    () => !document.getElementById('startButton').disabled,
  );
  if (!startEnabled) throw new Error('取消后开始按钮未恢复可用');
  await page.screenshot({ path: path.join(outDir, 'cancel.png') });

  // ---- 缓存测试：刷新页面重跑，应命中 Cache API ----
  // ① 直接检查 Cache Storage 内容（transformers-cache-v2 含 fp16 权重与 config.json）
  const cacheInfo = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open('transformers-cache-v2');
    const keys = (await cache.keys()).map((r) => r.url);
    return {
      names,
      hasConfig: keys.some((u) => /depth-anything-v2-small-ONNX.*config\.json/i.test(u)),
      onnxFiles: keys.filter((u) => /model_fp16\.onnx/i.test(u)).length,
      sample: keys.find((u) => /model_fp16\.onnx(\?|$)/i.test(u)) ?? null,
    };
  });
  console.log('[cache] Cache Storage:', JSON.stringify(cacheInfo, null, 1));
  if (!cacheInfo.names.includes('transformers-cache-v2'))
    throw new Error('缺少 transformers-cache-v2 缓存');
  if (!cacheInfo.hasConfig || cacheInfo.onnxFiles < 1)
    throw new Error('缓存中缺少模型权重/config');

  runStatuses.clear();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#startButton', { timeout: 15_000 });
  await page.selectOption('#sizeSelect', '384');
  await page.selectOption('#fpsSelect', '8');
  await page.selectOption('#deviceSelect', device);
  await page.setInputFiles('#fileInput', sample);
  await page.waitForFunction(
    () => (document.getElementById('sourceMeta').textContent || '').includes('640×360'),
    null,
    { timeout: 20_000 },
  );
  const run2 = await runOnce(page, 'run2');
  clearInterval(sampler);
  sampler = null;
  if (run2.badge !== '已完成') throw new Error(`run2 未完成：${run2.status}`);
  // ② 状态文案：缓存命中时显示「模型已缓存」（瞬态文案，200ms 采样可能仍错过，故同时以耗时佐证）
  const hitCacheText = [...runStatuses].some((s) => s.includes('模型已缓存'));
  const redownloaded = [...runStatuses].some((s) => s.includes('正在下载模型（'));
  console.log(`[cache] 命中缓存状态文案=${hitCacheText} 出现重新下载=${redownloaded}`);
  console.log(`[cache] 首帧耗时 run1=${run1.firstFrameSec}s run2=${run2.firstFrameSec}s`);
  if (redownloaded) throw new Error('run2 出现重新下载，缓存未生效');
  if (!hitCacheText)
    console.log('[cache] 注意：未采样到「模型已缓存」瞬态文案，以 Cache Storage 内容与耗时为准');

  console.log('\nPASS: 上传/解码/推理/预览/进度/取消/缓存 全部通过');
} finally {
  if (sampler) clearInterval(sampler);
  await context.close();
}
