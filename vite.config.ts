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

export default defineConfig({
  plugins: [tailwindcss(), licenseBannerPlugin()],
  build: {
    // 源文件中确实存在的 legal 注释（如 onnxruntime-web 的 /*! ... */）同样保留
    rollupOptions: {
      output: {
        legalComments: 'inline',
      },
    },
  },
});
