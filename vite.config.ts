import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// 片6：产物保留 npm 运行时依赖的 license 文本。
// 依赖 dist 几乎不带 @license/! 注释（legalComments 无可保留对象），
// 改为构建时从各包 LICENSE 文件聚合，注入 banner 注释到 JS chunk 头部。
const LICENSED_PKGS = [
  '@huggingface/transformers',
  'onnxruntime-web',
  '@mediapipe/tasks-vision',
  'mp4-muxer',
  '@fontsource-variable/outfit',
  '@fontsource-variable/plus-jakarta-sans',
  '@fontsource-variable/jetbrains-mono',
];

function readPkgLicense(pkg: string): string {
  const dir = path.join(__dirname, 'node_modules', ...pkg.split('/'));
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    version?: string;
    license?: string;
  };
  const licFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE'].find((f) =>
    fs.existsSync(path.join(dir, f)),
  );
  const text = licFile
    ? fs.readFileSync(path.join(dir, licFile), 'utf8').trim()
    : `License: ${pj.license ?? 'unknown'}（包内无 LICENSE 文件）`;
  return `${pkg}@${pj.version ?? '?'}（${pj.license ?? 'unknown'}）\n${text}`;
}

function licenseBannerPlugin(): Plugin {
  return {
    name: 'inject-license-banner',
    apply: 'build',
    generateBundle(_, bundle) {
      const body = LICENSED_PKGS.map(readPkgLicense)
        .map((p) => ` * ${p.replace(/\n/g, '\n * ')}`)
        .join('\n *\n');
      const banner = `/*!\n * Bundled third-party license texts（构建时自动聚合，请勿删除）\n *\n${body}\n */\n`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.fileName.endsWith('.js')) {
          chunk.code = banner + chunk.code;
        }
      }
    },
  };
}

/** 镜头分析页的 ORT 直引配套：把 onnxruntime-web 运行时文件复制到 dist 同路径
 *  （transnet.ts 以 '/node_modules/onnxruntime-web/dist/...' 绝对路径引入并 external，
 *   运行时浏览器按同 URL 取文件；dev 下 node_modules 本就可静态服务） */
const ORT_RUNTIME_FILES = [
  'ort.all.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

function copyOrtPlugin(): Plugin {
  return {
    name: 'copy-ort-runtime',
    apply: 'build',
    writeBundle(options) {
      const srcDir = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
      const dstDir = path.join(
        options.dir ?? path.join(__dirname, 'dist'),
        'node_modules',
        'onnxruntime-web',
        'dist',
      );
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of ORT_RUNTIME_FILES) {
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), licenseBannerPlugin(), copyOrtPlugin()],
  build: {
    // 多页应用：深度工具主页 + 镜头分析页（互不引用，独立入口）
    rollupOptions: {
      input: {
        main: path.join(__dirname, 'index.html'),
        shots: path.join(__dirname, 'shots.html'),
      },
      // 镜头分析页的 ORT 运行时按绝对路径外置（由 copyOrtPlugin 复制到 dist 同路径）
      external: [/^\/node_modules\//],
      output: {
        legalComments: 'inline',
      },
    },
  },
});
