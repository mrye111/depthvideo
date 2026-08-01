# 票 #5：UI/UX 与功能清单盘点 —— depthvideo.com 1:1 复刻

> 调研日期：2026-08-02。primary source 为原站线上资源快照（已归档到 `research-snapshot/`）：
> `index.html`（3,429 B）、`assets/index-B7FSXh3l.js`（756,257 B）、`assets/index-CR6I5TtH.css`（31,166 B，已存为 `index-CR6I5TtH.css`）、
> `assets/logo.png`（120×122 PNG，18,195 B）、`assets/mediapipe/selfie_segmenter.tflite`（249,537 B）、`assets/mediapipe/selfie_segmenter_landscape.tflite`（250,177 B）、`robots.txt`。
> JS bundle 内完整页面模板已抽出至 `research-snapshot/template_full.txt`（含全部 DOM id / class / data-i18n key），全部中文文案抽出至 `research-snapshot/cn_strings.txt`。
>
> 注意：`https://www.depthvideo.com/favicon.ico` 返回 **404**（站点用 `/logo.png` 同时充当 favicon 与 apple-touch-icon）。`sitemap.xml`、`manifest.json` 均 404。`research-snapshot/assets/favicon.ico` 里存的是 404 响应体，仅作记录，复刻时不要照抄——应直接用 logo.png 做 icon。

## 1. 站点概况

- 单页 SPA，Vite 构建产物（`/assets/index-<hash>.js` + `/assets/index-<hash>.css`），`<html lang="zh-CN">`，宿主为 Vercel（404 响应体为 Vercel `NOT_FOUND` / `fra1` 节点，robots.txt 带 Cloudflare Managed content signals，应为 Cloudflare → Vercel）。
- **中英双语**：header 内置「中文 / EN」切换按钮（`.lang-switch`，`data-lang="zh"|"en"`），JS 内含完整 `zh` / `en` 两套 i18n 字典（`data-i18n` / `data-i18n-html` / `data-i18n-aria` / `data-i18n-title` 属性驱动），切换语言时还会同步改写 `document.title` 与 og:/twitter: meta。复刻按 i18n 字典结构实现即可。
- **只有亮色主题**：CSS 中无 `.dark`、无 `prefers-color-scheme`，`body{color-scheme:light}`。`<meta name="theme-color" content="#5c4fd6">`。
- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />`，移动端适配靠 `sm:` 前缀响应式类。
- SEO：title「视频深度图提取 · Depth Video」，description/keywords/OG/Twitter card/JSON-LD（`@type: WebApplication`，featureList 含「WebGPU / WASM 加速」「模型浏览器缓存，可离线复用」等），另有 `<noscript>` 兜底文案。原文见 `research-snapshot/index.html`。

## 2. 页面结构与区块（DOM 骨架）

整体：`.app-root` → 背景层（`.bg-stage` 彩色径向渐变、`.bg-grid` 网格、`.orb orb-a/b/c` 三个漂浮光斑）→ `main.app-shell.fade-in` → header + `.app-body`（工作区 + footer）。

### 2.1 Header（`.app-header`）

- 品牌：`.brand-lockup` = `<img src="/logo.png" width=36 height=36>` + 标题 `Depth <span class="text-accent">Video</span>`（`.brand-mark`，font-display，extrabold）。
- 三个 chip 徽标：`仅本地运行`（chip-ok，绿点）/ `无需 API` / `视频深度图提取`。
- 右侧导航 `.header-links`（aria-label「外部链接」）：
  - 语言切换组「中文 / EN」；
  - 外链 **「海趣社」→ `https://dz.haiqushe.com/`**（target=_blank）；
  - 外链 **Twitter/X 图标 + 「Twitter」→ `https://x.com/haiqushe`**。
  - 注意：两条外链在 **header**，不是经典页脚；footer 里没有外链。

### 2.2 输入卡片（`输入 —— 上传视频`，`.panel-card` + `.glass.glass-strong`）

