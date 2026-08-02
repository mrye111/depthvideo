# 总验收报告 —— depthvideo.com 1:1 复刻（片6）

> 验收日期：2026-08-02。验收对象：本仓库 main 分支（片1–6 完成态）。
> 依据：`research/ui-ux-inventory.md`（功能/视觉清单）、`research/inference-pipeline.md`、
> `research/video-export-pipeline.md`、原站线上快照 `research-snapshot/`。
> 测试视频：`.recon/e2e/sample.mp4`（640×360，4.0s），e2e 统一系统 Chrome headless（`channel:'chrome'`）。

## 0. 结论

**通过。** 功能清单逐项核对全部落地；i18n zh/en 双字典 195 key 逐字取自原站 bundle，
切换/持久化/doc meta 行为与原站一致；模型缓存键 `transformers-cache-v2` + 旧键清理 +
HTML 假响应防护与原站 tU/nU 对齐；桌面/移动两端与原站并排截图目检无可见差异（两处
intentional 偏差除外）；构建产物含全部 npm 运行时依赖 license 文本；5 个 e2e 全绿。

## 1. 功能清单逐项核对（对照 ui-ux-inventory.md）

### 1.1 站点概况（§1）

| 项 | 原站 | 复刻 | 结果 |
|---|---|---|---|
| 单页 SPA，Vite 构建 | ✓ | ✓（rolldown-vite 7） | ✅ |
| `<html lang>` 随语言切换 | zh-CN / en | 同（setLang 改写） | ✅ |
| 中英双语切换 | data-i18n* 属性驱动 + doc meta 同步 | 同（195 key 逐字照搬） | ✅ |
| 仅亮色主题 | `color-scheme:light` | 同 | ✅ |
| theme-color `#5c4fd6` | ✓ | ✓ | ✅ |
| viewport-fit=cover | ✓ | ✓ | ✅ |
| SEO（title/description/keywords/OG/Twitter/JSON-LD/noscript） | ✓ | ✓（index.html 与快照逐字一致） | ✅ |
| favicon=logo.png（原站 favicon.ico 404） | ✓ | ✓ | ✅ |

### 1.2 Header（§2.1）

| 项 | 结果 |
|---|---|
| 品牌 lockup（logo 36px + Depth **Video** accent） | ✅ |
| 三 chip（仅本地运行 chip-ok / 无需 API / 视频深度图提取） | ✅ |
| 语言切换「中文 / EN」（is-active + aria-pressed，片1 遗留本片补齐） | ✅ |
| 外链「海趣社」「Twitter」 | ➖ **intentional 偏差**：移除原作者外链 |

### 1.3 输入卡片（§2.2）

| 项 | 结果 |
|---|---|
| 标题 + #inputBadge（没有视频/已载入 chip-ok） | ✅ |
| 拖放区（虚线框 + 四角 corner + 上传图标呼吸环 + 空态文案） | ✅ |
| 点击/拖入/键盘(Enter/Space) 选视频，accept 限定 | ✅ |
| 元数据读取（10s 超时「读取视频元数据超时」） | ✅ |
| 胶片条 #trimStrip（12 缩略图 cover 裁切，失败/超时文案） | ✅ |
| 裁剪手柄（role=slider、拖拽、键盘 ←/→ ±0.1s、Shift ±1s、最短 0.1s、重置） | ✅ |
| #rangeInfo「已选：{start}s – {end}s（{duration}秒 ≈ {frames}帧）」 | ✅ |
| 底部「选择视频」主按钮 + 文件/源信息条（载入后变「重选视频」） | ✅ |

### 1.4 输出卡片（§2.3）

| 项 | 结果 |
|---|---|
| #outputBadge（等待中/转换中/已完成/已取消/出错） | ✅ |
| 空态「实时转换预览」+ 提示文案 | ✅ |
| depthCanvas 实时预览 + #liveFrameTag（红点 + FRAME n） | ✅ |
| 完成后 resultVideo 回放 | ✅ |
| 导出卡 4 态（export-idle/busy/ok/warn）+ 下载按钮 | ✅ |
| 底部 输出/帧/速度 信息条 | ✅ |

### 1.5 设置侧栏（§2.4）

