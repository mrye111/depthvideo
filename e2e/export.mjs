/**
 * 片3 端到端自测：MP4 导出（ffprobe 断言规格）→ WebM 降级（禁用 WebCodecs）→ 取消复位与重跑。
 * 运行前先起 dev server（E2E_URL，默认 http://localhost:5199），模型缓存复用 .recon/e2e/profile。
 * 用法：node e2e/export.mjs   （E2E_DEVICE=wasm 可强制后端）
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = path.join(root, '.recon', 'e2e', 'sample.mp4');
const profile = path.join(root, '.recon', 'e2e', 'profile');
const outDir = path.join(root, '.recon', 'e2e');
const baseURL = process.env.E2E_URL || 'http://localhost:5199';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffprobe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration',
    '-show_entries', 'format=format_name,duration',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(out.toString());
}

async function exportCard(page) {
  return page.evaluate(() => ({
    cls: document.getElementById('exportCard').className,
    label: document.getElementById('exportStatusLabel').textContent.trim(),
    detail: document.getElementById('exportStatusDetail').textContent.trim(),
    downloadHidden: document.getElementById('downloadButton').hidden,
    downloadDisabled: document.getElementById('downloadButton').disabled,
  }));
}

async function preparePage(page, { disableWebCodecs = false, size, fps, device }) {
  if (disableWebCodecs) {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'VideoEncoder', { value: undefined, configurable: true });
      Object.defineProperty(window, 'VideoFrame', { value: undefined, configurable: true });
    });
  }
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
  // 载入视频后导出卡应出现（idle 态）
  const slotVisible = await page.evaluate(() => !document.getElementById('exportSlot').hidden);
  if (!slotVisible) throw new Error('视频载入后 exportSlot 未显示');
}

/** 跑一轮完整处理，返回结束状态；收集期间的 statusLine 采样 */
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

