// dsh-anywhere 网页客户端打包：client/index.jsx → client/client.js
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const sourceDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDir, '..');

// esbuild 解析顺序（不写死任何机器路径）：
//   1) 环境变量 ESBUILD_PATH
//   2) 常规解析（本包 node_modules / 上层 node_modules）
//   3) 从当前工作目录向上解析
function loadEsbuild() {
  const tried = [];
  const attempts = [];
  if (process.env.ESBUILD_PATH) attempts.push(process.env.ESBUILD_PATH);
  attempts.push('esbuild');
  for (const spec of attempts) {
    tried.push(spec);
    try { return require(spec); } catch {}
    try { return require(require.resolve(spec, { paths: [packageRoot, process.cwd()] })); } catch {}
  }
  throw new Error(
    `未找到 esbuild（尝试过：${tried.join(', ')}）。请在插件目录执行 \`npm i -D esbuild\`，` +
    `或用环境变量 ESBUILD_PATH 指向 esbuild 的入口文件。`,
  );
}

let esbuild;
try {
  esbuild = loadEsbuild();
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
const { build } = esbuild;
const outputPath = resolve(packageRoot, 'client/client.js');
const loaderId = process.env.DSH_ANYWHERE_CLIENT_ID ?? 'dsh-anywhere';

const result = await build({
  entryPoints: [resolve(sourceDir, 'index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});

const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // The DSH client module system provides react as a module, never as a
    // global. esbuild keeps react external (see the build config above) and
    // its classic JSX transform emits bare React.createElement calls for the
    // mobile components (which import only named hooks, not React itself), so
    // the bundle must bind React itself - otherwise every mobile component
    // crashes at render time with "ReferenceError: React is not defined".
    var React = require("react");
${bundled}
    return module.exports;
  }
});
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