| 项 | 结果 |
|---|---|
| 同步播放（完成后可用，双视频时间轴对照，结果轴=源轴−入点） | ✅ |
| 模型下载源 hubSelect | ➖ **intentional 偏差**：固定 ModelScope 源，不下拉 |
| 深度模型 4 档（small/base × fp16/fp32，文案含 ~MB 与推荐标记，命中缓存追加 ✓ 已缓存） | ✅ |
| #modelCacheHint（`{device} · 已缓存 {cached}/{total} · 本地 {bytes}` / `尚未缓存`） | ✅ |
| 运行后端（WebGPU 快速 / WASM 较慢，无自动降级） | ✅ |
| 分辨率 8 档（默认 960px 推荐，original=原始尺寸） | ✅ |
| 帧率 6 档（默认 30 推荐） | ✅ |
| 范围（全图默认 / 仅人物 → 启用分割模型与背景下拉并预加载） | ✅ |
| 分割模型 3 档（MediaPipe Selfie/Landscape/Transformers ONNX） | ✅ |
| 背景（保留原图 / 涂黑，处理中改动下一帧生效） | ✅ |
| 样式（灰度 / 热力——Jet 三角近似，照原站数学） | ✅ |
| 深度方向（近白默认 / 远白=255−v） | ✅ |
| 时间平滑（0–0.85 默认 0.35，IIR out=prev·k+cur·(1−k)，换参重置） | ✅ |
| 开始（绿渐变，未选视频 disabled）/ 取消（处理中可用） | ✅ |
| base 档 CC-BY-NC 非商用警示（#7 硬性要求，原站无此元素） | ✅（项目增补） |

### 1.6 Footer（§2.5）

| 项 | 结果 |
|---|---|
| #progressTitle + #progressText 百分比 | ✅ |
| 进度条 + is-active 扫光动画 | ✅ |
| #statusLine 全状态文案（含下载进度/超时/降级/失败 hint） | ✅ |
| #gpuBadge（检测中/WebGPU ✓/WASM 模式）+ 本地处理声明 | ✅ |

### 1.7 交互流程（§3）

| 流程 | 验证 | 结果 |
|---|---|---|
| 上传 → 元数据 → 胶片条 → 可裁剪 | e2e smoke/settings | ✅ |
| 首次下载模型（进度文案/pct）→ 二次走缓存 | e2e smoke（Cache Storage 仅 `transformers-cache-v2`，onnx×2+config） | ✅ |
| 逐帧推理（主线程 + rAF 让出，seek+seeked 5s 超时） | e2e smoke（首帧 2.8s，深度图 min0/max255） | ✅ |
| WebCodecs H.264→MP4 主路径（10 候选探测、bitrate clamp、关键帧 2s、背压 flush） | e2e export（ffprobe h264） | ✅ |
| MediaRecorder WebM 降级（vp9→vp8→webm） | e2e export（ffprobe vp9） | ✅ |
| 完成（export-ok + 下载 + 同步播放） | e2e export/settings | ✅ |
| 取消（当前帧后停止 + 复位 + 可重跑） | e2e smoke/export | ✅ |
| 失败 hint（缓存排障文案） | 代码核对（status.failed+fetchHint） | ✅ |
| 仅人物分割（GPU 120s→CPU 180s 降级，失败回退全白掩码不中断） | e2e person | ✅ |

### 1.8 模型与后端（§4）

| 项 | 结果 |
|---|---|
| transformers.js 4.2.0 / depth-estimation / 默认 small fp16 / webgpu | ✅ |
| ORT 1.26.0-dev.20260416-b7804b056c，wasm 线程 `crossOriginIsolated?min(4,hc):1` | ✅ |
| 缓存键 `transformers-cache-v2`，启动删除旧键 `transformers-cache` | ✅ |
| HTML 假响应防护（fetch 钩子 text/html→404、json/config 首 64B `<`→404，clone 不耗流） | ✅（本片对齐原站 tU） |
| 启动缓存清理（text/html 与 HTML 污染 json 条目删除） | ✅（本片对齐原站 nU） |
| 缓存探测（权重字节阈值 fp16>20MB/fp32>40MB + config.json） | ✅ |
| -ONNX ↔ 无后缀变体回退，small 180s / base 360s 超时 | ✅ |
| MediaPipe wasm npmmirror（本站 hub 固定国内源）+ tflite 自托管 | ✅ |

### 1.9 视觉系统（§5）

