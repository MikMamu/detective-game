// 证词（claim）日志与矛盾检测：纯规则引擎，零 LLM 成本

import { npcById } from './session.js';

let claimSeq = 0;

export function addClaims(session, npcId, claims) {
  for (const c of claims || []) {
    session.claims.push({
      claim_id: `cl_${++claimSeq}`,
      npc_id: npcId,
      topic: c.topic || null,
      text: c.text || '',
      truth_label: c.truth_label || 'unknown',
      ts: Date.now(),
    });
  }
}

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function bigramSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * 矛盾检测：
 *  1. 同一 NPC 同一话题，先后证词相似度低 → 该 NPC 自相矛盾；
 *  2. 不同 NPC 同一话题，说法互相冲突 → 二人矛盾（可触发对质）。
 * 返回本轮新产生的玩家提示。
 */
export function detectContradictions(caseData, session) {
  const hints = [];
  const seen = new Set(session.hints || []);
  const claims = session.claims.filter((c) => c.topic);

  const byNpcTopic = new Map();
  for (const c of claims) {
    const key = `${c.npc_id}|${c.topic}`;
    if (!byNpcTopic.has(key)) byNpcTopic.set(key, []);
    byNpcTopic.get(key).push(c);
  }
  for (const [key, list] of byNpcTopic) {
    if (list.length < 2) continue;
    const [npcId, topic] = key.split('|');
    for (let i = 1; i < list.length; i++) {
      for (let j = 0; j < i; j++) {
        if (bigramSimilarity(list[j].text, list[i].text) < 0.3) {
          const name = npcById(caseData, npcId)?.name || npcId;
          const hint = `你隐约觉得${name}关于「${topic}」的说法和之前对不上。`;
          if (!seen.has(hint)) { seen.add(hint); hints.push(hint); }
        }
      }
    }
  }

  const byTopic = new Map();
  for (const c of claims) {
    if (!byTopic.has(c.topic)) byTopic.set(c.topic, []);
    byTopic.get(c.topic).push(c);
  }
  for (const [topic, list] of byTopic) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].npc_id === list[j].npc_id) continue;
        if (bigramSimilarity(list[i].text, list[j].text) < 0.3) {
          const a = npcById(caseData, list[i].npc_id)?.name || list[i].npc_id;
          const b = npcById(caseData, list[j].npc_id)?.name || list[j].npc_id;
          const hint = `你注意到${a}和${b}对「${topic}」的说法互相矛盾。`;
          if (!seen.has(hint)) { seen.add(hint); hints.push(hint); }
        }
      }
    }
  }

  if (hints.length) session.hints.push(...hints);
  return hints;
}
