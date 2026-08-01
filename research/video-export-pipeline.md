# 票 #4：视频处理与导出管线调研（解码 → 深度推理 → 渲染 → 导出 MP4/WebM）

调研日期：2026-08-01。方法：对线上 bundle `assets/index-B7FSXh3l.js`（756KB，minified）做字符串/上下文反推，关键特征（mp4-muxer API 形态）用 npm registry / jsdelivr `.d.ts` / GitHub commit 史交叉验证。原始证据在本地 `research-snapshot/`（gitignored，不入库）。下文中 `gG/KW/dG` 等是压缩后的函数名，仅为定位引用；复刻时按语义命名即可。

## 结论速览

| 问题 | 结论 |
|---|---|
| 逐帧解码 | **HTMLVideoElement 逐帧 seek + canvas drawImage**，不用 WebCodecs VideoDecoder |
| MP4 导出 | WebCodecs `VideoEncoder`（H.264/avc1，逐级探测 profile）+ **mp4-muxer ≥ 3.0.0**，`ArrayBufferTarget`（更正票 #2 的 "StreamTarget"） |
| WebM 导出 | `canvas.captureStream(fps)` + `MediaRecorder`，mimeType 探测 `vp9 → vp8 → 裸 webm`，是纯降级路径 |
| 灰度/热力 colormap | 逐像素 JS 实现；"热力" 名为 turbo 实为 **Jet 近似**（RGB 三角函数） |
| 仅人物 | MediaPipe `ImageSegmenter`（selfie_segmenter，tasks-vision@0.10.35，VIDEO 模式，confidenceMask）或 transformers.js `background-removal`；掩码 alpha>128 硬阈值合成 |
| 进度/取消 | 全局取消 flag + 每帧循环开头检查；进度 = done/total 百分比 + 实时 fps；错误按正则分类提示 |

## 1. 整体管线（每帧）

MP4 主路径的帧循环（bundle 中原样逻辑）：

```js
const fps = Number(fpsSelect.value);                 // 8/12/15/24/30(默认·推荐)/60
const { start, end, clipDuration } = getClipRange(); // 修剪区间，最短 0.1s
const total = Math.max(1, Math.ceil(clipDuration * fps));
const frameUs = Math.round(1e6 / fps);               // 帧时长，微秒

for (let a = 0; a < total; a++) {
  if (cancelled) throw Error(t('status.aborted'));   // 每帧开头查取消
  const tSec = Math.min(start + a / fps, Math.max(start, end - 0.001));
  await seekVideo(tSec);                             // ① video 元素 seek 解码
  drawFrame();                                       // ② drawImage 到处理画布
  const raw = await depthPipe(RawImage.fromCanvas(processCanvas));      // ③ 深度推理
  const mask = segFn ? await segFn(processCanvas, Math.round(tSec*1e3)) : null; // ④ 人物掩码
  renderDepth(raw.depth ?? raw.predicted_depth, mask);                  // ⑤ colormap+掩码合成到输出画布
  // ⑥ 编码：
  const frame = new VideoFrame(outputCanvas, { timestamp: a*frameUs, duration: frameUs });
  encoder.encode(frame, { keyFrame: a % Math.max(1, fps*2) === 0 });    // 关键帧间隔 = 2s
  frame.close();
  if (encoder.encodeQueueSize > 8) await encoder.flush();               // 背压
  await new Promise(r => requestAnimationFrame(r));                     // 让出主线程
}
```

- 解码就是普通 `<video>` 元素：`seekVideo(t)` 设 `$.pause(); $.currentTime = t`，等 `seeked` 事件（`once`），5 秒超时抛 `error.seekTimeout`；`|currentTime - t| < 0.01` 且 `readyState >= HAVE_CURRENT_DATA` 时跳过重复 seek。帧时间钳制在 `[start, end-0.001]`，防止 seek 到片段末尾之外。
- 处理画布分辨率由 `sizeSelect` 决定：`384 / 512 / 640 / 960(默认·推荐) / 1024 / 1280 / 1920 / original`，取**长边**缩到该值、保宽高比、两维都向下取偶（`n - n%2`，H.264 要求偶数）。`original` 用源视频原始尺寸。
- 视频元数据就绪判定：`loadedmetadata` / `loadeddata` / `canplay` 任一触发即继续，10 秒全部不来抛 `error.metadataTimeout`。

