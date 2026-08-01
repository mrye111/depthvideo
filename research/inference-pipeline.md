# 票 #3：浏览器端深度推理管线调研

> 调研对象：https://www.depthvideo.com/ （JS bundle `https://www.depthvideo.com/assets/index-B7FSXh3l.js`，756KB，单行压缩）
> 方法：curl 拉取 bundle 后用 grep/正则提取字符串常量与代码片段；npm registry 验证版本号真实性。
> 调研日期：2026-08-01。下文函数名为混淆后名称（如 `QW`/`oG`/`GW`），仅作定位锚点。

## 结论速览（复刻默认值照抄即可）

| 项 | 值 |
|---|---|
| 推理库 | `@huggingface/transformers` **4.2.0**（npm `latest`，已核实） |
| pipeline 类型 | `depth-estimation`（库内置任务） |
| 默认模型 | `onnx-community/depth-anything-v2-small-ONNX`，dtype `fp16`（~48MB） |
| 默认设备 | `webgpu`（备选 `wasm`，UI 手动切换，无自动降级） |
| ORT | `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`（dev 构建，npm 上存在） |
| wasmPaths | 应用未显式设置 → ORT 默认 `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/` |
| wasm 线程数 | `crossOriginIsolated ? min(4, hardwareConcurrency) : 1`；站点**无 COOP/COEP 头**，实际恒为 1 |
| 模型缓存 | Cache API，库名 `transformers-cache-v2` |
| 默认下载源 | `https://modelscope.cn/`（UI 可切 huggingface.co） |
| Worker | 应用层**没有** worker；2 处 `new Worker` 均为 onnxruntime-web 内部（wasm proxy / webgpu bundle）。推理跑在主线程 |
| 人物分割（可选） | MediaPipe ImageSegmenter（`@mediapipe/tasks-vision@0.10.35`）或 transformers `background-removal` |

## 1. transformers.js 版本与 pipeline

- bundle 中 `VERSION = '4.2.0'`，请求头 UA 为 `transformers.js/${version}`；npm registry 核实 `@huggingface/transformers` 的 `dist-tags.latest = 4.2.0`。bundle 内含 `useWasmCache`、`remotePathTemplate`、Chatterbox/Gemma4 等 v4 特征，确认为 v4 而非 v3。
- 深度推理调用（混淆函数 `QW` → `oG`）：

```js
await pipeline('depth-estimation', modelId, { device, dtype, progress_callback })
```

  即库内置 `depth-estimation` 任务（bundle 内可见该任务的 `_call`：`processor` → 模型 → `predicted_depth`）。返回对象取 `l.depth ?? l.predicted_depth`，再 `toCanvas()` 得到灰度图。
- 人物分割备选路径走另一个内置任务：`pipeline('background-removal', 'onnx-community/mediapipe_selfie_segmentation', { device, dtype: 'fp32' })`。

## 2. 模型来源、变体与量化档位

模型全部来自 Hugging Face `onnx-community` 组织（ModelScope 镜像同路径）。bundle 中常量：

```js
FH = 'onnx-community/depth-anything-v2-small-ONNX'  // UI 可见
IH = 'onnx-community/depth-anything-v2-small'       // 仅作回退
LH = 'onnx-community/depth-anything-v2-base-ONNX'   // UI 可见
RH = 'onnx-community/depth-anything-v2-base'        // 仅作回退
```

UI 只提供 4 个选项（`KH` 数组，fp16/fp32 × small/base）：

| 选项 | 模型 | dtype | 标注下载量 | 备注 |
|---|---|---|---|---|
| **默认（selected）** | `depth-anything-v2-small-ONNX` | fp16 | ~48MB | 带「推荐」标签 |
| | `depth-anything-v2-small-ONNX` | fp32 | ~94MB | |
| | `depth-anything-v2-base-ONNX` | fp16 | ~187MB | |
| | `depth-anything-v2-base-ONNX` | fp32 | ~371MB | |

- **量化档位只有 fp16 / fp32**，没有 int8/q4。对应文件：fp16 → `onnx/model_fp16.onnx`（+ `_data` 外部数据），fp32 → `onnx/model.onnx`（缓存探测正则：`/\/onnx\/model_fp16\.onnx(_data)?(\?|$)/i` 与 `model\.onnx`）。
- **变体回退逻辑**（`QW`）：选中 `-ONNX` 后缀变体失败时回退到同名无后缀变体（`[FH, IH]` / `[LH, RH]`，反之亦然）；已缓存的变体排在前面优先尝试。每个候选串行 `try/catch`，全部失败才报错。
- **dtype 不随设备变化**：webgpu 和 wasm 都用用户选的 fp16/fp32。
- 加载超时（`GG` 包装）：small 180s，base 360s，超时抛错并尝试下一候选。

