// 教学版游戏 HTTP 服务：静态页面 + REST API
// 安全原则：角色的秘密/谎言/真相只存在服务端；publicCase 与 stateView 是唯一出口。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiKey } from './deepseek.js';
import {
  castById,
  createIncidentSession,
  ask,
  present,
  explain,
  unlockClue,
  submitTimeline,
  vote,
  stateView,
  reviewPayload,
} from './incident.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const CASES_DIR = path.join(ROOT, 'cases');

const loadedCases = new Map(); // case_id → caseData（服务端私有）
const sessions = new Map();    // session_id → session

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function loadAllCases() {
  const files = await fs.readdir(CASES_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await fs.readFile(path.join(CASES_DIR, f), 'utf8'));
      if (data.type !== 'incident') continue; // 只加载教学案件
      loadedCases.set(data.case_id, data);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  if (!loadedCases.size) throw new Error('cases/ 下没有找到教学案件（type: "incident"）');
}

/** 对前端公开的案件信息：知识卡公开（等于桌游里发给学生的角色卡），秘密与真相绝不外泄 */
function publicCase(caseData) {
  return {
    case_id: caseData.case_id,
    title: caseData.title,
    subtitle: caseData.subtitle,
    theme: caseData.theme,
    opening: caseData.opening,
    player_role: caseData.player_role,
    incident: caseData.incident,
    rules: caseData.rules,
    has_api_key: Boolean(apiKey()),
    vote_options: (caseData.vote_options || []).map((id) => {
      const c = castById(caseData, id);
      return { id, name: c?.name || id, component: c?.component || '' };
    }),
    cast: (caseData.cast || []).map((c) => ({
      id: c.id,
      name: c.name,
      component: c.component,
      role: c.role,
      avatar_color: c.avatar_color || '#c9a45c',
      speech_style: c.speech_style,
      knowledge_card: {
        concept_id: c.knowledge_card.concept_id,
        concept: c.knowledge_card.concept,
        must_explain: (c.knowledge_card.must_explain || []).map((p) => p.point),
        analogy_hint: c.knowledge_card.analogy_hint,
        misconceptions: c.knowledge_card.misconceptions || [],
      },
    })),
    clues: {
      public: (caseData.clues?.public || []).map((c) => ({ clue_id: c.clue_id, title: c.title, from: c.from })),
      private: (caseData.clues?.private || []).map((c) => ({ clue_id: c.clue_id, title: c.title, cost: c.cost })),
    },
  };
}

async function handleApi(req, res, url, body) {
  const seg = url.pathname.split('/').filter(Boolean);

  // GET /api/cases
  if (req.method === 'GET' && seg.length === 2 && seg[1] === 'cases') {
    return json(res, 200, {
      cases: [...loadedCases.values()].map((c) => ({
        case_id: c.case_id,
        title: c.title,
        subtitle: c.subtitle,
        theme: c.theme,
        cast_count: (c.cast || []).length,
      })),
    });
  }

  // GET /api/cases/featured
  if (req.method === 'GET' && seg.length === 3 && seg[1] === 'cases' && seg[2] === 'featured') {
    const first = loadedCases.values().next().value;
    return json(res, 200, { case: publicCase(first) });
  }

  // GET /api/cases/:id
  if (req.method === 'GET' && seg.length === 3 && seg[1] === 'cases' && seg[2] !== 'featured') {
    const caseData = loadedCases.get(seg[2]);
    if (!caseData) return json(res, 404, { error: `案件不存在：${seg[2]}` });
    return json(res, 200, { case: publicCase(caseData) });
  }

  // POST /api/sessions
  if (req.method === 'POST' && seg.length === 2 && seg[1] === 'sessions') {
    const caseId = body.case_id || loadedCases.values().next().value.case_id;
    const caseData = loadedCases.get(caseId);
    if (!caseData) return json(res, 404, { error: `案件不存在：${caseId}` });
    const session = createIncidentSession(caseData, { roleId: body.role });
    sessions.set(session.session_id, session);
    return json(res, 200, {
      session_id: session.session_id,
      case: publicCase(caseData),
      state: stateView(caseData, session),
    });
  }

  // /api/sessions/:id/:action
  if (seg.length === 4 && seg[1] === 'sessions') {
    const session = sessions.get(seg[2]);
    if (!session) return json(res, 404, { error: '会话不存在（服务重启或太长时间未操作，请刷新页面重新开局）' });
    const caseData = loadedCases.get(session.case_id);
    const action = seg[3];
    const useLLM = Boolean(apiKey());

    if (req.method === 'GET' && action === 'state') return json(res, 200, stateView(caseData, session));
    if (req.method === 'GET' && action === 'review') {
      if (!session.finished) return json(res, 400, { error: '还没投票，不能复盘' });
      return json(res, 200, reviewPayload(caseData, session));
    }

    if (req.method === 'POST') {
      try {
        if (action === 'ask') {
          const r = await ask(caseData, session, { component_id: body.component_id, text: body.text }, { useLLM });
          return json(res, 200, { ...r, state: stateView(caseData, session) });
        }
        if (action === 'present') {
          const r = await present(caseData, session, { component_id: body.component_id, clue_id: body.clue_id }, { useLLM });
          return json(res, 200, { ...r, state: stateView(caseData, session) });
        }
        if (action === 'explain') {
          const r = await explain(caseData, session, { concept_id: body.concept_id, text: body.text }, { useLLM });
          return json(res, 200, { ...r, state: stateView(caseData, session) });
        }
        if (action === 'unlock') {
          const r = unlockClue(caseData, session, { clue_id: body.clue_id });
          return json(res, 200, { ...r, state: stateView(caseData, session) });
        }
        if (action === 'timeline') {
          const r = submitTimeline(caseData, session, { placements: body.placements });
          return json(res, 200, { ...r, state: stateView(caseData, session) });
        }
        if (action === 'vote') {
          const r = vote(caseData, session, { component_id: body.component_id });
          return json(res, 200, { ...r, review: reviewPayload(caseData, session), state: stateView(caseData, session) });
        }
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
  }

  return json(res, 404, { error: '接口不存在' });
}

async function handleStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  let filePath;
  try {
    filePath = path.join(WEB_DIR, decodeURIComponent(rel));
  } catch {
    filePath = null;
  }
  if (!filePath || !filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 开发期禁用缓存：避免浏览器继续执行旧版 app.js/style.css 导致页面空白
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
}

export async function startServer(port = 3123) {
  await loadAllCases();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        await handleApi(req, res, url, body);
      } else {
        await handleStatic(req, res, url);
      }
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  console.log('──────────────────────────────────────────');
  console.log('  🎓 主机城 · 计算机知识推理游戏已启动');
  console.log(`  请在浏览器打开：http://127.0.0.1:${port}`);
  console.log(`  模式：${apiKey() ? '在线（DeepSeek AI 判官 + 角色扮演）' : '离线（规则判分 + 脚本台词）'}`);
  console.log(`  已加载案件：${[...loadedCases.values()].map((c) => c.title).join('、')}`);
  console.log('──────────────────────────────────────────');
  return server;
}
