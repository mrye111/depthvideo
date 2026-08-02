/**
 * 片6 端到端自测：i18n 中英切换。
 * 断言：默认按浏览器语言（zh-CN → 中文）；切 EN 后标题/按钮/状态全变英文且
 * 无缺失 key（data-i18n* 渲染结果不得等于 key 本身、不得为空）；切回 ZH 恢复；
 * 刷新后语言偏好（localStorage depthvideo-locale）保持。
 * 运行前先起 dev server（E2E_URL，默认 http://localhost:5173）。
 * 用法：node e2e/i18n.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.recon', 'e2e', 'profile-i18n');
const baseURL = process.env.E2E_URL || 'http://localhost:5173';

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  locale: 'zh-CN',
  args: ['--no-proxy-server'],
});

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

/** 页面侧扫描 data-i18n*：渲染值不得为空、不得等于 key（缺 key 时 t() 回退为 key 本身） */
function scanMissingKeys() {
  const bad = [];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.dataset.i18n;
    const v = el.textContent.trim();
    if (!v || v === k) bad.push(`text:${k}`);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const k = el.dataset.i18nHtml;
    const v = el.textContent.trim();
    if (!v || v === k) bad.push(`html:${k}`);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const k = el.dataset.i18nAria;
    const v = el.getAttribute('aria-label') || '';
    if (!v || v === k) bad.push(`aria:${k}`);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const k = el.dataset.i18nTitle;
    const v = el.getAttribute('title') || '';
    if (!v || v === k) bad.push(`title:${k}`);
  });
  // 隐藏元素（如 NC 警示 hidden）也一并扫：hidden 不影响 textContent
  return bad;
}

