/**
 * 镜头分析页（/shots.html）e2e：上传样片 → TransNet 转场检测 → 时间轴/卡片/记忆/导出断言。
 * 样片：.recon/e2e/transitions.mp4（5 段：硬切@1s/2s/3s + 3.5-4.0s 叠化，25fps 126 帧，
 *       期望切点 ≈[24,49,74,91]，镜头=5）。缺失时按内置配方用 ffmpeg 现生成。
 * 用法：node e2e/shots.mjs   （E2E_DEVICE=wasm 强制 wasm 后端；E2E_URL 默认 http://localhost:5199）
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
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

const parseCards = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#shotCards .shot-card')).map((card) => {
      const m = /(\d+)–(\d+)帧/.exec(card.textContent);
      const active = card.classList.contains('is-active');
      return { start: Number(m[1]), end: Number(m[2]), active };
    }),
  );

ensureFixture();

/** 运镜服务桩：罐装 /health、/videos、/analyze（spec #26 契约同构） */
function startStubService() {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', modelLoaded: true }));
    } else if (req.url === '/videos') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ videoId: 'stub-video', durationSec: 5.04, fps: 25 }));
      });
    } else if (req.url === '/analyze') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            labels: {
              dolly: { label: 'dolly-in', prob: 0.87 },
              pan: { label: 'pan-left', prob: 0.66 },
              shaking: { label: 'minimal-shaking', prob: 0.91 },
              speed: { label: 'regular-speed', prob: 0.78 },
            },
            description: 'The camera pushes in steadily with minimal shaking.',
          }),
        );
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    srv.listen('8788', '127.0.0.1', () => {
      // close() 不销毁 keep-alive 连接：包装一层强制全断，保证页面能探到离线
      const origClose = srv.close.bind(srv);
      srv.close = (cb) => {
        for (const s of sockets) s.destroy();
        return origClose(cb);
      };
      resolve(srv);
    });
  });
}

