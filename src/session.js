// 会话状态：每个 NPC 一份独立状态（历史/摘要/谎言计数/注入记忆），互不可见

import crypto from 'node:crypto';

export function createSession(caseData, sessionId = null) {
  const npc_states = {};
  for (const n of caseData.npcs || []) {
    npc_states[n.npc_id] = {
      history: [],          // 最近对话原文（窗口内）
      summary: '',          // TODO: 超窗内容由 LLM 滚动压缩进摘要
      broken_lies: [],      // 已被戳破的 lie_id
      lie_counters: {},     // lie_id → 玩家累计追问次数
      injected: [],         // GM 门控注入的新记忆片段
      first_talked: false,  // 是否被首次询问过（剧情事件用）
    };
  }
  // 开局默认：侦探已搜过现场，除剧情发放的物证外全部在手
  // （正式版可改为：物证必须通过对话/reveal 解锁）
  const inventory = (caseData.evidence || [])
    .filter((e) => !(caseData.events || []).some((ev) => (ev.unlocks || []).includes(e.evidence_id)))
    .map((e) => e.evidence_id);
  return {
    session_id: sessionId || `s_${crypto.randomBytes(4).toString('hex')}`,
    case_id: caseData.case_id,
    created_at: Date.now(),
    npc_states,
    player: { inventory, presented: [], accused: [] },
    unlocked_evidence: [...inventory],
    events_done: [],
    claims: [],
    hints: [],
    narrators: [],
  };
}

export function npcState(session, npcId) {
  return session.npc_states[npcId];
}

export function npcById(caseData, npcId) {
  return (caseData.npcs || []).find((n) => n.npc_id === npcId);
}

export function evidenceById(caseData, evidenceId) {
  return (caseData.evidence || []).find((e) => e.evidence_id === evidenceId);
}

export function matchNpc(caseData, query) {
  const q = String(query || '').trim();
  const npcs = caseData.npcs || [];
  return (
    npcs.find((n) => n.npc_id === q) ||
    npcs.find((n) => n.name === q) ||
    npcs.find((n) => q.length >= 1 && n.name.startsWith(q.charAt(0))) ||
    null
  );
}

export function allBrokenLies(session) {
  const out = [];
  for (const st of Object.values(session.npc_states)) out.push(...(st.broken_lies || []));
  return out;
}
