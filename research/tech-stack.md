# 票 #2：depthvideo.com 技术栈与构建管线调研

调研日期：2026-08-01。方法：抓取线上产物（index.html / JS bundle / CSS）做字符串反推 + `curl -sI` 响应头 + jsdelivr/npm 元数据交叉验证。原始证据文件存于本地 `.recon/`（index.html、bundle.js、style.css，不入库）。

## 结论速览

| 维度 | 结论 | 证据强度 |
|---|---|---|
| UI 框架 | **无框架，原生 JS 直接操作 DOM** | 高 |
| 样式 | **Tailwind CSS v4**（+ Google Fonts 外链） | 高 |
| 语言 | 推断为 TypeScript（无直接证据，见下文） | 中 |
| 构建工具 | **rolldown-vite**（Rolldown 版 Vite） | 高 |
| 推理框架 | **@huggingface/transformers 4.2.0** + **onnxruntime-web 1.26.0-dev.20260416-b7804b056c** | 高（精确版本） |
| 人物分割 | **@mediapipe/tasks-vision 0.10.35**（ImageSegmenter + selfie_segmenter） | 高（精确版本） |
| MP4 导出 | **WebCodecs VideoEncoder（H.264/avc1）+ mp4-muxer**（ArrayBufferTarget，mp4-muxer ≥3.0.0） | 高 |
| WebM 导出 | **MediaRecorder**（无 webm-muxer，纯降级路径） | 高 |
| 深度模型 | `onnx-community/depth-anything-v2-small`（默认）/ `-base`（均有 `-ONNX` 变体） | 高 |
| 部署 | **Vercel 托管 + Cloudflare 前置代理** | 高 |
| Cross-origin isolation | **未启用**（无 COOP/COEP）→ WASM 强制单线程 | 高 |

## 1. UI 框架：无框架原生 JS + Tailwind v4

bundle 中对主流框架的指纹全部为 0：`react`、`[Vue warn]`、`__vue`、`Preact`、`Solid`、`createSignal`、`Svelte`、`Alpine`、`@angular`、`customElements`/`shadowRoot`（Lit/Web Components）均搜不到。DOM 操作全部走原生 API（`createElement` 17 处、`drawImage` 20 处、`addEventListener` 46 处），根节点是 index.html 里的 `<div id="app">`。

样式表 31KB，开头即 Tailwind v4 特征输出：`@layer properties` + `--tw-rotate-x` 等 `--tw-*` 变量 + `@supports (-webkit-hyphens:none)` 复位块（v4 独有签名，v3 没有 `@layer properties`）。字体经 Google Fonts CSS 外链引入：Outfit、Plus Jakarta Sans、JetBrains Mono。

**复刻要点**：不需要 React/Vue，原生 TS + Tailwind v4（`@tailwindcss/vite` 插件）即可 1:1。i18n 为自实现的 zh/en 双语字典（bundle 内有成对的中/英错误文案）。

## 2. 语言：推断 TypeScript

压缩 bundle 无法直接证明源码语言（rolldown 会抹掉类型信息）。间接证据：rolldown-vite 默认原生处理 `.ts`；transformers.js/mp4-muxer 均为 TS 生态。按 TS 复刻即可，风险为零。

## 3. 构建工具：rolldown-vite

证据链：

- bundle 内含 Rolldown 特有警告链接 `https://rolldown.rs/in-depth/bundling-cjs#require-external-modules`（Rolldown 处理 CJS `require` 时注入的提示文本）。
- 产物形态是标准 Vite 输出：`index.html` 中 `<script type="module" crossorigin src="/assets/index-B7FSXh3l.js">`，哈希文件名、`/assets/` 目录、`crossorigin` 属性。
- Worker 通过 `new Worker(new e(...), {type:"module"})` + `import.meta.url` 生成——Vite 的 `worker.format: 'es'`/`?worker` 产物模式。
- ORT 的 wasm 被构建进 `/assets/`：`/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm`（已验证线上 200，`Content-Type: application/wasm`）。即 `env.backends.onnx.wasm.wasmPaths` 指向本地构建产物，不从 CDN 拉 wasm（注意：bundle 里 `cdn.jsdelivr.net/npm/onnxruntime-web@${versions.web}/dist/` 只是 ort 内部默认 CDN 常量，实际被 wasmPaths 覆盖为本地路径）。