const waitSvcBadge = (page, text, timeout = 20_000) =>
  page.waitForFunction(
    (t) => {
      const b = document.getElementById('svcBadge');
      return b && !b.hidden && (b.textContent || '').includes(t);
    },
    text,
    { timeout, polling: 500 },
  );

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
  await page.evaluate(() => localStorage.clear()); // 结果记忆置零，保证本次走真实检测
  console.log('— i18n 缺失扫描');
  check((await page.textContent('h1'))?.trim() === '镜头分析', '中文标题');
  check((await scanMissingKeys(page)).length === 0, 'ZH 无缺失 key');
  await page.click('.lang-btn[data-lang="en"]');
  await page.waitForSelector('.lang-btn[data-lang="en"].is-active');
  check((await page.textContent('h1'))?.trim() === 'Shot Analysis', '英文标题');
  check((await scanMissingKeys(page)).length === 0, 'EN 无缺失 key');
  await page.click('.lang-btn[data-lang="zh"]');
  await page.waitForSelector('.lang-btn[data-lang="zh"].is-active');

  // ---- 运镜服务离线降级（桩未启动时） ----
  console.log('— 运镜服务离线降级');
  await waitSvcBadge(page, '运镜服务离线');
  check(true, '离线徽标显示');

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

  // ---- 镜头卡片（帧区间，边界容差 ±2） ----
  const cards = await parseCards(page);
  console.log('  cards:', JSON.stringify(cards));
  check(cards.length === 5, '镜头卡片数 = 5');
  const cuts = cards.slice(0, -1).map((r) => r.end);
  const expected = [24, 49, 74, 91];
  check(
    cuts.every((c, i) => Math.abs(c - expected[i]) <= 2),
    `切点位置 ≈[24,49,74,91]（实际 ${JSON.stringify(cuts)}）`,
  );
  check(cards[0].start === 0 && cards[4].end >= 124, '首段从 0 起、末段到片尾');

  // ---- 缩略图（异步填充） ----
  await page.waitForSelector('.shot-thumb[src^="data:image"]', { timeout: 60_000 });
  check(true, '卡片缩略图已填充');

  // ---- 时间轴：点击分段选中并定位 ----
  console.log('— 时间轴与选中联动');
  const tlBox = await page.locator('#timelineCanvas').boundingBox();
  if (!tlBox) throw new Error('时间轴不可见');
  // locator.click 自动滚动到可视区（裸 mouse.click 在视口外会落空）
  await page.locator('#timelineCanvas').click({
    position: { x: tlBox.width * 0.492, y: tlBox.height / 2 },
  });
  await page.waitForFunction(
    () => Math.abs(document.getElementById('preview').currentTime - 2.0) < 0.3,
    null,
    { timeout: 10_000, polling: 200 },
  );
  check(true, '点击时间轴第 3 段 → 预览定位 ≈2.0s');
  let cards2 = await parseCards(page);
  check(cards2[2].active && cards2.filter((c) => c.active).length === 1, '第 3 张卡片选中高亮');

  // 点卡片定位
  await page.locator('#shotCards .shot-card').nth(0).click();
  await page.waitForFunction(
    () => document.getElementById('preview').currentTime < 0.3,
    null,
    { timeout: 10_000, polling: 200 },
  );
  check(true, '点击卡片 1 → 预览定位 ≈0s');
  cards2 = await parseCards(page);
  check(cards2[0].active, '卡片 1 选中高亮');

  // ---- JSON 导出 ----
  console.log('— JSON 导出');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('#exportButton'),
  ]);
  check(/transitions-shots\.json$/.test(download.suggestedFilename()), '导出文件名 transitions-shots.json');
  const exportData = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  check(exportData.video?.name === 'transitions.mp4', '导出 video.name');
  check(exportData.video?.fps === 25 && exportData.video?.width === 640, '导出 video 元信息');
  check(Array.isArray(exportData.boundaries) && exportData.boundaries.length === 4, '导出 boundaries = 4');
  check(
    Array.isArray(exportData.shots) && exportData.shots.length === 5 && exportData.shots[0].startSec === 0,
    '导出 shots = 5 且首段 0 起',
  );
  check(
    typeof exportData.boundaries[0].prob === 'number' && exportData.boundaries[0].prob > 0.5,
    '导出边界含置信度',
  );
  check(String(exportData.meta?.transnetModel || '').includes('TransNet'), '导出 meta.transnetModel');
  check(!('motion' in exportData.shots[0]), '未接入运镜时无 motion 字段');

  // ---- 结果记忆：重载后同文件免重检 ----
  console.log('— 结果记忆');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(
    () => (document.getElementById('statusLine').textContent || '').includes('已从本地恢复'),
    null,
    { timeout: 30_000, polling: 300 },
  );
  check(true, '恢复提示出现（免重检）');
  const cards3 = await parseCards(page);
  check(cards3.length === 5, '恢复后卡片数 = 5');
  check(await page.evaluate(() => !document.getElementById('exportButton').disabled), '恢复后导出可用');
  check(await page.evaluate(() => !document.getElementById('startButton').disabled), '恢复后可重新检测');
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('shots.result.v1.')),
  );
  check(stored.length === 1, 'localStorage 记忆键存在');

  // 离线时运镜按钮禁用
  check(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('.motion-btn')).every((b) => b.disabled),
    ),
    '离线时运镜按钮全部禁用',
  );

  // ---- 桩服务在线：运镜分析全流程 ----
  console.log('— 桩服务在线：运镜分析');
  const stub = await startStubService();
  try {
    await waitSvcBadge(page, '运镜分析可用');
    check(true, '在线徽标显示（重探恢复，无需刷新页面）');
    check(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('.motion-btn')).every((b) => !b.disabled),
      ),
      '在线后运镜按钮启用',
    );
    await page.locator('.motion-row[data-index="1"] .motion-btn').click();
    await page.waitForSelector('.motion-row[data-index="1"] .motion-chips .motion-chip', {
      timeout: 30_000,
    });
    const chipTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.motion-row[data-index="1"] .motion-chip')).map(
        (c) => c.textContent.trim(),
      ),
    );
    console.log('  chips:', JSON.stringify(chipTexts));
    check(chipTexts.length >= 3, `维度标签渲染 >=3（实际 ${chipTexts.length}）`);
    check(chipTexts.some((s) => s.includes('前推')), 'dolly 标签翻译（前推）');
    check(chipTexts.some((s) => s.includes('0.87')), '置信度渲染');
    const desc = (
      await page.textContent('.motion-row[data-index="1"] .motion-desc')
    )?.trim();
    check(!!desc && desc.includes('pushes in'), '一句话描述渲染');

    // 导出 JSON：已分析镜头含 motion，未分析不含
    const [download2] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.click('#exportButton'),
    ]);
    const export2 = JSON.parse(fs.readFileSync(await download2.path(), 'utf8'));
    check(
      export2.shots[0].motion && export2.shots[0].motion.labels.dolly.label === 'dolly-in',
      '导出 shot1 含 motion.labels',
    );
    check(
      export2.shots[0].motion.description.includes('pushes in'),
      '导出 shot1 含 motion.description',
    );
    check(!('motion' in export2.shots[1]), '未分析镜头无 motion 字段');
  } finally {
    stub.close();
  }
  await waitSvcBadge(page, '运镜服务离线');
  check(true, '桩关闭后徽标回到离线（降级恢复）');

  // ---- 取消路径（wasm 慢速下点取消；webgpu 过快则跳过） ----
  if (device === 'wasm') {
    console.log('— 取消路径');
    await page.evaluate(() => localStorage.clear()); // 强制走真实检测
    await page.setInputFiles('#fileInput', fixture);
    await page.waitForFunction(
      () => (document.getElementById('metaFps').textContent || '').trim() !== '…',
      null,
      { timeout: 30_000, polling: 300 },
    );
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

  console.log(`\nPASS: 镜头分析页（i18n/上传/检测/卡片/时间轴/导出/记忆${device === 'wasm' ? '/取消重跑' : ''}）全部通过`);
} finally {
  await context.close();
}
