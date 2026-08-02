/**
 * 片5 端到端自测：仅人物分割与 base 模型选项。
 * 用例A 真实分割链路（MediaPipe Selfie + 涂黑）：tflite 同源 200 加载（网络断言）+
 *        导出完成 + 处理中画布大面积纯黑（样片无人物 → 整帧背景 → 涂黑生效）。
 * 用例B 真实分割链路（MediaPipe Landscape + 保留原图）：landscape tflite 同源 200 + 导出完成。
 * 用例C 合成逻辑直测（dev 钩子 __dv.compositePersonMask + 合成掩码）：
 *        人物区保留 / 背景涂黑 / 背景保留原图 / alpha=128→背景、129→保留 阈值。
 * 用例D 强制分割加载失败（route 掐断 tflite）→ 回退全白掩码（=全图），处理完成且画布几乎无纯黑。
 * 用例E base 选项 NC 警示可见性 + 范围联动启用分割/背景下拉。
 * 用例F base fp16 档位开始下载（断言首次下载文案出现即通过，不等 ~187MB 下完，取舍见回报）。
 * 运行前先起 dev server（E2E_URL，默认 http://localhost:5199），模型缓存复用 .recon/e2e/profile。
 * 用法：node e2e/person.mjs   （E2E_DEVICE=wasm 可强制后端）
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = path.join(root, '.recon', 'e2e', 'sample.mp4');
const profile = path.join(root, '.recon', 'e2e', 'profile');
const outDir = path.join(root, '.recon', 'e2e');
const baseURL = process.env.E2E_URL || 'http://localhost:5199';

async function preparePage(page, { size = '384', fps = '8', device }) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#startButton', { timeout: 15_000 });
  await page.selectOption('#sizeSelect', size);
  await page.selectOption('#fpsSelect', fps);
  await page.selectOption('#deviceSelect', device);
  await page.setInputFiles('#fileInput', sample);
  await page.waitForFunction(
    () => (document.getElementById('sourceMeta').textContent || '').includes('640×360'),
    null,
    { timeout: 20_000 },
  );
}

/** 跑一轮完整处理，采样 statusLine 文案；返回 badge */
async function runToDone(page, label, statusSamples) {
  await page.click('#startButton');
  const sampler = setInterval(async () => {
    try {
      const s = await page.textContent('#statusLine');
      if (s) statusSamples.add(s.trim());
    } catch { /* 忽略 */ }
  }, 200);
  try {
    await page.waitForFunction(
      () => {
        const b = document.getElementById('outputBadge').textContent.trim();
        return ['已完成', '出错', '已取消'].includes(b);
      },
      null,
      { timeout: 900_000, polling: 500 },
    );
  } finally {
    clearInterval(sampler);
  }
  const badge = (await page.textContent('#outputBadge')).trim();
  const status = ((await page.textContent('#statusLine')) || '').trim();
  console.log(`[${label}] badge=${badge} status=${status.slice(0, 140)}`);
  if (badge !== '已完成') throw new Error(`[${label}] 未完成：${status}`);
}