无 sourcemap 公开（`/assets/index-B7FSXh3l.js.map` 返回 404）。

**复刻要点**：`npm i vite@npm:rolldown-vite`（或当时最新 rolldown-vite），配置 ORT wasm 文件拷贝进 `assets/`（vite-plugin-static-copy 或 `public/`），worker 用 ESM 格式。

## 4. 运行时依赖与精确版本

全部从 bundle 字符串/上下文反推，并用 jsdelivr API 交叉验证：

| 依赖 | 版本 | 反推依据 |
|---|---|---|
| `@huggingface/transformers` | **4.2.0** | bundle 内 env 初始化处常量 `` `4.2.0` ``（紧邻 `caches in self`、`globalThis.Deno` 的 transformers.js env 特征代码）；npm `latest` 标签正是 4.2.0 |
| `onnxruntime-web` | **1.26.0-dev.20260416-b7804b056c**（dev 通道构建） | bundle 内 `$a=` 常量赋给 `Jn.versions.web`；同对象 `versions.common = 1.24.3`。注意钉的是 **dev 版**，npm `dev` tag 已滚动到更新的 1.29.0-dev，复刻需精确钉这个版本号 |
| `@mediapipe/tasks-vision` | **0.10.35** | bundle 常量 `` BH=`0.10.35` ``，用于拼 `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${BH}/wasm` 与国内镜像 `https://cdn.npmmirror.com/packages/@mediapipe/tasks-vision/${BH}/files/wasm` |
| `mp4-muxer` | bundle 未内嵌版本号；npm latest 为 5.2.2 | 依据 MP4 box 写入字符串 `mp4-muxer-hdlr`（mp4-muxer 源码特征）+ `firstTimestampBehavior`、`fastStart:{expectedVideoChunks}` 对象形态（3.0.0+ 特征）、ArrayBufferTarget |
| （无）`webm-muxer` / `ffmpeg.wasm` / `mp4box` | — | 字符串搜索全部为 0，确认不存在 |

## 5. AI 推理管线

**深度估计**：transformers.js `depth-estimation` pipeline（bundle 可见 `predicted_depth` 输出结构），模型 ID 常量：

- `onnx-community/depth-anything-v2-small`（默认，`default:{model:...}` 处）
- `onnx-community/depth-anything-v2-small-ONNX`
- `onnx-community/depth-anything-v2-base` / `-base-ONNX`

dtype 支持 fp16/fp32/q8/q4（webgpu 用 fp16，wasm 退回 fp32/uint8）。device 优先级 WebGPU → WASM：有 `navigator.gpu` 检测与 `WebGPU is not supported on this browser` 报错文案。模型从 `https://huggingface.co/`（`remoteHost`）下载，镜像 `https://modelscope.cn/`（`models/{model}/resolve/master/` 模板），用 **Cache API 缓存**，缓存名常量 `transformers-cache-v2`（旧名 `transformers-cache` 也在兼容列表）。

**人物分割（"仅人物"模式）**：`@mediapipe/tasks-vision` 的 `ImageSegmenter.createFromOptions` + `FilesetResolver.forVisionTasks`，模型为 MediaPipe selfie segmentation（bundle 内 `mediapipe/selfie_segmenter.tflite`、`selfie_segmenter_landscape.tflite` 及 `mediapipe.tasks.vision.image_segmenter.ImageSegmenterGraph` 等图名），托管仓 `onnx-community/mediapipe_selfie_segmentation`。tasks-vision 的 wasm 运行时从 jsdelivr 加载，国内走 npmmirror。

**线程**：bundle 内逻辑 `numThreads = crossOriginIsolated ? Math.min(4, hardwareConcurrency||4) : 1`——当前站点未开隔离，实际**单线程 WASM**。

## 6. 视频处理与导出管线