- 头部：标题 + `#inputBadge` chip（默认「没有视频」）。
- 拖放区 `#dropZone`（`.media-panel.drop-zone.is-pickable`，虚线边框 + 四角 `.corner` 装饰）：
  - 空态 `#inputEmpty`：上传图标（紫色播放窗 SVG，`.upload-ring` 呼吸环）+「将视频拖拽到这里」+「或点击此处选择视频<br>支持格式：mp4 / webm / mov（仅 1 个）」；
  - 载入后显示 `<video id="sourceVideo" muted playsinline controls>`。
- 裁剪条 `#trimWrap`（默认 hidden）：48px 高胶片条 canvas `#trimStrip` + 左右遮罩 `#shadeL/#shadeR` + 选区 `#trimRegion` + 两个可拖手柄 `#trimL/#trimR`（role=slider，aria「开始时间/结束时间」）；下方 `#rangeInfo`（「已选：—」/「已选：{start}s – {end}s（{duration}秒 ≈ {frames}帧）」）+ `#rangeResetBtn`「重置」。
- 底部 `.panel-footer`：`#pickVideoLabel`「选择视频」主按钮（内嵌 sr-only `<input type=file accept="video/mp4,video/webm,video/quicktime,video/*">`）+ 源信息条（`文件` `#sourceFileName`、`源` `#sourceMeta`，格式 `{宽}×{高} · {时长}s`）。

### 2.3 输出卡片（`输出 —— 深度视频`）

- 头部：标题 + `#outputBadge` chip（默认「等待中」）。
- 预览区 `#outputPanel`：空态「实时转换预览 / 点击【开始】后，这里会逐帧显示深度图转换过程。」；处理中显示 `<canvas id="depthCanvas">` + 左上角实时标签 `#liveFrameTag`（红点 + `FRAME n`）；完成后显示 `<video id="resultVideo" muted playsinline controls>`。
- 导出卡 `#exportSlot`（`.export-card`，状态类 `export-idle|export-busy|export-ok|export-warn`）：状态点 + `#exportStatusLabel`（默认「等待开始」）+ `#exportStatusDetail`（默认「选择视频后点击开始，完成后可在此下载」）+ `#downloadButton`「下载」（默认 hidden+disabled）。
- 底部信息条：`输出` `#outputMeta`、`帧` `#frameMeta`、`速度` `#speedMeta`（格式 `{done}/{total} 帧 · {fps} fps`、`{frames} 帧 · {fps}fps · {format}`）。

### 2.4 设置侧栏（`.settings-panel`，右侧，`.settings-scroll` 滚动区）

自上而下：

1. `#syncPlayButton`「同步播放」主按钮（disabled 直到产出结果；处理中可「停止同步」）。
2. **模型** 分组：
   - `模型下载源` `#hubSelect`：`modelscope.cn（国内推荐）`（默认，`https://modelscope.cn/`，路径模板 `models/{model}/resolve/master/`）/ `huggingface.co（官方，需梯子）`（`{model}/resolve/{revision}/`）；hint「国内默认走魔搭 ModelScope，可在页面内直接下载模型。」
   - `深度模型` `#modelSelect` + `#modelCacheHint`（缓存状态，如 `✓ 已缓存`）。选项由模型表生成（见 §4），形如 `V2 Small · ONNX · f16（~48MB，推荐）`。
   - `运行后端` `#deviceSelect`：`WebGPU（快速）` / `WASM（较慢）`。
3. **处理设置** 分组：
   - `分辨率（最长边）` `#sizeSelect`：`384px · 快速` / `512px · 一般` / `640px · 普通` / **`960px · 推荐`（默认）** / `1024px · 高清` / `1280px · 720p` / `1920px · 1080p` / `原始尺寸`。
   - `处理帧率（FPS）` `#fpsSelect`：8 / 12 / 15 / 24 / **30 · 推荐（默认）** / 60。
   - `范围` `#personModeSelect`：**`全图`（默认）** / `仅人物`。
   - `分割模型` `#segModelSelect`（仅「仅人物」时启用，默认 disabled）：`MediaPipe Selfie`（默认）/ `MediaPipe Landscape` / `Transformers ONNX Selfie`。
   - `背景` `#personBgSelect`（同样仅人物时启用）：`保留原图`（默认）/ `涂黑`。