## 2. MP4 导出：VideoEncoder + mp4-muxer

### 2.1 可用性判定与降级条件

```js
const config = ('VideoEncoder' in window && 'VideoFrame' in window)
  ? await probeEncoderConfig(w, h, fps) : null;
if (!config) { /* 降级 WebM，提示 status.fallbackWebm */ }
```

`probeEncoderConfig`（bundle 函数 `gG`）——**bitrate 公式与 codec 候选列表是重点**：

```js
const bitrate = Math.min(4e7, Math.max(15e5, Math.round(w * h * fps * 0.1)));
// 即 0.1 bit/像素/帧，夹在 [1.5 Mbps, 40 Mbps]
// 例：1280×720@30 → 2.76 Mbps；1920×1080@30 → 6.2 Mbps；960×540@30 → 1.5 Mbps（触下限）
for (const codec of [
  'avc1.42001f', 'avc1.4d001f',                 // Baseline/Main L3.1
  'avc1.420028', 'avc1.4d0028', 'avc1.640028',  // +High L4.0
  'avc1.4d0029', 'avc1.640029',                 // Main/High L4.1
  'avc1.640032', 'avc1.640033', 'avc1.640034',  // High L5.0/5.1/5.2
]) {
  const cfg = { codec, width: w, height: h, framerate: fps, bitrate, avc: { format: 'avc' } };
  try {
    const s = await VideoEncoder.isConfigSupported(cfg);
    if (s.supported) return s.config ?? cfg;
  } catch {}
}
return null; // 全部不支持 → 降级 WebM
```

### 2.2 封装（mux）

```js
const target = new ArrayBufferTarget();            // bundle: new at，结束后读 target.buffer
const muxer = new Muxer({
  target,
  video: { codec: 'avc', width, height, frameRate: fps },
  fastStart: { expectedVideoChunks: total },
  firstTimestampBehavior: 'strict',
});
const encoder = new VideoEncoder({
  output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
  error: e => { encErr = e; },                     // 存起来，帧循环里检查并抛出
});
encoder.configure(config);
// …帧循环…
await encoder.flush(); encoder.close();
muxer.finalize();
blob = new Blob([target.buffer], { type: 'video/mp4' });
filename = `${源文件名去扩展名}-depth-${fps}fps.mp4`;
```

- **版本核实**：bundle 内嵌 mp4-muxer 源码（含特征字符串 `mp4-muxer-hdlr`，写入 hdlr box 的 name 字段）。版本号不在 bundle 里，但 `fastStart: { expectedVideoChunks }` 对象形态在 mp4-muxer **2.3.0 的 `.d.ts` 中不存在、3.0.0 起存在**（jsdelivr 验证：`mp4-muxer@3.0.0/build/mp4-muxer.d.ts` 含 `expectedVideoChunks` 与 `firstTimestampBehavior?: 'strict' | 'offset'`）。结论：**mp4-muxer ≥ 3.0.0**；npm latest 已到 5.2.2（2024-08 发 5.0.0，API 兼容），复刻钉 latest 即可。
- **更正票 #2**：票 #2 写的是 StreamTarget，实际证据是 `new Blob([target.buffer])`——`ArrayBufferTarget`（整片在内存拼装，结束后一次性成 Blob）。`fastStart` 对象形态也是因为内存目标允许 moov 前置。
- 时间戳：`timestamp = 帧序号 × round(1e6/fps)`（微秒，从 0 开始，配合 `firstTimestampBehavior: 'strict'`）；`duration` 同值。
- 关键帧：每 `2 × fps` 帧一个 IDR（即约 2 秒一个 GOP）。
- 背压：`encodeQueueSize > 8` 时 `await encoder.flush()`。
- 无音频轨——输出是纯视频 MP4。

