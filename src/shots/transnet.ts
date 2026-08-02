/**
 * TransNet V2 转场检测模型运行器（票 #24 验证结论落地）。
 * 模型：public/models/transnetv2-webgpu.onnx（浏览器兼容补丁版，MIT，见 /models/TRANSNETV2-SOURCE.md）
 * 输入 [1,100,27,48,3] float32 0-255 NHWC（不归一化）；输出头 534=逐帧转场概率（主用）、535=备用。
 *
 * ORT 引入方式说明：onnxruntime-web 的 wasm 胶水 .mjs 需运行时动态 import，
 * 不能走 vite 依赖打包（public 目录禁止动态 import、包名导入会被转成 hash 资源名破坏按名定位）。
 * 因此与验证票一致：dev 直接引 node_modules 静态路径；build 时 external 保留原路径，
 * 由 vite.config.ts 的 copyOrtPlugin 把对应文件复制到 dist 下同路径。
 */
import type * as OrtTypes from 'onnxruntime-web';
// @ts-expect-error 运行时静态路径（dev 由 node_modules 静态服务；build 时 external + copyOrtPlugin 复制到 dist 同路径）
import * as ortRuntime from '/node_modules/onnxruntime-web/dist/ort.all.mjs';

const ort = ortRuntime as typeof OrtTypes;

const ORT_BASE = '/node_modules/onnxruntime-web/dist/';

const MODEL_URL = '/models/transnetv2-webgpu.onnx';

ort.env.wasm.wasmPaths = ORT_BASE;
ort.env.logLevel = 'warning';

export type TransnetBackend = 'webgpu' | 'wasm';
export let transnetBackend: TransnetBackend | null = null;

let session: OrtTypes.InferenceSession | null = null;
let loading: Promise<OrtTypes.InferenceSession> | null = null;

/** ?ep=wasm 可强制后端（e2e/调试用）；默认 webgpu 优先、失败回退 wasm */
function forcedBackend(): TransnetBackend | null {
  const p = new URLSearchParams(location.search).get('ep');
  return p === 'wasm' || p === 'webgpu' ? p : null;
}

/** 加载模型（页内单例复用；重复调用直接返回已加载后端） */
export async function loadTransnet(): Promise<TransnetBackend> {
  if (session && transnetBackend) return transnetBackend;
  if (loading) {
    await loading;
    return transnetBackend as TransnetBackend;
  }
  loading = (async () => {
    const forced = forcedBackend();
    const candidates: TransnetBackend[] = forced ? [forced] : ['webgpu', 'wasm'];
    let lastErr: unknown;
    for (const ep of candidates) {
      try {
        session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: [ep],
          // WebGPU Conv3D 不支持内嵌 SAME padding（模型已把 pads 外置为显式 Pad 节点）；
          // 必须关掉图优化，防止 ORT pad-fusion 把 Pad 重新折叠回 Conv（票 #24 实测结论）
          ...(ep === 'webgpu' ? { graphOptimizationLevel: 'disabled' } : {}),
        });
        transnetBackend = ep;
        return session;
      } catch (e) {
        console.warn(`TransNet 后端 ${ep} 加载失败`, e);
        lastErr = e;
      }
    }
    throw lastErr;
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
  return transnetBackend as TransnetBackend;
}

export type WindowResult = {
  /** 输出头 534：窗口 100 帧的逐帧转场概率 */
  probs: Float32Array;
  /** 输出头 535：辅助头（v1 不使用） */
  secondary: Float32Array;
  ms: number;
};

/** 单窗口推理：data 为 100×27×48×3 的 float32（0-255） */
export async function inferWindow(data: Float32Array): Promise<WindowResult> {
  if (!session) throw new Error('TransNet 模型未加载');
  const tensor = new ort.Tensor('float32', data, [1, 100, 27, 48, 3]);
  const t0 = performance.now();
  const out = await session.run({ input: tensor });
  const ms = performance.now() - t0;
  return {
    probs: out['534'].data as Float32Array,
    secondary: out['535'].data as Float32Array,
    ms,
  };
}
