/**
 * 片4 端到端自测：设置项逐项生效。
 * 用例A 热力样式（Jet 彩色，非灰度）+ 时域平滑 k=0 vs k=0.85 帧间差异；
 * 用例B 分辨率档位改动 → 导出 MP4 尺寸跟随且为偶数；
 * 用例C fps 改动 → 导出帧率/时长正确；
 * 用例D 胶片条裁剪手柄拖拽 → 导出时长 ≈ 裁剪区间；导出后同步播放开关。
 * 运行前先起 dev server（E2E_URL，默认 http://localhost:5199），模型缓存复用 .recon/e2e/profile。
 * 用法：node e2e/settings.mjs   （E2E_DEVICE=wasm 可强制后端）
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

async function preparePage(page, { size, fps, device }) {
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

async function waitDone(page, label) {
  await page.waitForFunction(
    () => {
      const b = document.getElementById('outputBadge').textContent.trim();
      return ['已完成', '出错', '已取消'].includes(b);
    },
    null,
    { timeout: 900_000, polling: 500 },
  );
  const badge = (await page.textContent('#outputBadge')).trim();
  const status = ((await page.textContent('#statusLine')) || '').trim();
  console.log(`[${label}] badge=${badge} status=${status.slice(0, 140)}`);
  if (badge !== '已完成') throw new Error(`[${label}] 未完成：${status}`);
}

async function grabDownload(page, file) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('#downloadButton'),
  ]);
  await download.saveAs(file);
  return download.suggestedFilename();
}

/**
 * 页内轮询 liveFrameText，捕获相邻两个已处理帧的画布内容并返回逐像素平均绝对差。
 * 帧循环末尾有 rAF 让出，30ms 轮询能赶上每一帧。
 */
// 采样策略：不依赖 liveFrameText 文案，直接盯 depthCanvas 的换帧（像素变化）。
// 文案更新与 canvas 绘制之间存在竞态（曾导致相邻帧差异偶发采到 ~1.5 vs ~31），
// 因此连续收集多次真实换帧差异并取中位数，消除单对采样异常。
async function captureConsecutiveDiff(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const c = document.getElementById('depthCanvas');
        const ctx = c.getContext('2d');
        const frameDiff = (a, b) => {
          let sum = 0;
          let cnt = 0;
          for (let i = 0; i < a.length; i += 40) {
            sum += Math.abs(a[i] - b[i]);
            cnt++;
          }
          return sum / cnt;
        };
        let prev = ctx.getImageData(0, 0, c.width, c.height).data;
        const diffs = [];
        const t0 = Date.now();
        const finish = () => {
          clearInterval(timer);
          if (!diffs.length) return resolve(null);
          const sorted = [...diffs].sort((a, b) => a - b);
          resolve({ n: diffs.length, diff: sorted[Math.floor(sorted.length / 2)] });
        };
        const timer = setInterval(() => {
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const delta = frameDiff(d, prev);
          if (delta > 0.05) {
            // 画布确实重绘了：记一次真实的相邻渲染帧差异
            diffs.push(delta);
            prev = d;
            if (diffs.length >= 5) return finish();
          }
          if (Date.now() - t0 > 15_000) return finish();
        }, 40);
        setTimeout(finish, 20_000);
      }),
  );
}

