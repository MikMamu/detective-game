// GM 知识门控：
//   - 确定性规则引擎：谎言触发计数、击穿条件（追问次数/出示物证/组合/对质）、reveal 关键词、剧情事件
//   - LLM 语义门控（有 Key 时）：reveal 语义判断、防泄露清单、旁白
// 谎言击穿【只由规则引擎决定】，LLM 无权击穿——这是可玩性一致性的保证。

import { npcState, npcById, evidenceById } from './session.js';
import { chatCompletion, extractJson, CHAT_MODEL } from './deepseek.js';
import { buildGateMessages } from './prompt-factory.js';
import { bigramSimilarity } from './claims.js';

const STOPWORDS = new Set([
  '玩家', '你', '我', '他', '她', '它', '与', '或', '和', '的', '了', '是', '在', '有', '没有',
  '关于', '是否', '问', '请', '说', '告诉', '什么', '怎么', '为何', '为什么', '时候', '在哪', '哪里',
  '吗', '呢', '呀', '着', '被', '把', '就', '都', '也', '还', '这', '那', '中', '下', '上', '出', '过',
  '他们', '你们', '我们', '这个', '那个', '一个', '一下', '什么', '事情', '知道',
]);

export function stripPattern(p) {
  return String(p || '').replace(/[？?!.。！\s]+$/g, '');
}

/**
 * 谎言触发匹配：先精确包含，再 2-gram 相似度兜底（≥0.6）。
 * 保持确定性（无 LLM 参与），但能容忍玩家措辞变化。
 */
export function matchTrigger(text, pattern) {
  const t = String(text || '');
  const p = stripPattern(pattern);
  if (!p) return false;
  if (t.includes(p)) return true;
  if (p.length >= 4) return bigramSimilarity(t, p) >= 0.6;
  return false;
}

// 组合条件：requires 中的每一条都要满足（物证出示 / 某 NPC 证词已解锁）
export function comboReady(caseData, session, bc) {
  const reqs = bc.requires || [];
  for (const req of reqs) {
    const evIds = req.match(/e_\d+/g) || [];
    let part;
    if (evIds.length) {
      part = evIds.every((id) => (session.player.presented || []).includes(id));
    } else {
      const mentioned = (caseData.npcs || []).filter((n) => req.includes(n.name));
      part = mentioned.length > 0 && mentioned.every((n) => (session.npc_states[n.npc_id].broken_lies || []).length > 0);
    }
    if (!part) return false;
  }
  return true;
}

// 对质条件：claim_source 里提到的 NPC 的谎言已被戳破（其证词才有效力）
export function claimSourceReady(caseData, session, claimSource) {
  const mentioned = (caseData.npcs || []).filter((n) => claimSource.includes(n.name));
  if (mentioned.length) {
    return mentioned.every((n) => (session.npc_states[n.npc_id].broken_lies || []).length > 0);
  }
  return Object.values(session.npc_states).some((st) => (st.broken_lies || []).length > 0);
}

export function deterministicGate(caseData, session, input) {
  const out = {
    route: input.npc_id || null,
    inject_memory: [],
    break_lies: [],
    unlock_evidence: [],
    reply_guardrails: [],
    narrator_event: null,
    reason: '',
  };
  if (!input.npc_id) return out;
  const npc = npcById(caseData, input.npc_id);
  const st = npcState(session, input.npc_id);
  if (!npc || !st) return out;

  const doBreak = (lie) => {
    st.broken_lies.push(lie.lie_id);
    out.break_lies.push(lie.lie_id);
  };
  const tryBreak = (lie) => {
    if ((st.broken_lies || []).includes(lie.lie_id)) return;
    for (const bc of lie.break_conditions || []) {
      if (bc.type === '追问次数' && (st.lie_counters[lie.lie_id] || 0) >= bc.count) return doBreak(lie);
      if (bc.type === '组合' && comboReady(caseData, session, bc)) return doBreak(lie);
      if (bc.type === '出示物证' && (session.player.presented || []).includes(bc.evidence_id)) return doBreak(lie);
      if (bc.type === '对质' && claimSourceReady(caseData, session, bc.claim_source || '')) return doBreak(lie);
    }
  };

  if (input.action === 'present') {
    const ev = evidenceById(caseData, input.evidence_id);
    if (!ev) {
      out.reason = `物证不存在: ${input.evidence_id}`;
      return out;
    }
    if (!session.player.presented.includes(ev.evidence_id)) session.player.presented.push(ev.evidence_id);
    if (!session.unlocked_evidence.includes(ev.evidence_id)) session.unlocked_evidence.push(ev.evidence_id);
    for (const lie of npc.lie_rules || []) tryBreak(lie);
    out.reason = `出示 ${ev.name}`;
    return out;
  }

  if (input.action === 'accuse') {
    if (!session.player.accused.includes(input.npc_id)) session.player.accused.push(input.npc_id);
    for (const lie of npc.lie_rules || []) tryBreak(lie);
    out.reason = '当众指控';
    return out;
  }

  // talk：谎言触发计数 + 击穿评估 + 确定性 reveal
  const text = input.text || '';
  for (const lie of npc.lie_rules || []) {
    if ((st.broken_lies || []).includes(lie.lie_id)) continue;
    const hit = (lie.trigger_patterns || []).some((p) => matchTrigger(text, p));
    if (!hit) continue;
    st.lie_counters[lie.lie_id] = (st.lie_counters[lie.lie_id] || 0) + 1;
    out.reason = `命中谎言话题：${lie.topic}（第${st.lie_counters[lie.lie_id]}次追问）`;
    tryBreak(lie);
  }
  for (const r of npc.reveals || []) {
    const kws = triggerKeywords(r.trigger);
    if (kws.some((kw) => text.includes(kw))) {
      if (!st.injected.includes(r.inject)) {
        st.injected.push(r.inject);
        out.inject_memory.push(r.inject);
      }
    }
  }
  if (!st.first_talked) st.first_talked = true;
  return out;
}

function triggerKeywords(trigger) {
  const t = String(trigger || '');
  const out = new Set();
  for (let i = 0; i + 2 <= t.length; i++) {
    const chunk = t.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(chunk) && !STOPWORDS.has(chunk)) out.add(chunk);
  }
  return [...out];
}

export async function llmGate(caseData, session, input) {
  try {
    const content = await chatCompletion({
      model: CHAT_MODEL,
      messages: buildGateMessages(caseData, session, input),
      jsonMode: true,
      maxTokens: 800,
    });
    return extractJson(content);
  } catch (e) {
    return { error: e.message };
  }
}
