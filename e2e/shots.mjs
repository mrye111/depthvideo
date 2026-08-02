/**
 * 镜头分析页（/shots.html）e2e：上传样片 → TransNet 转场检测 → 镜头列表断言。
 * 样片：.recon/e2e/transitions.mp4（5 段：硬切@1s/2s/3s + 3.5-4.0s 叠化，25fps 126 帧，
 *       期望切点 ≈[24,49,74,91]，镜头=5）。缺失时按内置配方用 ffmpeg 现生成。
 * 用法：node e2e/shots.mjs   （E2E_DEVICE=wasm 强制 wasm 后端；E2E_URL 默认 http://localhost:5199）
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '.recon', 'e2e', 'transitions.mp4');
const profile = path.join(root, '.recon', 'e2e', 'profile-shots');
const device = process.env.E2E_DEVICE || 'webgpu';
const baseURL =
  (process.env.E2E_URL || 'http://localhost:5199') +
  (device === 'wasm' ? '/shots.html?ep=wasm' : '/shots.html');

const check = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) throw new Error(`断言失败：${label}`);
};

function findFfmpeg() {
  const cands = [
    process.env.FFMPEG_BIN,
    path.join(root, '.recon', 'bin', 'ffmpeg.exe'),
    path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 与验证票同配方：4 段硬切 + 末段叠化（切点位置构造已知） */
function ensureFixture() {
  if (fs.existsSync(fixture)) return;
  const ff = findFfmpeg();
  if (!ff) throw new Error('缺少样片且找不到 ffmpeg：请放 ffmpeg 到 .recon/bin/ffmpeg.exe 或设 FFMPEG_BIN');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  execFileSync(ff, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'gradients=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-filter_complex',
    '[0:v]trim=0:1,setpts=PTS-STARTPTS[v0];[1:v]trim=0:1,setpts=PTS-STARTPTS[v1];' +
      '[2:v]trim=0:1,setpts=PTS-STARTPTS[v2];[3:v]trim=0:1.5,setpts=PTS-STARTPTS[v3];' +
      '[4:v]trim=0:1.5,setpts=PTS-STARTPTS[v4];[v0][v1][v2]concat=n=3:v=1:a=0[base];' +
      '[v3][v4]xfade=transition=fade:duration=0.5:offset=0.5[tail];[base][tail]concat=n=2:v=1:a=0[out]',
    '-map', '[out]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    fixture,
  ], { stdio: 'ignore' });
  console.log('样片已生成:', fixture);
}

/** 与 e2e/i18n.mjs 同款：data-i18n* 渲染结果不得等于 key 本身、不得为空 */
async function scanMissingKeys(page) {
  return page.evaluate(() => {
    const bad = [];
    const probe = (selector, read) => {
      document.querySelectorAll(selector).forEach((el) => {
        const key = el.getAttribute(selector.replace(/[[\]]/g, ''));
        const v = read(el);
        if (!v || !v.trim() || v.trim() === key) bad.push(`${selector}=${key}`);
      });
    };
    probe('[data-i18n]', (el) => el.textContent);
    probe('[data-i18n-html]', (el) => el.innerHTML);
    probe('[data-i18n-aria]', (el) => el.getAttribute('aria-label'));
    probe('[data-i18n-title]', (el) => el.getAttribute('title'));
    return bad;
  });
}