## 3. onnxruntime-web 与 wasm 配置

- bundle 内 `env.backends.onnx.versions.web = '1.26.0-dev.20260416-b7804b056c'`（common 版本 `1.24.3`）。npm registry 核实该 dev 版本号真实存在。
- 应用**没有**显式设置 `env.backends.onnx.wasm.wasmPaths`，走 ORT 默认：

```js
// ORT 内部默认（bundle 原文）
`https://cdn.jsdelivr.net/npm/onnxruntime-web@${versions.web}/dist/`
// Safari 特例：{ mjs: `${e}ort-wasm-simd-threaded.mjs`, wasm: ... }
```

- 另外 bundle 内置了一个本地 wasm 资源 `/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm`，在 wasm proxy worker 初始化且未设 wasmPaths 时作为 `wasmPaths.wasm` 使用（即多线程 wasm 二进制随站分发，worker glue 走 CDN）。
- **SIMD/多线程开关**（bundle 原文，启动时执行）：

```js
env.backends.onnx.wasm.numThreads =
  crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
```

  SIMD 未关（默认启用，`ort-wasm-simd-threaded` 构建）。注意：实测首页响应**没有 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 头**（Cloudflare），`crossOriginIsolated=false`，所以 wasm 模式实际恒为单线程。复刻时若想开多线程需自行加 COOP/COEP。
- 设备选择：`<select id="deviceSelect">` 两项 —— `webgpu`（默认，文案「WebGPU（快速）」）/ `wasm`（「WASM（较慢）」）。**没有自动设备回退**：WebGPU 加载失败只会回退模型变体，不会自动切 wasm；页面仅显示 `gpu in navigator` 的提示徽章。

## 4. 模型缓存策略（Cache API）

- 启动时：`env.cacheKey = 'transformers-cache-v2'`，并删除旧版 `transformers-cache`（`QH=['transformers-cache']`）。
- 启动时跑 `nU()` 清理：遍历 `transformers-cache-v2`，删除 content-type 为 `text/html` 的条目，以及内容以 `<` 开头的 json/config 条目 —— 防止镜像站返回 HTML 错误页污染缓存。
- 自定义 fetch 包装（`tU()`）：响应 `content-type` 含 `text/html` 直接改写成 404；`.json`/`config.json` 类响应前 64 字节以 `<` 开头也改写 404。这是镜像可用性的关键防护，复刻应照做。
- 「已缓存」探测（`$G()`）：遍历 cache keys，按 URL 包含 `/{modelId}/` 且命中 `onnx/model_fp16.onnx(_data)`（fp16）或 `onnx/model.onnx(_data)`（fp32）正则聚合字节数，同时要求 `config.json` 存在；fp16 累计 > 20MB / fp32 > 40MB 才标记「✓ 已缓存」并显示占用空间。
- transformers.js v4 的实验性 `crossOriginStorage`（File System Access，`transformers-hash-cache`）**被关闭**：`experimental_useCrossOriginStorage: false`。
- 加载缓存键：`${modelKey}:${device}:${hub}`，模型/设备/下载源任一变化就重建 pipeline。

## 5. huggingface.co ↔ modelscope.cn 镜像切换

UI `<select id="hubSelect">` 两项，**默认选中 modelscope.cn**（「国内推荐」），另一项 huggingface.co（「官方，需梯子」）。切换函数 `$H()`：

```js
qH = 'https://huggingface.co/'
JH = 'https://modelscope.cn/'
YH = '{model}/resolve/{revision}/'           // HF 路径模板
XH = 'models/{model}/resolve/master/'         // ModelScope 路径模板