/** 点击下载并保存产物，返回 {file, filename} */
async function grabDownload(page, file) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('#downloadButton'),
  ]);
  await download.saveAs(file);
  return download.suggestedFilename();
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  acceptDownloads: true,
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});
try {
  const device = process.env.E2E_DEVICE || 'webgpu';

  // ---- 用例1：MP4 主路径（原始分辨率 640×360，8fps → 32 帧 ≈ 4s） ----
  const p1 = await context.newPage();
  p1.on('console', (m) => {
    if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200));
  });
  await preparePage(p1, { size: 'original', fps: '8', device });
  const samples1 = new Set();
  await runToDone(p1, 'mp4', samples1);

  const card1 = await exportCard(p1);
  console.log('[mp4] exportCard:', JSON.stringify(card1));
  if (card1.cls !== 'export-card export-ok') throw new Error(`导出卡状态异常：${card1.cls}`);
  if (card1.label !== '转换成功') throw new Error(`导出卡文案异常：${card1.label}`);
  if (!card1.detail.includes('MP4') || !card1.detail.includes('8fps'))
    throw new Error(`导出卡 detail 异常：${card1.detail}`);
  if (card1.downloadHidden || card1.downloadDisabled) throw new Error('下载按钮未可用');

  const mp4File = path.join(outDir, 'export.mp4');
  const mp4Name = await grabDownload(p1, mp4File);
  console.log('[mp4] 文件名:', mp4Name);
  if (mp4Name !== 'sample-depth-8fps.mp4') throw new Error(`文件名不符：${mp4Name}`);

  const probe1 = ffprobe(mp4File);
  const st1 = probe1.streams[0];
  console.log('[mp4] ffprobe:', JSON.stringify({ ...st1, format: probe1.format.format_name }));
  if (st1.codec_name !== 'h264') throw new Error(`编码不符：${st1.codec_name}`);
  if (st1.width !== 640 || st1.height !== 360)
    throw new Error(`分辨率不符：${st1.width}×${st1.height}`);
  if (st1.r_frame_rate !== '8/1') throw new Error(`帧率不符：${st1.r_frame_rate}`);
  const dur1 = Number(probe1.format.duration);
  if (Math.abs(dur1 - 4.0) > 0.3) throw new Error(`时长不符：${dur1}s`);
  console.log('[mp4] 断言通过：h264 640×360 8fps ≈4.0s');

  // ---- 用例2：WebM 降级（禁用 WebCodecs，走 captureStream+MediaRecorder） ----
  const p2 = await context.newPage();
  await preparePage(p2, { disableWebCodecs: true, size: '384', fps: '8', device });
  const samples2 = new Set();
  await runToDone(p2, 'webm', samples2);

  const sawFallback = [...samples2].some((s) => s.includes('已切换为 WebM'));
  console.log('[webm] 降级提示文案采样:', sawFallback);
  if (!sawFallback) throw new Error('未出现 WebM 降级提示文案');

  const card2 = await exportCard(p2);
  console.log('[webm] exportCard:', JSON.stringify(card2));
  if (card2.cls !== 'export-card export-ok' || !card2.detail.includes('WebM'))
    throw new Error(`WebM 导出卡异常：${JSON.stringify(card2)}`);

  const webmFile = path.join(outDir, 'export.webm');
  const webmName = await grabDownload(p2, webmFile);
  console.log('[webm] 文件名:', webmName);
  if (webmName !== 'sample-depth-8fps.webm') throw new Error(`文件名不符：${webmName}`);

  const probe2 = ffprobe(webmFile);
  const st2 = probe2.streams[0];
  console.log('[webm] ffprobe:', JSON.stringify({ ...st2, format: probe2.format.format_name }));
  if (!probe2.format.format_name.includes('webm') && !probe2.format.format_name.includes('matroska'))
    throw new Error(`容器不符：${probe2.format.format_name}`);
  if (!['vp9', 'vp8'].includes(st2.codec_name)) throw new Error(`编码不符：${st2.codec_name}`);
  if (st2.width !== 384 || st2.height !== 216)
    throw new Error(`分辨率不符：${st2.width}×${st2.height}`);
  const dur2 = Number(probe2.format.duration);
  if (dur2 < 2 || dur2 > 10) throw new Error(`WebM 时长异常：${dur2}s`);
  console.log('[webm] 断言通过：webm 容器 vp9/vp8 384×216 ≈4s');

  // ---- 用例3：取消路径（编码中取消 → 导出卡 warn 复位 → 重跑成功证明无悬挂 encoder） ----
  const p3 = await context.newPage();
  await preparePage(p3, { size: '384', fps: '8', device });
  await p3.click('#startButton');
  await p3.waitForFunction(
    () => /FRAME [2-9]/.test(document.getElementById('liveFrameText').textContent || ''),
    null,
    { timeout: 300_000, polling: 300 },
  );
  await p3.click('#cancelButton');
  await p3.waitForFunction(
    () => document.getElementById('outputBadge').textContent.trim() === '已取消',
    null,
    { timeout: 120_000, polling: 300 },
  );
  const card3 = await exportCard(p3);
  console.log('[cancel] exportCard:', JSON.stringify(card3));
  if (card3.cls !== 'export-card export-warn' || card3.label !== '已取消')
    throw new Error(`取消后导出卡未复位：${JSON.stringify(card3)}`);
  if (!card3.downloadHidden) throw new Error('取消后下载按钮仍可见');
  await p3.screenshot({ path: path.join(outDir, 'export-cancel.png') });

  // 重跑至完成：若 encoder 悬挂（未 close），再次 configure/encode 会失败
  const samples3 = new Set();
  await runToDone(p3, 'rerun-after-cancel', samples3);
  const card4 = await exportCard(p3);
  if (card4.cls !== 'export-card export-ok') throw new Error('取消后重跑未成功');
  console.log('[cancel] 断言通过：取消复位 + 重跑成功（无悬挂 encoder）');

  console.log('\nPASS: MP4 导出 / WebM 降级 / 取消复位 全部通过');
} finally {
  await context.close();
}