- **解码**：无 `VideoDecoder`（0 处）。用 `<video>` 元素逐帧 seek（`currentTime` 6 处）+ `drawImage` 绘制到 canvas/`OffscreenCanvas`（21 处）取帧。纯 DOM 解码，兼容性最好但逐帧 seek 慢。
- **MP4 导出**：WebCodecs `VideoEncoder`（先 `isConfigSupported` 探测，编码配置含 `avc:{format:"avc"}`，即 H.264 Annex-B→AVCC），mux 用 mp4-muxer ≥3.0.0，`ArrayBufferTarget` 内存拼装、结束后 `new Blob([target.buffer])` 一次性成 Blob（经票 #4 更正，非 StreamTarget；`fastStart:{expectedVideoChunks}` 对象形态为 3.0.0+ 特征）。
- **WebM 导出**：`MediaRecorder` + `captureStream()`（各 1 处），并有明确降级文案：`status.fallbackWebm`: "当前浏览器不支持 WebCodecs…回退 MediaRecorder"/"WebCodecs unavailable — falling back"。即 **WebCodecs+mp4-muxer 为主路径，MediaRecorder 为兜底**。

## 7. 部署形态与响应头

`curl -sI https://www.depthvideo.com/`（2026-08-01）关键头：

```
Server: cloudflare
x-vercel-cache: HIT
x-vercel-id: fra1::...
strict-transport-security: max-age=63072000
access-control-allow-origin: *
Cache-Control: public, max-age=0, must-revalidate   # HTML
Cache-Control: public, max-age=14400, must-revalidate  # /assets/*（仅 4h，非 immutable）
```

**架构：Vercel 源站 + Cloudflare 代理前置**（x-vercel-* 与 CF-RAY 同时出现，域名 NS 指 Cloudflare，CNAME 到 Vercel）。

**重点确认：没有任何 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` 头**（HTML、JS、CSS、wasm 均查过）。因此 `crossOriginIsolated === false`，`SharedArrayBuffer` 不可用，ORT WASM 被 bundle 内逻辑强制 `numThreads=1`。bundle 里甚至保留了 ort 的警告文案（"...will not work unless you enable crossOriginIsolated mode. See https://web.dev/cross-origin-isolation-guide/..."）。

**复刻决策点**：1:1 复刻应**同样不发 COOP/COEP**（行为一致、第三方字体/视频无 CORP 问题）。若要超越原站提速 WASM 推理，可加 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless`（不能用 require-corp，Google Fonts 等外链不带 CORP），即可解锁 `SharedArrayBuffer` 与 4 线程 WASM——这是原站留下的明显优化空间。

其他：`access-control-allow-origin: *` 全站开放 CORS；HSTS 两年。

## 8. 其他侦察结论

- 站点作者：header 链接 `https://dz.haiqushe.com/`、`https://x.com/haiqushe`。
- i18n：zh / en 双语文案字典，`og:locale` 等 SEO 元信息齐全，`zh-CN` 为默认语言。
- index.html 含 `application/ld+json` WebApplication 结构化数据 + `<noscript>` 爬虫说明，说明原站重视 SEO，复刻应照搬。

## 复刻依赖清单（可直接照做）

```json
{
  "dependencies": {
    "@huggingface/transformers": "4.2.0",
    "onnxruntime-web": "1.26.0-dev.20260416-b7804b056c",
    "@mediapipe/tasks-vision": "0.10.35",
    "mp4-muxer": "^5.2.2"
  },
  "devDependencies": {
    "vite": "npm:rolldown-vite@latest",
    "tailwindcss": "^4",
    "@tailwindcss/vite": "^4",
    "typescript": "^5"
  }
}
```

关键 vite 配置：ESM worker；把 `onnxruntime-web/dist/ort-wasm-simd-threaded*`（.mjs/.wasm/asyncify 版共 5 个文件）拷入 `assets/` 并设 `env.backends.onnx.wasm.wasmPaths` 指向本地；不发 COOP/COEP；模型走 Hugging Face + ModelScope 双源、Cache API 缓存（cache key `transformers-cache-v2`）。