## 3. WebM 导出：MediaRecorder 降级路径

触发条件（满足其一）：浏览器无 `VideoEncoder`/`VideoFrame`，或 2.1 的 10 个 avc1 配置全部 `isConfigSupported === false`。UI 提示「当前浏览器不支持 WebCodecs，已切换为 WebM」。

bundle 函数 `KW` 原样逻辑：

```js
const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  .find(m => MediaRecorder.isTypeSupported(m)) || '';
if (!mimeType) throw Error(t('status.noMediaRecorder')); // 连 MediaRecorder 都没有 → 报错终止

const stream = outputCanvas.captureStream(fps);            // CanvasCaptureMediaStreamTrack
const rec = new MediaRecorder(stream, { mimeType });       // 不设 videoBitsPerSecond，用浏览器默认
const chunks = [];
rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
rec.start(1000);                                           // 每 1s 吐一个 chunk

// 帧循环与 MP4 路径相同（seek→推理→渲染），但编码换成：
//   renderDepth 画到 outputCanvas 后 await sleep(Math.round(1000/fps))  —— 按真实时间节奏喂帧
//   （captureStream 按 fps 抓画布当前内容，所以必须按墙钟节奏停留）

rec.stop();
await new Promise(r => rec.addEventListener('stop', r, { once: true }));
for (const track of stream.getTracks()) track.stop();
blob = new Blob(chunks, { type: mimeType });
filename = `${源文件名去扩展名}-depth-${fps}fps.webm`;
```

要点：
- **无 webm-muxer**（字符串搜索为 0，与票 #2 一致）——WebM 完全靠 MediaRecorder 实时封装。
- 因为 `captureStream` 是实时抓取，WebM 路径耗时 ≈ 片段时长（30fps 处理 10s 片段 ≈ 10s+），而 MP4 路径可以快于实时。
- 不指定码率，画质由浏览器 MediaRecorder 默认决定（Chrome VP9 默认约 2.5 Mbps 量级，不保证一致）。
- 同样无音频。

## 4. 灰度 / 热力 colormap（bundle 函数 `mG` / `hG`）

渲染流程：深度 tensor → `toCanvas()` → `getImageData` → 逐像素改写（`mG`）→ `putImageData` → drawImage 拉伸到输出画布 → （可选）人物掩码合成。

```js
// 方向（directionSelect）：near-white(默认，近=白) 用原值；far-white(远=白) 取 255 - v
const v = invert ? 255 - px.r : px.r;
// 时域平滑（smoothRange，0–0.85，step 0.05，默认 0.35）：
//   out = prevFrame ? round(prev*k + v*(1-k)) : v   —— 一阶 IIR，与上一帧输出做指数平均
// 样式（styleSelect）：gray(默认) → [v,v,v]；turbo → jet(v/255)
function jet(x) { // bundle 里叫 turbo 选项，但数学是经典 Jet 的三角近似，不是 Google turbo
  return [
    Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4*x - 3)))), // R
    Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4*x - 2)))), // G
    Math.round(255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4*x - 1)))), // B
  ];
}
```

复刻要点：照抄这三个三角函数即可 1:1；不要换成真正的 turbo colormap LUT，否则颜色对不上。平滑系数作用在**colormap 之前的标量**上，且状态（上一帧 ImageData）在重新开始导出/换参数时重置。

## 5. 「仅人物」模式

### 5.1 三个分割后端（segModelSelect，仅 personModeSelect=person 时启用）

| 选项 | 实现 |
|---|---|
| `mediapipe`（默认）| MediaPipe ImageSegmenter + `/mediapipe/selfie_segmenter.tflite`（本站同源托管，已验证 HTTP 200） |
| `mediapipe-landscape` | 同上，换 `/mediapipe/selfie_segmenter_landscape.tflite`（横屏优化版，也已验证 200） |
| `transformers` | transformers.js `background-removal` pipeline + `onnx-community/mediapipe_selfie_segmentation`，dtype `fp32`，跟随深度模型的 device/hub 设置 |