async function cancelAndWait(page) {
  await page.click('#cancelButton');
  await page.waitForFunction(
    () => document.getElementById('outputBadge').textContent.trim() === '已取消',
    null,
    { timeout: 120_000, polling: 300 },
  );
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  locale: 'zh-CN', // 片6：固定中文环境（原站按 navigator.language 探测默认语言）
  acceptDownloads: true,
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});
try {
  const device = process.env.E2E_DEVICE || 'webgpu';

  // ---- 用例A：热力样式 + 时域平滑极值 ----
  const pa = await context.newPage();
  pa.on('console', (m) => {
    if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 200));
  });
  await preparePage(pa, { size: '384', fps: '8', device });
  await pa.selectOption('#styleSelect', 'turbo');
  await pa.selectOption('#directionSelect', 'far-white');

  // 平滑滑杆：改动即时反映在 #smoothValue
  await pa.evaluate(() => {
    const r = document.getElementById('smoothRange');
    r.value = '0';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const smoothShown = (await pa.textContent('#smoothValue')).trim();
  if (smoothShown !== '0.00') throw new Error(`smoothValue 未跟随滑杆：${smoothShown}`);

  // A1：k=0（无平滑），热力 + 远白
  await pa.click('#startButton');
  await pa.waitForFunction(
    () => /FRAME [2-9]/.test(document.getElementById('liveFrameText').textContent || ''),
    null,
    { timeout: 300_000, polling: 300 },
  );
  const colorStats = await pa.evaluate(() => {
    const c = document.getElementById('depthCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let colored = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const spread = Math.max(
        Math.abs(d[i] - d[i + 1]),
        Math.abs(d[i + 1] - d[i + 2]),
        Math.abs(d[i] - d[i + 2]),
      );
      if (spread > 40) colored++;
      n++;
    }
    return { ratio: colored / n };
  });
  console.log('[turbo] 彩色像素占比:', colorStats.ratio.toFixed(3));
  if (colorStats.ratio < 0.01) throw new Error('热力样式下画布仍为灰度（Jet 未生效）');
  await pa.screenshot({ path: path.join(outDir, 'settings-turbo.png') });

  const diff0 = await captureConsecutiveDiff(pa);
  console.log('[smooth] k=0 相邻帧差异:', JSON.stringify(diff0));
  if (!diff0 || diff0.diff < 0.5) throw new Error('k=0 时未捕获到有效帧差异');
  await cancelAndWait(pa);

  // A2：k=0.85（强平滑）
  await pa.evaluate(() => {
    const r = document.getElementById('smoothRange');
    r.value = '0.85';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pa.click('#startButton');
  await pa.waitForFunction(
    () => /FRAME [2-9]/.test(document.getElementById('liveFrameText').textContent || ''),
    null,
    { timeout: 300_000, polling: 300 },
  );
  const diff85 = await captureConsecutiveDiff(pa);
  console.log('[smooth] k=0.85 相邻帧差异:', JSON.stringify(diff85));
  if (!diff85) throw new Error('k=0.85 时未捕获到相邻帧');
  if (diff85.diff >= diff0.diff * 0.6)
    throw new Error(`平滑未生效：k=0.85 差异 ${diff85.diff} 未显著小于 k=0 差异 ${diff0.diff}`);
  console.log(`[smooth] 断言通过：${diff85.diff.toFixed(2)} < 0.6 × ${diff0.diff.toFixed(2)}`);
  await cancelAndWait(pa);

  // ---- 用例B：分辨率档位 512 → 导出 512×288（偶数） ----
  const pb = await context.newPage();
  await preparePage(pb, { size: '512', fps: '8', device });
  await pb.click('#startButton');
  await waitDone(pb, 'size-512');
  const fileB = path.join(outDir, 'settings-512.mp4');
  await grabDownload(pb, fileB);
  const probeB = ffprobe(fileB);
  const stB = probeB.streams[0];
  console.log('[size] ffprobe:', JSON.stringify({ w: stB.width, h: stB.height }));
  if (stB.width !== 512 || stB.height !== 288)
    throw new Error(`分辨率未跟随档位：${stB.width}×${stB.height}`);
  if (stB.width % 2 || stB.height % 2) throw new Error('分辨率未偶数对齐');
  console.log('[size] 断言通过：512×288 且两维为偶数');

  // ---- 用例C：fps 12 → 导出 12fps、48 帧 ≈ 4.0s ----
  const pc = await context.newPage();
  await preparePage(pc, { size: '384', fps: '12', device });
  await pc.click('#startButton');
  await waitDone(pc, 'fps-12');
  const fileC = path.join(outDir, 'settings-12fps.mp4');
  const nameC = await grabDownload(pc, fileC);
  if (nameC !== 'sample-depth-12fps.mp4') throw new Error(`文件名不符：${nameC}`);
  const probeC = ffprobe(fileC);
  const stC = probeC.streams[0];
  const durC = Number(probeC.format.duration);
  console.log('[fps] ffprobe:', JSON.stringify({ rate: stC.r_frame_rate, dur: durC }));
  if (stC.r_frame_rate !== '12/1') throw new Error(`导出帧率不符：${stC.r_frame_rate}`);
  if (Math.abs(durC - 4.0) > 0.3) throw new Error(`导出时长不符：${durC}s（期望 48 帧 ≈ 4.0s）`);
  console.log('[fps] 断言通过：12fps · ≈4.0s');

  // ---- 用例D：裁剪手柄拖拽 → 导出时长 ≈ 裁剪区间；同步播放 ----
  const pd = await context.newPage();
  await preparePage(pd, { size: '384', fps: '8', device });
  await pd.waitForFunction(() => !document.getElementById('trimWrap').hidden, null, {
    timeout: 10_000,
  });
  const info0 = (await pd.textContent('#rangeInfo')).trim();
  console.log('[trim] 初始 rangeInfo:', info0);
  if (!info0.includes('已选：0.0s – 4.0s')) throw new Error(`初始裁剪区间异常：${info0}`);

  // 拖右手柄到胶片条 50% 处（4s 视频 → 出点 ≈ 2.0s）
  const barBox = await pd.locator('#trimBar').boundingBox();
  const handleBox = await pd.locator('#trimR').boundingBox();
  if (!barBox || !handleBox) throw new Error('胶片条/手柄不可见');
  const startX = handleBox.x + handleBox.width / 2;
  const targetX = barBox.x + barBox.width * 0.5;
  const y = handleBox.y + handleBox.height / 2;
  await pd.mouse.move(startX, y);
  await pd.mouse.down();
  await pd.mouse.move(targetX, y, { steps: 12 });
  await pd.mouse.up();
  const info1 = (await pd.textContent('#rangeInfo')).trim();
  console.log('[trim] 拖拽后 rangeInfo:', info1);
  const mEnd = /已选：([\d.]+)s – ([\d.]+)s/.exec(info1);
  if (!mEnd) throw new Error(`rangeInfo 文案异常：${info1}`);
  const trimEndVal = Number(mEnd[2]);
  if (Math.abs(trimEndVal - 2.0) > 0.2) throw new Error(`裁剪出点异常：${trimEndVal}s`);

  await pd.click('#startButton');
  await waitDone(pd, 'trimmed');
  const fileD = path.join(outDir, 'settings-trim.mp4');
  await grabDownload(pd, fileD);
  const probeD = ffprobe(fileD);
  const durD = Number(probeD.format.duration);
  const expectedD = Math.max(1, Math.ceil(trimEndVal * 8)) / 8;
  console.log('[trim] ffprobe 时长:', durD, '期望 ≈', expectedD);
  if (Math.abs(durD - expectedD) > 0.3)
    throw new Error(`裁剪后导出时长不符：${durD}s vs ${expectedD}s`);
  console.log('[trim] 断言通过：导出时长 ≈ 裁剪区间');

  // 同步播放：导出完成 → 可用；点击后双视频同步播放，再点停止
  const syncEnabled = await pd.evaluate(
    () => !document.getElementById('syncPlayButton').disabled,
  );
  if (!syncEnabled) throw new Error('导出完成后同步播放未启用');
  // 用例D 导出结束后源视频停在裁切出点（≈2.1s），结果视频全长 2.125s；
  // 直接同步会把结果视频 seek 到片尾立即 ended。先将源视频倒回 0 再测同步启停。
  await pd.evaluate(() => {
    document.getElementById('sourceVideo').currentTime = 0;
  });
  await pd.waitForFunction(
    () => document.getElementById('sourceVideo').currentTime < 0.2,
    null,
    { timeout: 10_000 },
  );
  // 等两个视频均可播放再点击，避免 headless 下解码未就绪导致 play() 悬起（偶发 10s 超时）
  await pd.waitForFunction(
    () => {
      const s = document.getElementById('sourceVideo');
      const r = document.getElementById('resultVideo');
      return s.readyState >= 2 && r.readyState >= 2;
    },
    null,
    { timeout: 30_000 },
  );
  await pd.click('#syncPlayButton');
  await pd.waitForFunction(
    () => {
      const s = document.getElementById('sourceVideo');
      const r = document.getElementById('resultVideo');
      return !s.paused && !r.paused;
    },
    null,
    { timeout: 30_000 },
  );
  const syncLabel = (await pd.textContent('#syncPlayButton')).trim();
  if (!syncLabel.includes('停止同步')) throw new Error(`同步播放文案异常：${syncLabel}`);
  await pd.click('#syncPlayButton');
  await pd.waitForFunction(
    () => {
      const s = document.getElementById('sourceVideo');
      const r = document.getElementById('resultVideo');
      return s.paused && r.paused;
    },
    null,
    { timeout: 30_000 },
  );
  console.log('[sync] 断言通过：同步播放启动/停止正常');

  console.log('\nPASS: 样式/平滑/分辨率/帧率/裁剪/同步播放 全部通过');
} finally {
  await context.close();
}
