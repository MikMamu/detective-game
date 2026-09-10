// NPC 独立会话：
//   - LLM 模式：每个 NPC 一份独立系统提示词（前缀稳定吃缓存）+ 独立历史窗口
//   - 离线模式：规则驱动的脚本应答（谎言 → 记忆检索），用于无 Key 演示
//   - GM 校验：审查 NPC 拟回复是否触碰禁区（防泄露兜底）

import { npcById, npcState, evidenceById } from './session.js';
import { chatCompletion, extractJson, CHAT_MODEL } from './deepseek.js';
import { buildNpcSystemPrompt, buildCheckMessages } from './prompt-factory.js';
import { bigramSimilarity } from './claims.js';
import { matchTrigger } from './gate.js';

const HISTORY_WINDOW = 10;

export function describeInput(caseData, input) {
  if (input.action === 'present') {
    const ev = evidenceById(caseData, input.evidence_id);
    return `玩家把「${ev ? ev.name : input.evidence_id}」摆在你面前。`;
  }
  if (input.action === 'accuse') return '玩家当众指控你说谎。';
  return `玩家问你："${input.text}"`;
}

export function trimHistory(st) {
  if (st.history.length > HISTORY_WINDOW) st.history = st.history.slice(-HISTORY_WINDOW);
  // TODO: 超出窗口的部分由 LLM 压缩进 st.summary（长期一致性），再拼回动态块
}

export async function generateNpcReply(caseData, session, input, gate, extraGuardrails = []) {
  const npc = npcById(caseData, input.npc_id);
  const st = npcState(session, input.npc_id);
  const messages = [
    { role: 'system', content: buildNpcSystemPrompt(caseData, session, npc, st, gate, extraGuardrails) },
    ...(st.history || []).slice(-HISTORY_WINDOW),
    { role: 'user', content: describeInput(caseData, input) },
  ];
  const content = await chatCompletion({
    model: CHAT_MODEL,
    messages,
    maxTokens: 250,
    temperature: 0.9,
  });
  return String(content || '').trim();
}

export async function gmCheckAndExtract(caseData, session, npcId, draft, guardrails) {
  const npc = npcById(caseData, npcId);
  try {
    const content = await chatCompletion({
      model: CHAT_MODEL,
      messages: buildCheckMessages(caseData, session, npc, draft, guardrails),
      jsonMode: true,
      maxTokens: 1000,
    });
    return extractJson(content);
  } catch (e) {
    return { pass: true, claims: [{ topic: null, text: draft, truth_label: 'unknown' }], error: e.message };
  }
}

// ---------------- 离线脚本应答（无 Key 演示模式） ----------------

function trimAfterBreak(s) {
  const t = String(s || '');
  const parts = t.split(/(?<=[。！？])/);
  return parts.slice(0, 2).join('').trim();
}

/**
 * 返回 { text, meta: { kind: 'broken'|'lie'|'present'|'accuse'|'memory'|'default', lie_id } }
 */
export function offlineNpcReply(caseData, session, input, gate) {
  const npc = npcById(caseData, input.npc_id);
  const st = npcState(session, input.npc_id);
  const text = input.text || '';
  const broken = st.broken_lies || [];

  // 1) 已破的谎言被追问 → 坦白（含本轮刚击破的情况）
  const brokenLie = npc.lie_rules.find(
    (l) => broken.includes(l.lie_id) &&
      (input.action !== 'talk' || (l.trigger_patterns || []).some((p) => matchTrigger(text, p)) || bigramSimilarity(text, l.topic) > 0.2),
  );
  if (brokenLie) {
    return { text: `${npc.name}（神色一变，支吾起来）${trimAfterBreak(brokenLie.after_break)}`, meta: { kind: 'broken', lie_id: brokenLie.lie_id } };
  }
  // 2) 触发中的谎言 → 按谎言文本回答
  const activeLie = npc.lie_rules.find(
    (l) => !broken.includes(l.lie_id) && (l.trigger_patterns || []).some((p) => matchTrigger(text, p)),
  );
  if (activeLie) {
    return { text: activeLie.lie_text, meta: { kind: 'lie', lie_id: activeLie.lie_id } };
  }
  // 3) 出示物证
  if (input.action === 'present') {
    const ev = evidenceById(caseData, input.evidence_id);
    const isHit = ev && ev.points_to === npc.npc_id;
    const newBreak = npc.lie_rules.find((l) => (gate.break_lies || []).includes(l.lie_id));
    if (newBreak) return { text: `${npc.name}（脸色变了）${trimAfterBreak(newBreak.after_break)}`, meta: { kind: 'broken', lie_id: newBreak.lie_id } };
    return {
      text: isHit
        ? `${npc.name}盯着「${ev.name}」，脸色变了变："这……这东西怎么会……跟我没关系！"`
        : `${npc.name}看了一眼："「${ev.name}」？你从哪里找到的？"`,
      meta: { kind: 'present' },
    };
  }
  // 4) 指控
  if (input.action === 'accuse') {
    const newBreak = npc.lie_rules.find((l) => (gate.break_lies || []).includes(l.lie_id));
    if (newBreak) return { text: `${npc.name}（额上冒汗）${trimAfterBreak(newBreak.after_break)}`, meta: { kind: 'broken', lie_id: newBreak.lie_id } };
    return { text: `${npc.name}跳了起来："你血口喷人！"`, meta: { kind: 'accuse' } };
  }
  // 5) 记忆关键词检索（粗排）
  const hits = (npc.memory || []).filter((m) => bigramSimilarity(text, m) > 0.15);
  if (hits.length) return { text: hits.slice(0, 2).join(' '), meta: { kind: 'memory' } };
  return { text: `${npc.name}想了想："这个……我一时想不起来，你问点别的吧。"`, meta: { kind: 'default' } };
}

export function offlineClaims(caseData, session, input, off) {
  if (off.meta && off.meta.lie_id) {
    const npc = npcById(caseData, input.npc_id);
    const lie = (npc.lie_rules || []).find((l) => l.lie_id === off.meta.lie_id);
    if (lie) {
      return [{ topic: lie.topic, text: off.text, truth_label: off.meta.kind === 'broken' ? 'true' : 'lie' }];
    }
  }
  return [{ topic: null, text: off.text, truth_label: 'unknown' }];
}