ensureFixture();

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  locale: 'zh-CN',
  args: ['--no-proxy-server', '--enable-unsafe-webgpu'],
});
try {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[page-err]', m.text().slice(0, 250));
  });

  // ---- i18n：zh/en 双侧 0 缺失 ----
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#startButton', { state: 'attached', timeout: 15_000 });
  console.log('— i18n 缺失扫描');
  check((await page.textContent('h1'))?.trim() === '镜头分析', '中文标题');
  check((await scanMissingKeys(page)).length === 0, 'ZH 无缺失 key');
  await page.click('.lang-btn[data-lang="en"]');
  await page.waitForSelector('.lang-btn[data-lang="en"].is-active');
  check((await page.textContent('h1'))?.trim() === 'Shot Analysis', '英文标题');
  check((await scanMissingKeys(page)).length === 0, 'EN 无缺失 key');
  await page.click('.lang-btn[data-lang="zh"]');
  await page.waitForSelector('.lang-btn[data-lang="zh"].is-active');

  // ---- 上传 + 元信息 ----
  console.log('— 上传与元信息');
  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(
    () => !document.getElementById('previewCard').hidden,
    null,
    { timeout: 30_000, polling: 300 },
  );
  // 帧率探测约 1-2s，等 metaFps 落定再断言
  await page.waitForFunction(
    () => (document.getElementById('metaFps').textContent || '').trim() !== '…',
    null,
    { timeout: 30_000, polling: 300 },
  );
  check((await page.textContent('#metaRes'))?.trim() === '640×360', '分辨率 640×360');
  check(((await page.textContent('#metaDur')) || '').startsWith('5.0'), '时长 ≈5.0s');
  check((await page.textContent('#metaFps'))?.trim() === '25', '帧率探测 = 25');
  check(await page.evaluate(() => document.getElementById('emptyHint').hidden), '空态提示隐藏');

  // ---- 检测（完整跑通） ----
  console.log(`— 转场检测（${device}）`);
  await page.click('#startButton');
  await page.waitForFunction(
    () => /检测完成|失败/.test(document.getElementById('statusLine').textContent || ''),
    null,
    { timeout: 300_000, polling: 500 },
  );
  const status = ((await page.textContent('#statusLine')) || '').trim();
  console.log('  status:', status);
  const m = /检测完成：(\d+) 个镜头、(\d+) 处切点/.exec(status);
  if (!m) throw new Error(`检测未完成：${status}`);
  check(Number(m[1]) === 5, `镜头数 = 5（实际 ${m[1]}）`);
  check(Number(m[2]) === 4, `切点数 = 4（实际 ${m[2]}）`);
  const badge = (await page.textContent('#epBadge'))?.trim() || '';
  console.log('  epBadge:', badge);
  check(badge.includes(device === 'wasm' ? 'wasm' : 'webgpu'), `后端徽标 ${device}`);

  // 镜头行数与帧区间（边界容差 ±2）
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#shotRows tr')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      const m2 = /(\d+)–(\d+)/.exec(tds[3].textContent);
      return { start: Number(m2[1]), end: Number(m2[2]) };
    }),
  );
  console.log('  rows:', JSON.stringify(rows));
  check(rows.length === 5, '镜头行数 = 5');
  const cuts = rows.slice(0, -1).map((r) => r.end);
  const expected = [24, 49, 74, 91];
  check(
    cuts.every((c, i) => Math.abs(c - expected[i]) <= 2),
    `切点位置 ≈[24,49,74,91]（实际 ${JSON.stringify(cuts)}）`,
  );
  check(rows[0].start === 0 && rows[4].end >= 124, '首段从 0 起、末段到片尾');

  // ---- 取消路径（wasm 慢速下点取消；webgpu 过快则跳过） ----
  if (device === 'wasm') {
    console.log('— 取消路径');
    await page.click('#startButton');
    await page.waitForFunction(
      () => /抽帧|推理窗口|加载检测模型/.test(document.getElementById('statusLine').textContent || ''),
      null,
      { timeout: 30_000, polling: 200 },
    );
    await page.click('#cancelButton');
    await page.waitForFunction(
      () => (document.getElementById('statusLine').textContent || '').includes('已取消'),
      null,
      { timeout: 30_000, polling: 300 },
    );
    check(await page.evaluate(() => !document.getElementById('startButton').disabled), '取消后开始按钮恢复可用');
    // 取消后重跑应成功
    await page.click('#startButton');
    await page.waitForFunction(
      () => /检测完成/.test(document.getElementById('statusLine').textContent || ''),
      null,
      { timeout: 300_000, polling: 500 },
    );
    console.log('  ✓ 取消后重跑成功');
  } else {
    console.log('— 取消路径（跳过：webgpu 检测过快，wasm 模式覆盖）');
  }

  console.log(`\nPASS: 镜头分析页（i18n/上传/检测/列表${device === 'wasm' ? '/取消重跑' : ''}）全部通过`);
} finally {
  await context.close();
}