### 5.2 MediaPipe 初始化（bundle 函数 `eG`）

```js
const WASM_URL = hubSelect.value === 'https://modelscope.cn/'
  ? 'https://cdn.npmmirror.com/packages/@mediapipe/tasks-vision/0.10.35/files/wasm'  // 国内镜像
  : 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';             // 官方源
const vision = await withTimeout(FilesetResolver.forVisionTasks(WASM_URL), 60_000);  // wasm 加载 60s 超时
let segmenter;
try {
  segmenter = await withTimeout(ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: tflitePath, delegate: 'GPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  }), 120_000);                                                  // GPU 初始化 120s 超时
} catch {
  // 失败降级 CPU delegate，180s 超时
  segmenter = await withTimeout(ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: tflitePath, delegate: 'CPU' },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  }), 180_000);
}
```

注意：wasm 的 CDN 跟随「模型源」下拉（hubSelect）走——选 ModelScope（国内）就用 npmmirror，否则 jsdelivr；**tflite 模型文件本身始终从本站同源路径加载**，不走 CDN。

### 5.3 每帧推理与掩码提取

```js
const result = segmenter.segmentForVideo(processCanvas, Math.max(0, timestampMs)); // VIDEO 模式必须给单调时间戳
// 选 person 通道：labels 里找 /person|human|selfie/i 的下标；找不到就 masks[1]（selfie 是 2 类：背景/人物），再不行 masks[0]
const mask = pickPersonMask(result.confidenceMasks, segmenter.getLabels());
// 掩码 → 灰度 RGBA：float32 clamp[0,1]*255，R=G=B=A=v（rG）；尺寸与处理画布不一致时用 drawImage 平滑拉伸
// 推理失败/无掩码 → 返回全白掩码（nG：fill(255)）——即"分割失败时保留全图"，不会黑屏
result.close();
```

### 5.4 掩码与深度图合成（bundle 函数 `pG`）

深度图 colormap 完成、drawImage 到输出画布后，再逐像素过一遍：

```js
// maskAlpha > 128 → 保留深度像素（硬阈值 128/255，无羽化/无边缘平滑）
// maskAlpha <= 128 → 按 personBgSelect 处理背景：
//   'original'（默认，"保留原图"）：若原始帧与输出同尺寸则拷回原始 RGB，否则涂黑
//   'black'（"涂黑"）：RGB 置 0
// alpha 读取顺序：mask.data[i+3] ?? mask.data[i] ?? 0
px[i+3] = 255; // 输出恒不透明
```

时序注意：掩码是对**当前帧的处理画布**（缩放后分辨率）跑的 `segmentForVideo`，时间戳用 `Math.round(tSec * 1000)` 毫秒；掩码随后被拉伸到输出画布尺寸再合成。导出循环里分割与深度推理是**串行 await** 的（先深度后分割），没有并行。

## 6. 进度 / 取消 / 错误处理

### 6.1 进度

- 每帧更新 `PG(done, total, instantFps)`：进度条 `width%` + `NN%` 文本 + 实时处理速度（`done / 已耗秒` 一位小数 fps）+ 状态文案「处理中：{done}/{total} 帧…」+ 输出窗口帧计数 `FRAME x / y`。
- 阶段状态机：`badge.processing`（忙）→ `export.muxing`「封装中」→ `badge.done` / `badge.cancelled` / `badge.error`。模型/wasm 下载另有每秒刷新的计时文案（「已下载 xx%」「初始化 GPU 中（Ns）」）。
- 每帧末尾 `await requestAnimationFrame` 让出主线程，保证进度 UI 能绘制。

### 6.2 取消

