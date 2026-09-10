// 开发自检：检查前端脚本语法，以及 app.js 引用的元素 ID 是否都能找到来源
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsPath = path.join(ROOT, 'web', 'app.js');
const htmlPath = path.join(ROOT, 'web', 'index.html');

const js = fs.readFileSync(jsPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

let failed = false;

// 1. 语法检查
try {
  execFileSync(process.execPath, ['--check', jsPath], { stdio: 'pipe' });
  console.log('✓ web/app.js 语法检查通过');
} catch (e) {
  console.error('✗ web/app.js 语法错误：');
  console.error(String(e.stderr || e.message));
  failed = true;
}

// 2. 元素 ID 交叉检查（弹窗内容由 app.js 自己用 innerHTML 创建，也算有来源）
const staticIds = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
const dynamicIds = new Set([
  ...[...js.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = staticIds.filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
console.log(
  `元素 ID：静态引用 ${staticIds.length} 个，HTML ${htmlIds.size} 个，脚本内动态创建 ${dynamicIds.size} 个 → ${
    missing.length ? '✗ 无来源：' + missing.join(', ') : '✓ 全部有来源'
  }`,
);
if (missing.length) failed = true;

// 3. 服务端模块可加载性
for (const mod of ['server.js', 'incident.js', 'feynman.js', 'pack.js', 'prompt-factory.js']) {
  try {
    await import(pathToFileURL(path.join(ROOT, 'src', mod)).href);
    console.log(`✓ src/${mod} 可正常加载`);
  } catch (e) {
    console.error(`✗ src/${mod} 加载失败：${e.message}`);
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