4. **深度图样式** 分组：
   - `样式` `#styleSelect`：**`灰度`（默认）** / `热力`（turbo colormap）。
   - `深度方向` `#directionSelect`：**`近处 = 白色`（默认）** / `远处 = 白色`。
   - `时间平滑` `#smoothRange`：range 滑块 min=0 max=0.85 step=0.05 **默认 0.35**，旁显 `#smoothValue`（mono 字体）。
5. 操作区 `.settings-actions`（grid 1.4fr:1fr）：`#startButton`「开始」（绿色渐变 btn-start，disabled 直到选视频）、`#cancelButton`「取消」（btn-danger，处理中才可用）。

### 2.5 Footer（`.app-footer`，玻璃条）

- 左 `#progressTitle`（「等待中」等状态词）+ 右 `#progressText`（百分比，`0%`）。
- 进度条 `#progressTrack > #progressBar`（带 `.is-active` 扫光动画）。
- `#statusLine` 状态行（默认「请选择视频。首次运行会下载 AI 模型，之后会缓存到浏览器中。」）。
- 最底行：左 `#gpuBadge`（`硬件加速：检测中...` / `硬件加速：支持 WebGPU ✓` / `硬件加速：WASM 模式`，mono 绿色）+ 右「视频深度图提取 —— 所有处理都在当前浏览器内完成」。

## 3. 交互流程（状态机）

1. **上传**：拖入或点击选视频（单文件，mp4/webm/mov）→ 读元数据（超时文案「读取视频元数据超时」）→ inputBadge 变「已载入」，sourceVideo 可播，生成胶片条（失败/超时分别有「胶片条加载失败/超时」），状态行「视频已准备好，可裁剪区间后点击开始生成。」→ 可拖手柄裁剪、「重置」恢复全程、「重选视频」。
2. **参数选择**：范围切到「仅人物」时启用分割模型 + 背景下拉，并触发分割模型预加载（「正在准备人物分割模型...」「仅人物：正在加载 MediaPipe {label}（官方）...」/「仅人物：正在加载 Transformers ONNX 人像分割...」）。
3. **开始处理**：
   - 首次运行下载深度模型：状态行依次「首次使用，正在从 {host} 下载 {name}（{size}）...」→「正在下载模型（{pct}% · 已用 {sec}s）...」→「模型已下载完成，正在初始化 {device}/{dtype}...」；二次运行走缓存（「模型已缓存。正在快速读入并初始化 {device}（{size}）...」）。模型缓存于 Cache Storage `transformers-cache-v2`（旧键 `transformers-cache` 会被清理）。
   - 「仅人物」时再加载分割模型（同样带下载进度文案）。
   - 逐帧推理：「开始逐帧生成深度图（{start}s–{end}s · 共 {frames} 帧）...」，outputBadge「转换中」，depthCanvas 实时刷新 + `FRAME n` 标签，速度信息 `{done}/{total} 帧 · {fps} fps`。
   - 封装：优先 **WebCodecs H.264 → MP4**（bundled `mp4-muxer`，codec 候选 `avc1.42001f/420028/4d001f/4d0028/4d0029/640028/640029/640032`，默认文件名 `depth-video.mp4`）；不支持时回退 **MediaRecorder → WebM**（vp8/vp9），提示「当前浏览器不支持 WebCodecs，已切换为 WebM。…」/「当前分辨率下浏览器无法用 H.264 生成 MP4，已尝试回退为 WebM。」封装期状态「封装中 / 正在封装 MP4 文件...」。
4. **完成**：exportCard 变 `export-ok`，「转换成功」/「完成：已生成 {frames} 帧、{fps}fps 的 {format} 深度视频。可点击下方下载或同步播放对比。」，`下载` 按钮可用，`同步播放` 可用（源/结果双视频同步对照播放）。
5. **取消**：处理中点「取消」→「正在取消，当前帧结束后停止...」→「已取消。可以调整参数后重新开始。」
6. **失败**：exportCard `export-warn`，「处理失败：{message}{hint}」，hint 例如「（无法下载模型。请硬刷新后确认下载源为 modelscope.cn；若仍失败可改官方源并开代理，或在 Application → Cache Storage 删除 transformers-cache* 后重试。）」。各类超时（`{model} ({device}/{dtype}) 初始化超时。可切换到 WASM，或取消后重试。`、MediaPipe WASM/CPU/GPU 超时）与降级（「MediaPipe GPU 不可用，改用 CPU...」「加载失败，尝试下一候选...」）均有独立文案。