| 项 | 结果 |
|---|---|
| Tailwind v4 + @theme 令牌（void/ink/cyan(#7c6cf0)/ok/panel…） | ✅ |
| 字体 Outfit/Plus Jakarta Sans/JetBrains Mono | ✅（fontsource 自托管，替代 Google Fonts 外链，国内可达） |
| 玻璃拟态（blur24 saturate1.4、1.5rem 圆角、内外阴影） | ✅ |
| 背景（5 层径向彩斑 + 48px 网格 + 三 orb 漂浮） | ✅ |
| 动效（fade-in、呼吸环、进度扫光、live 红点） | ✅ |
| 并排截图目检（桌面 1440×900 / 移动 390×844） | ✅ 无可见差异（见 §3 索引） |

### 1.10 i18n（片6 新增）

| 项 | 结果 |
|---|---|
| zh/en 双字典各 195 key，逐字取自原站 bundle，key 集完全一致 | ✅（脚本比对 0 缺失） |
| 项目增补 3 key（status.badFileType / status.segFallback / nc.warning），双语自译 | ✅ |
| data-i18n / -html / -aria / -title 四类属性全量切换 | ✅（e2e 扫描 0 缺失 0 回退） |
| 动态状态文案（badge/状态行/导出卡/帧信息/模型选项/缓存提示）随切换重渲染 | ✅ |
| document.title + description/og/twitter/og:locale(zh_CN↔en_US) 同步 | ✅ |
| localStorage `depthvideo-locale` 持久化、启动恢复 | ✅ |
| 默认语言：无偏好时按 navigator.language 探测（zh→中文，否则英文），与原站 kH 一致 | ✅ |
| 语言按钮 is-active + aria-pressed | ✅ |

### 1.11 构建与 license（片6 新增）

| 项 | 结果 |
|---|---|
| `npm run build`（tsc --noEmit + vite build）零错误 | ✅ |
| 产物保留依赖 license 文本 | ✅（`legalComments:'inline'` + 构建时从 node_modules LICENSE 聚合注入 banner；dist 头部 `/*! Bundled third-party license texts ... */` 含 transformers/onnxruntime/tasks-vision/mp4-muxer/三个 fontsource 包全文，grep 验证 5 处 MIT/Apache） |

### 1.12 静态资产（§6）

| 项 | 结果 |
|---|---|
| /logo.png（品牌 + favicon + apple-touch-icon） | ✅ |
| /mediapipe/selfie_segmenter[_landscape].tflite 自托管 | ✅ |
| robots.txt | ➖ 不复制：原站 robots.txt 为 Cloudflare Managed 托管产物（含其对 AI 爬虫的 content signals 权利声明），非应用内容，复刻不照搬 |

## 2. 导出规格一致性（同一测试视频 sample.mp4 640×360 · 4.0s）

| 场景 | 验证方式 | 规格 | 结果 |
|---|---|---|---|
| MP4 主路径（原始尺寸 8fps） | ffprobe | h264 · 640×360 · 8fps · 4.000s · 32 帧 | ✅ |
| WebM 降级（384px 8fps） | ffprobe | vp9 · 384×216 · ≈4s · WebM 容器 | ✅ |
| 分辨率档 512px | ffprobe | 512×288（长边 512、偶数维度） | ✅ |
| 帧率档 12fps | ffprobe | 12/1 fps · 4s · 48 帧 | ✅ |
| 裁剪 0–2.1s | ffprobe | 时长 2.125s ≈ ceil(2.1×8)/8 · 17 帧 | ✅ |
| 文件名 | 下载事件 | `{源名}-depth-{fps}fps.{mp4|webm}` | ✅ |

## 3. 并排截图索引（`acceptance/shots/`）

| 文件 | 内容 |
|---|---|
| `orig-desktop.png` / `ours-desktop.png` | 原站 vs 复刻，桌面 1440×900 中文 |
| `orig-mobile.png` / `ours-mobile.png` | 原站 vs 复刻，移动 390×844 中文 |
| `ours-desktop-en.png` | 复刻 EN 界面（语言切换后） |

目检结论：布局/间距/字号/圆角/玻璃拟态/背景/orb/字体渲染均无可见差异；
差异仅两处 intentional 偏差（header 无海趣社/Twitter 外链、设置栏无模型下载源下拉）。

## 4. e2e 全量结果

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `e2e/smoke.mjs` | 上传/解码/推理/预览/进度/取消/缓存命中 | ✅ PASS |
| `e2e/export.mjs` | MP4 导出 / WebM 降级 / 取消复位重跑 | ✅ PASS |
| `e2e/settings.mjs` | 热力/平滑/分辨率/帧率/裁剪/同步播放 | ✅ PASS |
| `e2e/person.mjs` | 仅人物分割 + 掩码合成 | ✅ PASS |
| `e2e/i18n.mjs`（片6 新增） | 中英切换/缺失 key 扫描/偏好持久化/按钮激活态 | ✅ PASS（38 项断言） |

## 5. 遗留与说明

- settings e2e 在高负载连跑时 sync-play 等待偶发超时（单独重跑即过），非功能缺陷。
- MediaPipe wasm 固定 npmmirror（原站国内源分支），因下载源下拉为 intentional 移除。
- 字体走 fontsource 自托管（国内可达），视觉与原站 Google Fonts 渲染一致。