env.allowLocalModels = false
env.allowRemoteModels = true
env.remoteHost = hubSelect.value                       // 默认 JH
env.remotePathTemplate = (host === JH) ? XH : YH
```

切换条件：纯用户手动切换，无自动探测/自动故障转移。切换后丢弃已加载 pipeline、关闭 MediaPipe segmenter，并提示重新下载。加载失败时的错误提示文案引导用户「删除 transformers-cache* 后重试」。

MediaPipe 运行时 wasm 也随下载源切换（`GH()`）：

```js
// @mediapipe/tasks-vision 版本 0.10.35
modelscope → 'https://cdn.npmmirror.com/packages/@mediapipe/tasks-vision/0.10.35/files/wasm'
hf         → 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
```

而两个 tflite 分割模型是**自托管**的，与下载源无关（已验证 HTTP 200）：

- `/mediapipe/selfie_segmenter.tflite`
- `/mediapipe/selfie_segmenter_landscape.tflite`

## 6. Worker 架构与逐帧推理调度

- **bundle 全量仅 2 处 `new Worker`，均非应用代码**：
  1. `new Worker(Jr, { type:'module', name:'ort-wasm-proxy-worker' })` —— onnxruntime-web 的 wasm proxy worker；
  2. `new Worker(new URL('ort.webgpu.bundle.min.mjs', import.meta.url))` —— ORT webgpu 内部 worker。
- 21 处 `OffscreenCanvas` 也全部是库内部的 `typeof document < 'u' ? document.createElement('canvas') : new OffscreenCanvas(1,1)` 兼容写法。
- **结论：应用没有自建 worker，深度推理、分割、编码全部跑在主线程**，靠每帧 `await new Promise(r => requestAnimationFrame(r))`（`KG()`）让出主线程保持 UI 响应。

逐帧调度主循环（`GW()`，MP4 路径）：

```
frames = max(1, ceil(clipDuration * fps))          // fps 默认 30
for a in 0..frames-1:
    t = min(start + a/fps, end - 0.001)
    await seek(video, t)          // 设 currentTime，等 'seeked' 事件，5s 超时
    ctx.drawImage(video, ...)     // 画到离屏取帧 canvas
    depth = await depthPipeline(RawImage.fromCanvas(canvas))   // ← 主线程推理
    mask  = personMode ? await segmenter(canvas, t*1000) : null
    renderDepth(depth, mask)      // toCanvas → getImageData → 灰度/turbo 上色 → 画到输出 canvas
    frame = new VideoFrame(outCanvas, { timestamp: a*1e6/fps, duration: 1e6/fps })
    encoder.encode(frame, { keyFrame: a % (fps*2) === 0 })     // 每 2 秒一个关键帧
    if (encoder.encodeQueueSize > 8) await encoder.flush()
    await rAF()                   // 让出主线程
```

- 取帧方式：**`<video>` + currentTime seek + `seeked` 事件**（不是 `requestVideoFrameCallback`，bundle 中 0 处）。
- 编码：WebCodecs `VideoEncoder`，codec 从 `avc1.42001f` 到 `avc1.640034` 逐级 `isConfigSupported` 探测；码率 `clamp(width*height*fps*0.1, 1.5Mbps, 40Mbps)`；封装用内联打包的 **mp4-muxer**（`Muxer` + `ArrayBufferTarget`，`fastStart: { expectedVideoChunks }`）→ MP4 Blob 下载。
- 无 WebCodecs 时回退（`KW()`）：`canvas.captureStream(fps)` + `MediaRecorder`（依次试 `vp9`/`vp8`/默认 webm）→ WebM。
- 人物分割（仅人物模式）：MediaPipe `ImageSegmenter.createFromOptions({ baseOptions:{ modelAssetPath: tflite, delegate:'GPU' }, runningMode:'VIDEO', outputConfidenceMasks:true })`，GPU 失败回退 CPU（超时分别 120s/180s）；每帧 `segmentForVideo(canvas, timestampMs)`，从 confidenceMasks 里按标签 `/person|human|selfie/i` 选人 mask，用于把非人物区域替换为原图或涂黑。

## 7. 复刻要点清单

1. 依赖：`@huggingface/transformers@4.2.0`（其自带 ORT 解析到 `onnxruntime-web@1.26.0-dev.20260416-b7804b056c`）、`@mediapipe/tasks-vision@0.10.35`、`mp4-muxer`。
2. 默认配置：webgpu + `onnx-community/depth-anything-v2-small-ONNX` + fp16 + 960px 边长 + 30fps + modelscope.cn。
3. `env.remoteHost`/`env.remotePathTemplate` 按 §5 双源切换；`env.cacheKey='transformers-cache-v2'`；fetch 包装拒绝 HTML 响应；启动清理旧 cache。
4. 想开 wasm 多线程必须自己发 COOP/COEP 头（原站没发，实际单线程）。
5. 不必引入 worker 架构 —— 原站主线程推理 + rAF 让出即可 1:1 复刻。

## 附：主要证据来源

- `https://www.depthvideo.com/assets/index-B7FSXh3l.js`（本文所有代码片段出处；混淆名 `QW/oG/GW/$H/$G/nU/tU/eG/GG/KG` 等）
- `https://registry.npmjs.org/@huggingface/transformers`（核实 4.2.0 为 latest）
- `https://registry.npmjs.org/onnxruntime-web`（核实 1.26.0-dev.20260416-b7804b056c 存在）
- `https://www.depthvideo.com/mediapipe/selfie_segmenter*.tflite`（HTTP 200，自托管确认）
- 首页响应头（无 COOP/COEP，Cloudflare）
