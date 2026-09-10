// 主机城 · 计算机知识推理游戏 —— CLI
//   serve  启动网页版（学生用）
//   pack   生成可打印的桌游包（老师用：角色卡/线索卡/DM手册）
//   judge  单独测试费曼判官（老师备课用）
//   setkey 保存 DeepSeek API Key

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey } from './deepseek.js';
import { startServer } from './server.js';
import { buildPackHtml } from './pack.js';
import { judgeExplanation } from './feynman.js';
import { judgeReport } from './report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = path.join(ROOT, 'cases');

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : undefined;
}

function loadCase(p) {
  const file = path.resolve(p || path.join(CASES_DIR, 'zero-one.json'));
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function usage() {
  console.log(
    [
      '主机城 · 计算机知识推理游戏',
      '',
      '  node src/cli.js serve --port 3123                       启动网页版（学生打开浏览器玩）',
      '  node src/cli.js pack  --out pack-zero-one.html          生成可打印桌游包（老师用）',
      '  node src/cli.js judge --concept kc_cache                测试费曼判官（备课用，交互输入讲解）',
      '  node src/cli.js grade --file 学生报告.txt                可选：批改学生手写的《事故分析报告》',
      '  node src/cli.js setkey --key sk-...                     保存 DeepSeek API Key',
      '',
      '案件文件放在 cases/*.json（type: "incident"）；旧版谋杀推理模块保留但未接入教学版。',
    ].join('\n'),
  );
}

async function cmdServe() {
  const port = Number(flag('port') || process.env.PORT || 3123);
  await startServer(port);
}

function cmdPack() {
  const { file, data } = loadCase(flag('case'));
  const html = buildPackHtml(data);
  const out = path.resolve(flag('out') || `pack-${data.case_id}.html`);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`✓ 桌游包已生成：${out}`);
  console.log('  用浏览器打开后按 Ctrl+P 打印（建议 A4、双面、每页 2 张卡）。');
  console.log(`  内含：${data.cast.length} 张角色卡、${(data.clues.public || []).length + (data.clues.private || []).length} 张线索卡、DM 手册、投票卡。`);
}

async function cmdJudge() {
  const { data } = loadCase(flag('case'));
  const conceptId = flag('concept');
  const card = data.cast.map((c) => c.knowledge_card).find((k) => k.concept_id === conceptId || k.concept === conceptId);
  if (!card) {
    console.log(`没找到这个知识点。可选：${data.cast.map((c) => `${c.knowledge_card.concept_id}（${c.knowledge_card.concept}）`).join('、')}`);
    return;
  }
  const text = flag('text');
  if (!text) {
    console.log('用法：node src/cli.js judge --concept kc_cache --text "你的讲解内容"');
    console.log(`知识点：${card.concept}`);
    return;
  }
  const r = await judgeExplanation(card, text, { useLLM: Boolean(apiKey()) });
  console.log(`知识点：${card.concept}`);
  console.log(`得分：${r.score}/3（${r.mode}）`);
  console.log(`已讲清：${r.covered.join('；') || '无'}`);
  console.log(`没讲到：${r.missed.join('；') || '无'}`);
  console.log(`类比点评：${r.analogy_comment}`);
  console.log(`反馈：${r.feedback}`);
  console.log(`追问：${r.followup_question}`);
  if (r.note) console.log(`[提示] ${r.note}`);
}

/** 可选：老师批改学生手写的《事故分析报告》（游戏内已改为时间线任务，此命令用于课外写作作业） */
async function cmdGrade() {
  const { data } = loadCase(flag('case'));
  const file = flag('file');
  const text = flag('text') || (file ? fs.readFileSync(path.resolve(file), 'utf8') : '');
  if (!text || text.trim().length < 40) {
    console.log('用法：node src/cli.js grade --file 学生报告.txt   （或 --text "报告内容"）');
    return;
  }
  const r = await judgeReport(data, text, { useLLM: Boolean(apiKey()) });
  console.log(`得分：${r.score}/100  ${r.passed ? '✅ 合格' : '⚠️ 未合格'}  （判分：${r.mode}）`);
  if (r.highlights?.length) console.log(`写得好：${r.highlights.join('；')}`);
  if (r.covered?.length) console.log(`写到了：${r.covered.join('；')}`);
  if (r.missed?.length) console.log(`漏掉了：${r.missed.join('；')}`);
  if (r.issues?.length) console.log(`待商榷：${r.issues.join('；')}`);
  if (r.best_fix_comment) console.log(`修复建议点评：${r.best_fix_comment}`);
  console.log(`总评：${r.feedback}`);
  if (r.note) console.log(`[提示] ${r.note}`);
}

function cmdSetKey() {  const key = flag('key') || args[1];
  if (!key || !String(key).trim().startsWith('sk-')) {
    console.log('用法：node src/cli.js setkey --key sk-你的key');
    console.log('获取地址：https://platform.deepseek.com → API Keys');
    return;
  }
  const file = path.join(ROOT, 'config.local.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 新建 */
  }
  cfg.deepseek_api_key = String(key).trim();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  console.log('✓ 已保存到 config.local.json（已被 .gitignore 忽略）');
  console.log('  重启服务后生效：node src/cli.js serve --port 3123');
}

const handlers = { serve: cmdServe, pack: cmdPack, judge: cmdJudge, grade: cmdGrade, setkey: cmdSetKey };

try {
  if (handlers[cmd]) {
    await handlers[cmd]();
  } else {
    usage();
  }
} catch (e) {
  console.error(`[出错] ${e.message}`);
  process.exitCode = 1;
}