- 全局 `cancelled` flag：取消按钮置 `true` 并显示「正在取消」；**帧循环开头**每帧检查，命中则 `throw Error(t('status.aborted'))`（"用户取消" / "Cancelled by user"）。模型下载/初始化的每秒 tick 回调里也检查该 flag（停止更新文案，加载 Promise 本身不被 abort）。
- catch 里靠文案匹配识别取消：`String(e).includes(t('status.aborted')) || includes('用户取消') || includes('Cancelled by user')` → 状态置 `cancelled`，清理编码器/录像机路径直接走 finally 复位。
- 取消时机粒度 = 一帧；正在 `await` 的推理不会被中断，要等它返回。

### 6.3 错误

- 导出主函数 try/catch/finally：非取消错误 → 控制台输出 + 状态 `error`，message 取 `e.message`；若 message 匹配 `/failed to fetch|unexpected token|not valid json/i`（模型/wasm 拉取失败特征）→ 追加 hint 文案「切换镜像源 / 开代理 / 删 Cache Storage 里 transformers-cache* 重试」。
- `finally` 统一复位 UI 状态（按钮、进度条）。
- 超时汇总：视频元数据 10s；单帧 seek 5s；MediaPipe wasm 60s / GPU 初始化 120s / CPU 初始化 180s；分割模型下载显示百分比进度（走 transformers.js `progress_callback`）。
- MP4 编码器异步错误（`error` 回调）先存变量，帧循环下一帧开头检查并抛出——不会静默丢。

## 7. 复刻核对清单

1. `<video>` + seek 解码即可，不要上 VideoDecoder（站点自己也没用）。
2. `VideoEncoder` 配置探测照抄 2.1 的 10 个 avc1 候选 + `bitrate = clamp(1.5e6, w*h*fps*0.1, 4e7)` + `avc: { format: 'avc' }`。
3. `npm i mp4-muxer`（≥3.0.0，当前 5.2.2），`ArrayBufferTarget` + `fastStart: { expectedVideoChunks }` + `firstTimestampBehavior: 'strict'`；关键帧 `frame % (2*fps) === 0`；`encodeQueueSize > 8` flush 背压。
4. WebM：`captureStream(fps)` + MediaRecorder，mimeType `vp9→vp8→webm` 探测，`start(1000)`，帧间 `sleep(1000/fps)`。
5. 热力图用第 4 节的 Jet 三角函数，别用真 turbo LUT；时域平滑是 `out = prev*k + cur*(1-k)`，k 默认 0.35。
6. 人物模式：tasks-vision 钉 **0.10.35**，双 wasm CDN（npmmirror/jsdelivr 按 hub 切换），GPU→CPU delegate 降级，confidenceMask 选 person 通道，alpha>128 硬合成，背景可选涂黑/保留原图；tflite 放自己站点 `/mediapipe/` 下（两个文件都要）。
7. 取消用每帧开头检查的全局 flag；错误按 fetch 正则分类给镜像提示。

## 证据与来源

- 一手：`https://www.depthvideo.com/assets/index-B7FSXh3l.js`（本地副本 `research-snapshot/index-B7FSXh3l.js`）——本文所有代码片段均由其中对应压缩函数（`gG` 配置探测、MP4 帧循环、`KW` WebM 路径、`mG/hG` colormap、`eG/rG/nG/pG` 分割合成、`yG` seek、`PG` 进度）还原。
- 同源资源验证：`curl -sI https://www.depthvideo.com/mediapipe/selfie_segmenter.tflite` → 200（`access-control-allow-origin: *`）；landscape 版同。
- mp4-muxer 版本下界：jsdelivr `mp4-muxer@2.3.0/build/mp4-muxer.d.ts` 无 `expectedVideoChunks`（grep=0），`@3.0.0` 有（grep=2）且 `firstTimestampBehavior?: 'strict' | 'offset'`；npm registry latest=5.2.2。
- tasks-vision 0.10.35、bundle 常量 `BH='0.10.35'` 与双 CDN URL 模板在 bundle 中直接可见。