try {
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lang-btn[data-lang="zh"]', { timeout: 15_000 });

  // 1. 默认语言：zh-CN 环境 → 中文（无历史偏好时按 navigator.language 探测）
  await page.evaluate(() => localStorage.removeItem('depthvideo-locale'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lang-btn[data-lang="zh"]');
  console.log('— 默认语言（zh-CN 环境）');
  check(
    await page.evaluate(() => document.documentElement.lang === 'zh-CN'),
    'html lang=zh-CN',
  );
  check(
    await page.evaluate(() =>
      document.querySelector('.lang-btn[data-lang="zh"]').classList.contains('is-active'),
    ),
    '中文按钮 is-active',
  );
  check(
    await page.evaluate(
      () => document.querySelector('.lang-btn[data-lang="zh"]').getAttribute('aria-pressed'),
    ) === 'true' &&
      (await page.evaluate(
        () => document.querySelector('.lang-btn[data-lang="en"]').getAttribute('aria-pressed'),
      )) === 'false',
    'aria-pressed 状态正确',
  );
  check((await page.textContent('.chip.chip-ok'))?.trim() === '仅本地运行', 'chip 中文');
  check((await page.title()) === '视频深度图提取 · Depth Video', 'document.title 中文');

  // 2. 切到 EN
  await page.click('.lang-btn[data-lang="en"]');
  console.log('— 切到 EN');
  check((await page.title()) === 'Video Depth Extraction · Depth Video', 'document.title 英文');
  check(
    await page.evaluate(() => document.documentElement.lang === 'en'),
    'html lang=en',
  );
  check((await page.textContent('.chip.chip-ok'))?.trim() === 'Local only', 'chip 英文');
  check(
    (await page.textContent('[data-i18n="input.title.suffix"]'))?.trim() === 'Upload video',
    '输入卡标题英文',
  );
  check(
    (await page.textContent('[data-i18n="output.title.suffix"]'))?.trim() === 'Depth video',
    '输出卡标题英文',
  );
  check((await page.textContent('#inputBadge'))?.trim() === 'No video', 'inputBadge 英文');
  check((await page.textContent('#outputBadge'))?.trim() === 'Waiting', 'outputBadge 英文');
  check(
    (await page.textContent('#exportStatusLabel'))?.trim() === 'Ready to start',
    '导出卡 label 英文',
  );
  check(
    (await page.textContent('#exportStatusDetail'))?.trim() ===
      'Choose a video, click Start, then download here when done',
    '导出卡 detail 英文',
  );
  check(
    (await page.textContent('#progressTitle'))?.trim() === 'Waiting',
    'progressTitle 英文',
  );
  check(
    ((await page.textContent('#statusLine')) || '').startsWith('Choose a video.'),
    'statusLine 英文',
  );
  check(
    (await page.textContent('#startButton span'))?.trim() === 'Start' &&
      (await page.textContent('#cancelButton'))?.trim() === 'Cancel' &&
      (await page.textContent('#downloadButton span'))?.trim() === 'Download' &&
      (await page.textContent('#syncPlayButton span'))?.trim() === 'Sync play',
    '按钮组英文',
  );
  check(
    (await page.textContent('#gpuBadge'))?.includes('Accel:'),
    'gpuBadge 英文',
  );
  check(
    await page.evaluate(() =>
      document
        .querySelector('meta[name="description"]')
        .getAttribute('content')
        .startsWith('Extract depth maps from video in your browser.'),
    ),
    'meta description 英文',
  );
  check(
    await page.evaluate(
      () => document.querySelector('meta[property="og:locale"]').getAttribute('content') === 'en_US',
    ),
    'og:locale=en_US',
  );
  check(
    await page.evaluate(
      () => document.getElementById('dropZone').getAttribute('aria-label') === 'Choose video',
    ),
    'aria-label 英文',
  );
  check(
    await page.evaluate(
      () => document.querySelector('.meta-strip').getAttribute('title') === 'Source video info',
    ),
    'title 属性英文',
  );
  check(
    await page.evaluate(() =>
      document.querySelector('#modelSelect option').textContent.includes('(~48MB, Recommended)'),
    ),
    '模型选项英文（推荐后缀）',
  );
  check(
    await page.evaluate(() =>
      document.querySelector('[data-i18n-html="drop.hint"]').innerHTML.includes('Or click'),
    ),
    'data-i18n-html 英文',
  );
  const badEn = await page.evaluate(scanMissingKeys);
  check(badEn.length === 0, `EN 无缺失 key${badEn.length ? '：' + badEn.join(',') : ''}`);

  // 3. 刷新后偏好保持（EN）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lang-btn[data-lang="en"].is-active');
  console.log('— 刷新后偏好保持');
  check((await page.textContent('.chip.chip-ok'))?.trim() === 'Local only', '刷新后仍为英文');
  check(
    (await page.evaluate(() => localStorage.getItem('depthvideo-locale'))) === 'en',
    'localStorage=en',
  );

  // 4. 切回 ZH
  await page.click('.lang-btn[data-lang="zh"]');
  console.log('— 切回 ZH');
  check((await page.title()) === '视频深度图提取 · Depth Video', 'document.title 恢复中文');
  check((await page.textContent('.chip.chip-ok'))?.trim() === '仅本地运行', 'chip 恢复中文');
  check((await page.textContent('#inputBadge'))?.trim() === '没有视频', 'inputBadge 恢复中文');
  check(
    (await page.textContent('#exportStatusLabel'))?.trim() === '等待开始',
    '导出卡恢复中文',
  );
  check(
    ((await page.textContent('#statusLine')) || '').startsWith('请选择视频。'),
    'statusLine 恢复中文',
  );
  check(
    await page.evaluate(() =>
      document.querySelector('#modelSelect option').textContent.includes('（~48MB，推荐）'),
    ),
    '模型选项恢复中文',
  );
  const badZh = await page.evaluate(scanMissingKeys);
  check(badZh.length === 0, `ZH 无缺失 key${badZh.length ? '：' + badZh.join(',') : ''}`);

  // 5. 再刷新，ZH 保持
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lang-btn[data-lang="zh"].is-active');
  check((await page.textContent('.chip.chip-ok'))?.trim() === '仅本地运行', '刷新后仍为中文');

  if (failures > 0) throw new Error(`${failures} 项断言失败`);
  console.log('i18n e2e PASS');
} finally {
  await context.close();
}
