// 字体自托管（fontsource variable fonts，国内可达，无 Google Fonts 外链）
import '@fontsource-variable/outfit';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import { initApp } from './app';

/**
 * 片1：静态 UI 骨架。
 * DOM 结构 / class / data-i18n key / 中文文案逐字照搬 research-snapshot/template_full.txt，
 * 仅两处 intentional 偏差：
 *   1. header 移除「海趣社」「Twitter」两条外链；
 *   2. 设置栏移除「模型下载源」（hubSelect）设置项。
 * 片5 追加：深度模型下拉里加 #baseNcWarning（base=CC-BY-NC 非商用警示，#7 硬性要求）。
 * 交互逻辑在后续片实现。
 */
const template = `
  <div class="app-root">
    <div class="bg-stage" aria-hidden="true"></div>
    <div class="bg-grid" aria-hidden="true"></div>
    <div class="orb orb-a" aria-hidden="true"></div>
    <div class="orb orb-b" aria-hidden="true"></div>
    <div class="orb orb-c" aria-hidden="true"></div>

    <main class="app-shell fade-in">
      <header class="app-header">
        <div class="flex flex-wrap items-center gap-2 sm:gap-3">
          <div class="brand-lockup">
            <img class="brand-logo" src="/logo.png" width="36" height="36" alt="Depth Video" />
            <h1 class="brand-mark font-display text-xl font-extrabold tracking-tight sm:text-2xl lg:text-3xl">
              Depth <span class="text-accent">Video</span>
            </h1>
          </div>
          <span class="chip chip-ok" data-i18n="chip.localOnly">仅本地运行</span>
          <span class="chip" data-i18n="chip.noApi">无需 API</span>
          <span class="chip" data-i18n="chip.feature">视频深度图提取</span>
        </div>
        <nav class="header-links" data-i18n-aria="nav.external" aria-label="外部链接">
          <div class="lang-switch" role="group" data-i18n-aria="nav.lang" aria-label="语言">
            <button type="button" class="lang-btn" data-lang="zh" aria-pressed="false">中文</button>
            <button type="button" class="lang-btn" data-lang="en" aria-pressed="false">EN</button>
          </div>
        </nav>
      </header>

      <div class="app-body">
      <section class="app-workspace fade-in-delay">
        <!-- 输入 -->
        <section class="glass glass-strong panel-card p-2.5 sm:p-3.5">
          <div class="panel-head">
            <h2 class="font-display text-sm font-semibold tracking-wide text-ink sm:text-base">
              <span data-i18n="input.title.prefix">输入</span> <span class="text-muted">——</span> <span data-i18n="input.title.suffix">上传视频</span>
            </h2>
            <span id="inputBadge" class="chip" data-i18n="badge.noVideo">没有视频</span>
          </div>

          <div id="dropZone" class="media-panel drop-zone is-pickable" role="button" tabindex="0" data-i18n-aria="drop.aria" aria-label="选择视频">
            <span class="corner corner-tl"></span>
            <span class="corner corner-tr"></span>
            <span class="corner corner-bl"></span>
            <span class="corner corner-br"></span>

            <video id="sourceVideo" class="media-el" muted playsinline controls hidden></video>

            <div id="inputEmpty" class="panel-empty">
              <div class="upload-ring">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="6" width="18" height="14" rx="2" stroke="#8b7cf6" stroke-width="1.6"/>
                  <path d="M3 10h18" stroke="#8b7cf6" stroke-width="1.6"/>
                  <path d="M10 14.5l5 2.5-5 2.5v-5z" fill="#8b7cf6"/>
                </svg>
              </div>
              <strong class="font-display text-base font-semibold text-ink sm:text-lg" data-i18n="drop.title">将视频拖拽到这里</strong>
              <span class="max-w-xs text-xs leading-relaxed text-muted sm:text-sm" data-i18n-html="drop.hint">
                或点击此处选择视频<br>支持格式：mp4 / webm / mov（仅 1 个）
              </span>
            </div>
          </div>

          <div class="trim-wrap" id="trimWrap" hidden>
            <div class="trimbar" id="trimBar">
              <canvas id="trimStrip" height="48"></canvas>
              <div class="trim-shade" id="shadeL"></div>
              <div class="trim-shade" id="shadeR"></div>
              <div class="trim-region" id="trimRegion"></div>
              <div class="trim-handle" id="trimL" role="slider" data-i18n-aria="trim.start" aria-label="开始时间" tabindex="0">⋮</div>
              <div class="trim-handle" id="trimR" role="slider" data-i18n-aria="trim.end" aria-label="结束时间" tabindex="0">⋮</div>
            </div>
            <div class="trim-info">
              <span class="trim-hint" id="rangeInfo" data-i18n="trim.selectedEmpty">已选：—</span>
              <button id="rangeResetBtn" class="trim-reset" type="button" data-i18n="trim.reset">重置</button>
            </div>
          </div>

          <div class="panel-footer panel-footer-input">
            <label class="inline-flex shrink-0">
              <span id="pickVideoLabel" class="btn btn-primary cursor-pointer !min-h-9 !px-4 sm:!min-h-10 sm:!px-5" data-i18n="btn.pickVideo">选择视频</span>
              <input id="fileInput" class="sr-only" type="file" accept="video/mp4,video/webm,video/quicktime,video/*">
            </label>
            <div class="meta-strip" data-i18n-title="meta.sourceInfo" title="源视频信息">
              <div class="meta-item meta-item-file">
                <span data-i18n="meta.file">文件</span>
                <strong id="sourceFileName" title="">—</strong>
              </div>
              <div class="meta-item meta-item-source">
                <span data-i18n="meta.source">源</span>
                <strong id="sourceMeta">—</strong>
              </div>
            </div>
          </div>
        </section>

        <!-- 输出 -->
        <section class="glass glass-strong panel-card p-2.5 sm:p-3.5">
          <div class="panel-head">
            <h2 class="font-display text-sm font-semibold tracking-wide text-ink sm:text-base">
              <span data-i18n="output.title.prefix">输出</span> <span class="text-muted">——</span> <span data-i18n="output.title.suffix">深度视频</span>
            </h2>
            <span id="outputBadge" class="chip" data-i18n="badge.waiting">等待中</span>
          </div>

          <div id="outputPanel" class="media-panel">
            <span class="corner corner-tl"></span>
            <span class="corner corner-tr"></span>
            <span class="corner corner-bl"></span>
            <span class="corner corner-br"></span>

            <canvas id="depthCanvas" class="media-el" hidden></canvas>
            <video id="resultVideo" class="media-el" muted playsinline controls hidden></video>

            <div id="outputEmpty" class="panel-empty">
              <div class="upload-ring">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="2" y="4" width="20" height="14" rx="2" stroke="#8b7cf6" stroke-width="1.6"/>
                  <path d="M8 21h8" stroke="#8b7cf6" stroke-width="1.6" stroke-linecap="round"/>
                  <path d="M10 11.5l4 2.5-4 2.5v-5z" fill="#8b7cf6"/>
                </svg>
              </div>
              <strong class="font-display text-base font-semibold text-ink sm:text-lg" data-i18n="output.previewTitle">实时转换预览</strong>
              <span class="max-w-xs text-xs leading-relaxed text-muted sm:text-sm" data-i18n="output.previewHint">
                点击【开始】后，这里会逐帧显示深度图转换过程。
              </span>
            </div>

            <div id="liveFrameTag" class="live-tag" hidden>
              <span class="live-dot"></span>
              <span id="liveFrameText">FRAME 0</span>
            </div>
          </div>

          <div class="export-slot" id="exportSlot" hidden>
            <div id="exportCard" class="export-card export-idle">
              <div class="export-status-row">
                <span class="export-dot" aria-hidden="true"></span>
                <div class="min-w-0 flex-1">
                  <p id="exportStatusLabel" class="export-label" data-i18n="export.idleLabel">等待开始</p>
                  <p id="exportStatusDetail" class="export-detail" data-i18n="export.idleDetail">选择视频后点击开始，完成后可在此下载</p>
                </div>
                <button id="downloadButton" class="btn btn-start !min-h-8 !px-3 shrink-0" type="button" hidden disabled>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span data-i18n="btn.download">下载</span>
                </button>
              </div>
            </div>
          </div>

          <div class="panel-footer">
            <div class="meta-strip" data-i18n-title="meta.processInfo" title="处理信息">
              <div class="meta-item">
                <span data-i18n="meta.output">输出</span>
                <strong id="outputMeta">—</strong>
              </div>
              <div class="meta-item">
                <span data-i18n="meta.frames">帧</span>
                <strong id="frameMeta">—</strong>
              </div>
              <div class="meta-item">
                <span data-i18n="meta.speed">速度</span>
                <strong id="speedMeta">—</strong>
              </div>
            </div>
          </div>
        </section>

        <!-- 设置 -->
        <aside class="settings-panel fade-in-delay-2 glass p-2.5 sm:p-3.5">
          <div class="settings-scroll space-y-3 sm:space-y-4">
            <button id="syncPlayButton" class="btn btn-primary w-full !min-h-9 sm:!min-h-10" type="button" disabled>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 5v14l11-7L8 5z" fill="currentColor"/>
              </svg>
              <span data-i18n="btn.syncPlay">同步播放</span>
            </button>

            <section>
              <p class="section-title" data-i18n="section.model">模型</p>
              <div class="settings-card grid gap-2.5 sm:gap-3">
                <label>
                  <span class="field-label">
                    <span data-i18n="field.depthModel">深度模型</span>
                    <span id="modelCacheHint" class="font-mono text-[0.68rem] text-ok"></span>
                  </span>
                  <select id="modelSelect" class="control">
                    <option value="onnx-community/depth-anything-v2-small-ONNX::fp16" selected>V2 Small · ONNX · f16（~48MB，推荐）</option>
                    <option value="onnx-community/depth-anything-v2-small-ONNX::fp32">V2 Small · ONNX · f32（~94MB）</option>
                    <option value="onnx-community/depth-anything-v2-base-ONNX::fp16">V2 Base · ONNX · f16（~187MB）</option>
                    <option value="onnx-community/depth-anything-v2-base-ONNX::fp32">V2 Base · ONNX · f32（~371MB）</option>
                  </select>
                  <p id="baseNcWarning" class="nc-warning" role="note" hidden>
                    ⚠ V2 Base 模型许可证为 CC-BY-NC-4.0，仅供学习研究，禁止商用。
                  </p>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.backend">运行后端</span>
                  <select id="deviceSelect" class="control">
                    <option value="webgpu" data-i18n="device.webgpu">WebGPU（快速）</option>
                    <option value="wasm" data-i18n="device.wasm">WASM（较慢）</option>
                  </select>
                </label>
              </div>
            </section>

            <section>
              <p class="section-title" data-i18n="section.process">处理设置</p>
              <div class="settings-card grid gap-2.5 sm:gap-3">
                <label>
                  <span class="field-label" data-i18n="field.resolution">分辨率（最长边）</span>
                  <select id="sizeSelect" class="control">
                    <option value="384" data-i18n="size.fast">384px · 快速</option>
                    <option value="512" data-i18n="size.balanced">512px · 一般</option>
                    <option value="640" data-i18n="size.normal">640px · 普通</option>
                    <option value="960" selected data-i18n="size.recommended">960px · 推荐</option>
                    <option value="1024" data-i18n="size.hd">1024px · 高清</option>
                    <option value="1280" data-i18n="size.720p">1280px · 720p</option>
                    <option value="1920" data-i18n="size.1080p">1920px · 1080p</option>
                    <option value="original" data-i18n="size.original">原始尺寸</option>
                  </select>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.fps">处理帧率（FPS）</span>
                  <select id="fpsSelect" class="control">
                    <option value="8">8</option>
                    <option value="12">12</option>
                    <option value="15">15</option>
                    <option value="24">24</option>
                    <option value="30" selected data-i18n="fps.recommended">30 · 推荐</option>
                    <option value="60">60</option>
                  </select>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.scope">范围</span>
                  <select id="personModeSelect" class="control">
                    <option value="all" selected data-i18n="scope.all">全图</option>
                    <option value="person" data-i18n="scope.person">仅人物</option>
                  </select>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.segModel">分割模型</span>
                  <select id="segModelSelect" class="control" disabled>
                    <option value="mediapipe" selected data-i18n="seg.mpSelfie">MediaPipe Selfie</option>
                    <option value="mediapipe-landscape" data-i18n="seg.mpLandscape">MediaPipe Landscape</option>
                    <option value="transformers" data-i18n="seg.tfOnnx">Transformers ONNX Selfie</option>
                  </select>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.background">背景</span>
                  <select id="personBgSelect" class="control" disabled>
                    <option value="original" selected data-i18n="bg.original">保留原图</option>
                    <option value="black" data-i18n="bg.black">涂黑</option>
                  </select>
                </label>
              </div>
            </section>

            <section>
              <p class="section-title" data-i18n="section.style">深度图样式</p>
              <div class="settings-card grid gap-2.5 sm:gap-3">
                <label>
                  <span class="field-label" data-i18n="field.style">样式</span>
                  <select id="styleSelect" class="control">
                    <option value="gray" selected data-i18n="style.gray">灰度</option>
                    <option value="turbo" data-i18n="style.turbo">热力</option>
                  </select>
                </label>
                <label>
                  <span class="field-label" data-i18n="field.direction">深度方向</span>
                  <select id="directionSelect" class="control">
                    <option value="near-white" selected data-i18n="dir.nearWhite">近处 = 白色</option>
                    <option value="far-white" data-i18n="dir.farWhite">远处 = 白色</option>
                  </select>
                </label>
                <label>
                  <span class="field-label">
                    <span data-i18n="field.smooth">时间平滑</span>
                    <output id="smoothValue" class="font-mono text-accent">0.35</output>
                  </span>
                  <input id="smoothRange" class="range-input" type="range" min="0" max="0.85" step="0.05" value="0.35">
                </label>
              </div>
            </section>
          </div>

          <div class="settings-actions grid grid-cols-[1.4fr_1fr] gap-2">
            <button id="startButton" class="btn btn-start" type="button" disabled>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              <span data-i18n="btn.start">开始</span>
            </button>
            <button id="cancelButton" class="btn btn-danger" type="button" disabled data-i18n="btn.cancel">取消</button>
          </div>
        </aside>
      </section>

      <footer class="app-footer fade-in-delay-2">
        <div class="glass px-3 py-2 sm:px-4 sm:py-3">
          <div class="mb-1.5 flex items-center justify-between gap-3 sm:mb-2">
            <span id="progressTitle" class="font-display text-xs font-semibold text-ink sm:text-sm" data-i18n="footer.waiting">等待中</span>
            <strong id="progressText" class="font-mono text-sm text-accent sm:text-base">0%</strong>
          </div>
          <div id="progressTrack" class="progress-track mb-1.5 sm:mb-2"><div id="progressBar"></div></div>
          <p id="statusLine" class="text-xs leading-relaxed text-muted sm:text-sm" data-i18n="footer.idleHint">
            请选择视频。首次运行会下载 AI 模型，之后会缓存到浏览器中。
          </p>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-black/5 pt-2 text-[0.68rem] text-muted sm:mt-3 sm:pt-3 sm:text-xs">
            <span id="gpuBadge" class="font-mono text-ok" data-i18n="gpu.checking">硬件加速：检测中...</span>
            <span data-i18n="footer.localNote">视频深度图提取 —— 所有处理都在当前浏览器内完成</span>
          </div>
        </div>
      </footer>
      </div>
    </main>
  </div>
`;

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.innerHTML = template;
}

// 片2：核心推理链路（上传 → 解码 → 深度推理 → 预览/进度/取消）
initApp();