状态词全集（progressTitle/badge）：等待中 / 准备中 / 下载模型 / 下载分割 / 初始化 / 加载分割 / 生成中 / 转换中 / 封装中 / 取消中 / 降级中 / 重试中 / 完成 / 已完成 / 已取消 / 出错 / 转换失败 / 等待开始。全量文案见 `research-snapshot/cn_strings.txt`（455 行，含 en 对照）。

## 4. 模型与后端配置（bundle 内常量）

- 深度模型表（`KH`，生成 4 个选项 = 2 模型 × fp16/fp32，key 形如 `{id}::fp16`）：
  | id | 显示名 | 备注 | fp16 | fp32 |
  |---|---|---|---|---|
  | `onnx-community/depth-anything-v2-small-ONNX` | `V2 Small · ONNX` | recommended（推荐标记挂在 fp16 档） | ~48MB | ~94MB |
  | `onnx-community/depth-anything-v2-base-ONNX` | `V2 Base · ONNX` | — | ~187MB | ~371MB |
  （另有 `…-v2-small` / `…-v2-base`（非 -ONNX 后缀）常量作候选/回退。）
- 分割：`onnx-community/mediapipe_selfie_segmentation`（Transformers ONNX 人像分割）；MediaPipe 走 `@mediapipe/tasks-vision@0.10.35`，WASM 源双候选：国内 `https://cdn.npmmirror.com/packages/@mediapipe/tasks-vision/0.10.35/files/wasm`，官方 `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`；tflite 权重为**站点自有静态文件** `/mediapipe/selfie_segmenter.tflite`、`/mediapipe/selfie_segmenter_landscape.tflite`（已归档）。
- 运行时：transformers.js env `version=4.2.0`，onnxruntime-web `versions.common=1.24.3`（WASM 文件从 jsdelivr `onnxruntime-web@…/dist/` 拉取）；WASM 线程数 `crossOriginIsolated ? min(4, hardwareConcurrency) : 1`。
- 自定义 fetch 拦截：拒收 content-type 为 text/html 的响应与「内容是 HTML 的 .json/config 文件」（防 ModelScope/HF 返回 HTML 错误页写坏缓存），并对 Cache Storage 做同款清理。

## 5. 视觉系统（CSS 分析）

**结论：Tailwind CSS v4（编译产物）+ 手写组件层**。依据：CSS 含 `@layer properties/theme/base`、`--tw-*` 变量、`@theme` 派生的 `--color-*/--font-*/--text-*` 令牌、`space-y-3>:not(:last-child)`、`sm\:` 断点、`!` 重要修饰（`.sm\:\!min-h-10`）等 Tailwind v4 特征；同时存在大量手写组件类（`.app-shell/.glass/.panel-card/.drop-zone/.trimbar/.export-card/.orb/.btn-start` 等）。复刻建议：Tailwind v4 + `@theme` 定义下述令牌 + 一层手写组件 CSS。

### 5.1 颜色令牌（`@theme`，亮色单主题）

| token | 值 | 用途 |
|---|---|---|
| `--color-void` | `#f4f0fb` | 页面底色（body background） |
| `--color-ink` | `#1a1d2e` | 主文字 |
| `--color-ink-soft` | `#4a4f63` | 次级文字 |
| `--color-muted` | `#8b8fa3` | 弱化文字 |
| `--color-fog` | `#5c6178` | chip 文字 |
| `--color-cyan` | `#7c6cf0` | **主 accent（命名 cyan 实为紫）**，`.text-accent`、按钮渐变起点、边框点缀 |
| `--color-signal` | `#8b7cf6` | SVG 图标描边、渐变 |
| `--color-ok` | `#3db88a` | 成功/缓存/WebGPU 标识 |
| `--color-warn` | `#e8a838` | 警告 |
| `--color-panel` | `#ffffff94` | 玻璃面板底 |
| `--color-panel-strong` | `#ffffffb8` | 强玻璃面板底 |
| theme-color | `#5c4fd6` | 浏览器 UI 主题色 |