/** 等到至少处理到第 n 帧后，统计 depthCanvas 纯黑像素占比 */
async function canvasBlackRatio(page, minFrame = 6) {
  await page.waitForFunction(
    (n) => {
      const m = /FRAME (\d+)/.exec(document.getElementById('liveFrameText').textContent || '');
      return m && Number(m[1]) >= n;
    },
    minFrame,
    { timeout: 300_000, polling: 300 },
  );
  return page.evaluate(() => {
    const c = document.getElementById('depthCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let black = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) black++;
      n++;
    }
    return black / n;
  });
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  acceptDownloads: true,
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});
try {
  const device = process.env.E2E_DEVICE || 'webgpu';

  // ---- 用例A：MediaPipe Selfie + 涂黑（真实分割链路） ----
  const pa = await context.newPage();
  pa.on('console', (m) => {
    if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200));
  });
  const tfliteResponses = [];
  pa.on('response', (r) => {
    if (r.url().includes('/mediapipe/selfie_segmenter')) {
      tfliteResponses.push({ url: r.url(), status: r.status() });
    }
  });
  await preparePage(pa, { device });
  await pa.selectOption('#personModeSelect', 'person');
  // 联动：分割模型与背景下拉被启用
  const enabled = await pa.evaluate(() => ({
    seg: !document.getElementById('segModelSelect').disabled,
    bg: !document.getElementById('personBgSelect').disabled,
  }));
  if (!enabled.seg || !enabled.bg) throw new Error(`仅人物未启用分割/背景下拉：${JSON.stringify(enabled)}`);
  await pa.selectOption('#segModelSelect', 'mediapipe');
  await pa.selectOption('#personBgSelect', 'black');

  const samplesA = new Set();
  const doneA = runToDone(pa, 'person-black', samplesA);
  const blackA = await canvasBlackRatio(pa, 6);
  console.log('[person-black] 纯黑像素占比:', blackA.toFixed(3));
  await doneA;
  if (blackA < 0.1) throw new Error(`涂黑未生效：纯黑占比仅 ${blackA}`);

  const selfieOk = tfliteResponses.some(
    (r) => r.status === 200 && r.url.startsWith(baseURL) && r.url.endsWith('/mediapipe/selfie_segmenter.tflite'),
  );
  console.log('[person-black] tflite 请求:', JSON.stringify(tfliteResponses));
  if (!selfieOk) throw new Error('selfie_segmenter.tflite 未从同源 200 加载');
  const sawGpuFallback = [...samplesA].some((s) => s.includes('MediaPipe GPU 不可用，改用 CPU'));
  console.log('[person-black] GPU→CPU 降级文案出现:', sawGpuFallback, '（两种路径均可接受）');
  await pa.close();

  // ---- 用例B：MediaPipe Landscape + 保留原图（真实分割链路） ----
  const pb = await context.newPage();
  const tfliteResponsesB = [];
  pb.on('response', (r) => {
    if (r.url().includes('/mediapipe/selfie_segmenter')) {
      tfliteResponsesB.push({ url: r.url(), status: r.status() });
    }
  });
  await preparePage(pb, { device });
  await pb.selectOption('#personModeSelect', 'person');
  await pb.selectOption('#segModelSelect', 'mediapipe-landscape');
  await pb.selectOption('#personBgSelect', 'original');
  const samplesB = new Set();
  await runToDone(pb, 'person-original', samplesB);
  const landscapeOk = tfliteResponsesB.some(
    (r) => r.status === 200 && r.url.startsWith(baseURL) && r.url.endsWith('/mediapipe/selfie_segmenter_landscape.tflite'),
  );
  console.log('[person-original] tflite 请求:', JSON.stringify(tfliteResponsesB));
  if (!landscapeOk) throw new Error('landscape tflite 未从同源 200 加载');
  await pb.close();

  // ---- 用例C：合成逻辑直测（dev 钩子 + 合成掩码） ----
  const pc = await context.newPage();
  await pc.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await pc.waitForSelector('#startButton', { timeout: 15_000 });
  const comp = await pc.evaluate(() => {
    const { compositePersonMask, depthCanvas, processCanvas, personBgSelect } = window.__dv;
    const W = 64;
    const H = 32;
    depthCanvas.width = W;
    depthCanvas.height = H;
    processCanvas.width = W;
    processCanvas.height = H;
    const dctx = depthCanvas.getContext('2d');
    const pctx = processCanvas.getContext('2d');
    const results = {};

    const setup = (fill) => {
      dctx.fillStyle = 'rgb(200,200,200)';
      dctx.fillRect(0, 0, W, H);
      pctx.fillStyle = 'rgb(10,20,30)';
      pctx.fillRect(0, 0, W, H);
      if (fill !== undefined) {
        const mask = { data: new Uint8ClampedArray(W * H).fill(fill), width: W, height: H };
        compositePersonMask(mask);
        return dctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
      }
      return null;
    };

    // 左半人物(255) 右半背景(0)
    const mask = { data: new Uint8ClampedArray(W * H), width: W, height: H };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) mask.data[y * W + x] = x < W / 2 ? 255 : 0;
    }
    personBgSelect.value = 'black';
    dctx.fillStyle = 'rgb(200,200,200)';
    dctx.fillRect(0, 0, W, H);
    pctx.fillStyle = 'rgb(10,20,30)';
    pctx.fillRect(0, 0, W, H);
    compositePersonMask(mask);
    const img = dctx.getImageData(0, 0, W, H).data;
    results.black = {
      person: [img[0], img[1], img[2]],
      bg: [img[(W - 1) * 4], img[(W - 1) * 4 + 1], img[(W - 1) * 4 + 2]],
    };

    personBgSelect.value = 'original';
    dctx.fillStyle = 'rgb(200,200,200)';
    dctx.fillRect(0, 0, W, H);
    compositePersonMask(mask);
    const img2 = dctx.getImageData(0, 0, W, H).data;
    results.original = {
      person: [img2[0], img2[1], img2[2]],
      bg: [img2[(W - 1) * 4], img2[(W - 1) * 4 + 1], img2[(W - 1) * 4 + 2]],
    };

    // 阈值：128 → 背景，129 → 保留
    personBgSelect.value = 'black';
    results.at128 = Array.from(setup(128));
    results.at129 = Array.from(setup(129));
    return results;
  });
  console.log('[composite] ', JSON.stringify(comp));
  const eq = (a, b) => a.every((v, i) => v === b[i]);
  if (!eq(comp.black.person, [200, 200, 200])) throw new Error(`人物区未保留深度：${comp.black.person}`);
  if (!eq(comp.black.bg, [0, 0, 0])) throw new Error(`背景未涂黑：${comp.black.bg}`);
  if (!eq(comp.original.person, [200, 200, 200])) throw new Error(`人物区未保留深度：${comp.original.person}`);
  if (!eq(comp.original.bg, [10, 20, 30])) throw new Error(`背景未保留原图：${comp.original.bg}`);
  if (!eq(comp.at128, [0, 0, 0])) throw new Error(`alpha=128 应视为背景：${comp.at128}`);
  if (!eq(comp.at129, [200, 200, 200])) throw new Error(`alpha=129 应保留：${comp.at129}`);
  console.log('[composite] 断言通过：保留/涂黑/保留原图/128 阈值');
  await pc.close();

  // ---- 用例D：强制分割加载失败 → 回退全白掩码（=全图），处理完成 ----
  const pd = await context.newPage();
  await pd.route('**/mediapipe/*.tflite', (route) => route.abort());
  await preparePage(pd, { device });
  await pd.selectOption('#personModeSelect', 'person');
  await pd.selectOption('#personBgSelect', 'black'); // 即便选了涂黑，回退后应为全图（无黑块）
  const samplesD = new Set();
  const doneD = runToDone(pd, 'seg-fallback', samplesD);
  const blackD = await canvasBlackRatio(pd, 6);
  console.log('[seg-fallback] 纯黑像素占比:', blackD.toFixed(3));
  await doneD;
  const sawFallback = [...samplesD].some((s) => s.includes('人物分割不可用，已回退为全图处理'));
  console.log('[seg-fallback] 回退文案出现:', sawFallback);
  if (!sawFallback) throw new Error('未出现分割失败回退文案');
  if (blackD > 0.01) throw new Error(`回退全图失败：纯黑占比 ${blackD}（应为全图深度）`);
  await pd.close();

  // ---- 用例E：base 选项 NC 警示 + 范围联动禁用 ----
  const pe = await context.newPage();
  await pe.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await pe.waitForSelector('#startButton', { timeout: 15_000 });
  const warn0 = await pe.evaluate(() => document.getElementById('baseNcWarning').hidden);
  if (!warn0) throw new Error('默认（small）时 NC 警示应隐藏');
  await pe.selectOption('#modelSelect', 'onnx-community/depth-anything-v2-base-ONNX::fp16');
  const warn1 = await pe.evaluate(() => ({
    hidden: document.getElementById('baseNcWarning').hidden,
    text: document.getElementById('baseNcWarning').textContent.trim(),
  }));
  console.log('[nc] 警示:', JSON.stringify(warn1));
  if (warn1.hidden) throw new Error('选 base 后 NC 警示未显示');
  if (!warn1.text.includes('CC-BY-NC') || !warn1.text.includes('禁止商用'))
    throw new Error(`NC 警示文案不符：${warn1.text}`);
  await pe.selectOption('#modelSelect', 'onnx-community/depth-anything-v2-small-ONNX::fp16');
  const warn2 = await pe.evaluate(() => document.getElementById('baseNcWarning').hidden);
  if (!warn2) throw new Error('切回 small 后 NC 警示应隐藏');
  const disabled0 = await pe.evaluate(() => ({
    seg: document.getElementById('segModelSelect').disabled,
    bg: document.getElementById('personBgSelect').disabled,
  }));
  if (!disabled0.seg || !disabled0.bg) throw new Error('全图模式下分割/背景下拉应禁用');
  console.log('[nc] 断言通过：警示随 base 档位显隐，全图时分割控件禁用');

  // ---- 用例F：base fp16 开始下载（不等 ~187MB 下完） ----
  await pe.setInputFiles('#fileInput', sample);
  await pe.waitForFunction(
    () => (document.getElementById('sourceMeta').textContent || '').includes('640×360'),
    null,
    { timeout: 20_000 },
  );
  await pe.selectOption('#sizeSelect', '384');
  await pe.selectOption('#fpsSelect', '8');
  await pe.selectOption('#deviceSelect', device);
  await pe.selectOption('#modelSelect', 'onnx-community/depth-anything-v2-base-ONNX::fp16');
  await pe.click('#startButton');
  // 断言「首次下载 V2 Base（~187MB）」或下载进度文案出现即可（超时 180s）
  await pe.waitForFunction(
    () => {
      const s = document.getElementById('statusLine').textContent || '';
      const t = document.getElementById('progressTitle').textContent || '';
      return (
        (s.includes('V2 Base · ONNX') && s.includes('~187MB')) ||
        s.includes('正在下载模型') ||
        t.includes('下载模型') ||
        s.includes('模型已缓存') ||
        s.includes('出错') ||
        s.includes('处理失败')
      );
    },
    null,
    { timeout: 180_000, polling: 500 },
  );
  const baseStatus = ((await pe.textContent('#statusLine')) || '').trim();
  const baseTitle = ((await pe.textContent('#progressTitle')) || '').trim();
  console.log(`[base] title=${baseTitle} status=${baseStatus.slice(0, 140)}`);
  if (baseStatus.includes('处理失败') || baseStatus.includes('出错'))
    throw new Error(`base 档位加载直接失败：${baseStatus}`);
  await pe.screenshot({ path: path.join(outDir, 'person-base-download.png') });
  console.log('[base] 断言通过：base fp16 档位进入下载/初始化流程（未等全量下载，取舍见回报）');

  console.log('\nPASS: 仅人物分割（真实链路/合成逻辑/失败回退）+ NC 警示 + base 档位 全部通过');
} finally {
  await context.close();
}
