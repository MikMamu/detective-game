// 最小化 DeepSeek API 客户端（OpenAI 兼容协议，Node 18+ 全局 fetch，零依赖）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const CHAT_MODEL = process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat';
export const REASONER_MODEL = process.env.DEEPSEEK_REASONER_MODEL || 'deepseek-reasoner';

/**
 * 读取 API Key，优先级：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. config.local.json（{ "deepseek_api_key": "sk-..." }，node src/cli.js setkey 写入）
 *   3. .env 文件中的 DEEPSEEK_API_KEY=...
 */
export function apiKey() {
  const env = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (env) return env;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    const k = (cfg.deepseek_api_key || '').trim();
    if (k) return k;
  } catch {
    /* 无配置文件 */
  }
  try {
    const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = envFile.match(/^DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 无 .env 文件 */
  }
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用 chat/completions，带重试（429 / 5xx 指数退避）。
 * - model: 模型名
 * - messages: 消息数组
 * - jsonMode: 是否要求 JSON 输出（deepseek-reasoner 不支持，会自动跳过）
 * - temperature: 采样温度（reasoner 不支持，会自动跳过）
 */
export async function chatCompletion({
  model,
  messages,
  maxTokens = 2000,
  temperature,
  jsonMode = false,
  retries = 2,
} = {}) {
  const key = apiKey();
  if (!key) throw new Error('DEEPSEEK_API_KEY 未配置（set $env:DEEPSEEK_API_KEY="sk-..."）');

  const body = { model, messages, max_tokens: maxTokens, stream: false };
  const isReasoner = model === REASONER_MODEL;
  if (temperature !== undefined && !isReasoner) body.temperature = temperature;
  if (jsonMode && !isReasoner) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        if (res.status === 429 || res.status >= 500) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return content;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * 从模型输出中稳健提取 JSON 对象。
 * 兼容：markdown 代码块包裹、前后缀文字、reasoner 的思考残留。
 */
export function extractJson(text) {
  const t = String(text || '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`输出中未找到 JSON 对象：${t.slice(0, 200)}`);
  }
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message} | 原文片段：${t.slice(first, Math.min(first + 300, last))}`);
  }
}