关键渐变：
- 主按钮 `.btn-primary`：`linear-gradient(135deg,#8b7cf6 0%,#a78bfa 45%,#c084fc 100%)` + 紫光阴影；
- 开始按钮 `.btn-start`：`linear-gradient(135deg,#4ec9a8 0%,#5ec8b8 45%,#6bb8e8 100%)`（绿→青→蓝）；
- 页面背景 `.bg-stage`：5 层径向彩斑（紫 `#baaaff8c`、薄荷 `#a8e6d280`、杏 `#ffdcaa73`、天蓝 `#a0dcf56b`、粉 `#ffc8dc47`）+ 基底 `linear-gradient(160deg,#efeaf8 0%,#e8f4f2 40%,#f7f0e8 100%)`；
- `.bg-grid`：`#7c6cf00a` 48px 网格 + 径向 mask；`.orb-a/b/c`：blur(90px) 圆斑 20s 漂浮动画；
- `.glass`：`background:#ffffff94` + `backdrop-filter:blur(24px) saturate(1.4)` + 1px 半透白边 + `border-radius:1.5rem` + 内高光/外柔影（典型 glassmorphism）。

### 5.2 字体

Google Fonts `@import`（CSS 首行）：**Outfit**（400–800，display/标题，`--font-display`）、**Plus Jakarta Sans**（300–700，正文，`--font-body`）、**JetBrains Mono**（400–600，数字/百分比/徽章，`--font-mono`）。body 默认 font-body；标题 font-display + extrabold + tracking-tight。

### 5.3 布局

- `.app-shell`：居中容器，header 在上，`.app-body` 内含 `.app-workspace`（输入/输出卡片并排 + 右侧设置栏，移动端堆叠）与 footer；`body{overflow:hidden}`，设置栏内部 `.settings-scroll` 自滚动。
- 卡片：`border-radius` 1.5rem（glass）/ 1.15rem（media-panel），间距用 Tailwind `p-2.5 sm:p-3.5`、`gap-2.5 sm:gap-3` 档。
- 动效：`fade-in / fade-in-delay / fade-in-delay-2` 入场；`.upload-ring:after` 呼吸环；`.progress-track.is-active:after` 扫光；`.scanline`（预览扫描线）；`.live-tag` 红点闪烁；按钮 hover/disabled/active 态齐全；trimbar 手柄 `role=slider` 可键盘操作。

## 6. 静态资产与外链清单

| 资源 | 说明 | 归档 |
|---|---|---|
| `/logo.png` | 120×122 PNG，同时作 favicon/apple-touch-icon/品牌图 | `research-snapshot/assets/logo.png` |
| `/favicon.ico` | **404，不存在**（复刻直接用 logo.png） | （404 响应体存档于 assets/favicon.ico） |
| `/mediapipe/selfie_segmenter.tflite` | MediaPipe Selfie 分割权重 249,537 B | `research-snapshot/assets/mediapipe/` |
| `/mediapipe/selfie_segmenter_landscape.tflite` | Landscape 版 250,177 B | 同上 |
| `/robots.txt` | Cloudflare 托管 robots（含 content signals） | `research-snapshot/robots.txt` |
| 外链 | `https://dz.haiqushe.com/`（文案「海趣社」）、`https://x.com/haiqushe`（Twitter 图标 + 「Twitter」） | header 导航内 |

## 7. 复刻要点速记

1. 单页三卡片 + 右设置栏 + 底进度条，全部文案走 zh/en 双 i18n 字典（key 结构照抄 `template_full.txt` 中的 `data-i18n`）。
2. 样式 = Tailwind v4 + `@theme` 令牌（§5.1）+ 手写 glass/orb/trimbar/export-card 组件层；仅亮色。
3. 默认参数：960px / 30fps / 全图 / 灰度 / 近白 / 平滑 0.35 / V2 Small fp16 / WebGPU / modelscope 源。
4. 导出优先 WebCodecs+mp4-muxer（H.264，`depth-video.mp4`），降级 MediaRecorder WebM（vp8/vp9）。
5. 模型缓存键 `transformers-cache-v2`；需实现「HTML 假响应」拦截与缓存清理逻辑，文案里有对应排障 hint。
6. 别忘了 SEO 全套（JSON-LD、OG、noscript）与 header 两条外链。
