// 一键发布到 GitHub（不需要安装 git）
//   用法：node tools/publish.js --token ghp_xxx --repo detective-game [--private] [--dry-run]
//   也支持环境变量：$env:GITHUB_TOKEN = "ghp_xxx"
//
// 原理：调用 GitHub REST API 创建仓库并逐个上传文件（Contents API）。
// 安全：config.local.json / .env / .git / node_modules 永不上传。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : undefined;
}
const has = (name) => args.includes(`--${name}`);

const token = flag('token') || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const repoName = flag('repo') || 'detective-game';
const description =
  flag('description') || '主机城 ·《谁动了我的0和1？》—— 面向中职计算机专业的计算机知识推理游戏（费曼学习法 + 独立 AI 角色 + 时间线还原）';
const isPrivate = has('private');
const dryRun = has('dry-run');

// 永不上传的文件/目录
const ALWAYS_EXCLUDE = new Set(['.git', 'node_modules', 'config.local.json', '.env', 'pack-zero-one.html', '.DS_Store', 'Thumbs.db']);

function loadGitignore() {
  try {
    return fs
      .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function isIgnored(relPath, rules) {
  const base = path.basename(relPath);
  if (ALWAYS_EXCLUDE.has(base) || ALWAYS_EXCLUDE.has(relPath)) return true;
  for (const rule of rules) {
    if (rule.endsWith('/')) {
      if (relPath.startsWith(rule) || relPath.includes(`/${rule}`)) return true;
    } else if (rule.includes('*')) {
      const re = new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      if (re.test(base) || re.test(relPath)) return true;
    } else if (rule === base || rule === relPath) {
      return true;
    }
  }
  return false;
}

function collectFiles(dir = ROOT, rel = '', rules, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (isIgnored(relPath, rules)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, relPath, rules, out);
    else if (entry.isFile()) out.push({ relPath, abs, size: fs.statSync(abs).size });
  }
  return out;
}

async function gh(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'detective-game-publisher',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

/* ---------------- 主流程 ---------------- */

const rules = loadGitignore();
const files = collectFiles(ROOT, '', rules).sort((a, b) => a.relPath.localeCompare(b.relPath));

console.log('将上传以下文件：');
for (const f of files) console.log(`  · ${f.relPath}（${(f.size / 1024).toFixed(1)} KB）`);
console.log(`共 ${files.length} 个文件，${(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB`);

if (dryRun) {
  console.log('\n[--dry-run] 仅预览，未调用 GitHub API。');
  process.exit(0);
}

if (!token) {
  console.log('\n缺少 GitHub Token。请先创建（勾选 repo 权限）：');
  console.log('  https://github.com/settings/tokens/new?scopes=repo&description=detective-game-publish');
  console.log('然后运行：node tools/publish.js --token ghp_你的token --repo detective-game');
  process.exit(1);
}

const me = await gh('/user');
if (!me.ok) {
  console.error(`\n✗ Token 无效或权限不足（HTTP ${me.status}）：${me.data.message || ''}`);
  process.exit(1);
}
const owner = me.data.login;
console.log(`\n已登录：${owner}`);

// 1. 创建仓库（已存在则复用）
const created = await gh('/user/repos', {
  method: 'POST',
  body: JSON.stringify({ name: repoName, description, private: isPrivate, auto_init: false }),
});
if (created.ok) {
  console.log(`✓ 已创建仓库：${created.data.html_url}`);
} else if (created.status === 422) {
  console.log(`· 仓库 ${owner}/${repoName} 已存在，将更新其中文件`);
} else {
  console.error(`✗ 创建仓库失败（HTTP ${created.status}）：${created.data.message || JSON.stringify(created.data)}`);
  process.exit(1);
}

// 2. 逐个上传（已存在的文件先取 sha 再覆盖）
let ok = 0;
const failed = [];
for (const f of files) {
  const content = fs.readFileSync(f.abs).toString('base64');
  const apiPath = `/repos/${owner}/${repoName}/contents/${encodeURIComponent(f.relPath).replace(/%2F/g, '/')}`;
  let res = await gh(apiPath, {
    method: 'PUT',
    body: JSON.stringify({ message: `add ${f.relPath}`, content }),
  });
  if (!res.ok && res.status === 422) {
    const existing = await gh(apiPath);
    if (existing.ok && existing.data.sha) {
      res = await gh(apiPath, {
        method: 'PUT',
        body: JSON.stringify({ message: `update ${f.relPath}`, content, sha: existing.data.sha }),
      });
    }
  }
  if (res.ok) {
    ok++;
    console.log(`  ✓ ${f.relPath}`);
  } else {
    failed.push(f.relPath);
    console.log(`  ✗ ${f.relPath} — HTTP ${res.status} ${res.data.message || ''}`);
  }
}

console.log(`\n完成：${ok}/${files.length} 个文件已上传${failed.length ? `，失败：${failed.join(', ')}` : ''}`);
console.log(`仓库地址：https://github.com/${owner}/${repoName}`);
console.log(`\n在别的电脑上使用：`);
console.log(`  git clone https://github.com/${owner}/${repoName}.git`);
console.log(`  cd ${repoName}`);
console.log(`  node src/cli.js setkey --key sk-你的DeepSeekKey`);
console.log(`  node src/cli.js serve --port 3123`);
if (failed.length) process.exitCode = 1;
