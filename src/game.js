// 每轮管线编排：门控 → NPC 生成 → GM 校验（禁区拦截重试） → 证词抽取 → 矛盾检测 → 剧情事件

import { apiKey } from './deepseek.js';
import { npcById, npcState, evidenceById } from './session.js';
import { deterministicGate, llmGate } from './gate.js';
import {
  generateNpcReply,
  offlineNpcReply,
  offlineClaims,
  gmCheckAndExtract,
  describeInput,
  trimHistory,
} from './npc.js';
import { addClaims, detectContradictions } from './claims.js';

export function checkEvents(caseData, session) {
  const narrators = [];
  for (const ev of caseData.events || []) {
    if (session.events_done.includes(ev.step)) continue;
    if (ev.when && ev.when.includes('3个NPC')) {
      const talked = Object.values(session.npc_states).filter((st) => st.first_talked).length;
      if (talked < 3) continue;
    }
    session.events_done.push(ev.step);
    for (const eid of ev.unlocks || []) {
      if (!session.unlocked_evidence.includes(eid)) session.unlocked_evidence.push(eid);
      if (!session.player.inventory.includes(eid)) session.player.inventory.push(eid);
    }
    if (ev.narrator) narrators.push(ev.narrator);
  }
  return narrators;
}

export function sessionSummary(session) {
  return {
    unlocked: session.unlocked_evidence,
    broken_lies: Object.values(session.npc_states).flatMap((st) => st.broken_lies || []),
  };
}

/**
 * 处理玩家一轮行动。
 * @param {object} input { action: 'talk'|'present'|'accuse', npc_id, text?, evidence_id? }
 * @returns { reply, lies_broken, evidence_unlocked, narrator, hints, checkErrors }
 */
export async function playerTurn(caseData, session, input, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const npc = npcById(caseData, input.npc_id);
  if (!npc) throw new Error(`NPC 不存在：${input.npc_id}`);
  const st = npcState(session, input.npc_id);

  if (input.action === 'present') {
    const ev = evidenceById(caseData, input.evidence_id);
    if (!ev) return { error: `物证不存在：${input.evidence_id}` };
    if (!session.player.inventory.includes(ev.evidence_id) && !session.unlocked_evidence.includes(ev.evidence_id)) {
      return { error: `你手上没有「${ev.name}」，无法出示。`, npc_id: input.npc_id };
    }
  }

  // ① 门控（规则引擎必定执行；LLM 语义门控叠加其上）
  const gate = deterministicGate(caseData, session, input);
  if (useLLM && input.action === 'talk') {
    try {
      const lg = await llmGate(caseData, session, input);
      if (!lg.error) {
        for (const m of lg.inject_memory || []) {
          if (!st.injected.includes(m)) {
            st.injected.push(m);
            gate.inject_memory.push(m);
          }
        }
        for (const eid of lg.unlock_evidence || []) {
          if (!gate.unlock_evidence.includes(eid)) gate.unlock_evidence.push(eid);
        }
        gate.reply_guardrails = lg.reply_guardrails || [];
        gate.narrator_event = lg.narrator_event || null;
        gate.reason = lg.reason || gate.reason;
      }
    } catch (_) {
      /* 保持确定性门控结果 */
    }
  }

  for (const eid of gate.unlock_evidence) {
    if (!session.unlocked_evidence.includes(eid)) session.unlocked_evidence.push(eid);
    if (!session.player.inventory.includes(eid)) session.player.inventory.push(eid);
  }

  // ② NPC 生成回复（独立会话；AI 调用失败自动降级为脚本台词）
  let reply;
  let claims = [];
  const checkErrors = [];
  if (useLLM) {
    try {
      reply = await generateNpcReply(caseData, session, input, gate);
      const check = await gmCheckAndExtract(caseData, session, input.npc_id, reply, gate.reply_guardrails);
      if (check && check.pass === false && check.fail_reason) {
        checkErrors.push(check.fail_reason);
        reply = await generateNpcReply(caseData, session, input, gate, [check.fail_reason]);
      }
      claims = (check && check.claims) || [{ topic: null, text: reply, truth_label: 'unknown' }];
    } catch (e) {
      const off = offlineNpcReply(caseData, session, input, gate);
      reply = off.text;
      claims = offlineClaims(caseData, session, input, off);
      checkErrors.push(`AI 调用失败，本轮已降级为脚本台词：${e.message}`);
    }
  } else {
    const off = offlineNpcReply(caseData, session, input, gate);
    reply = off.text;
    claims = offlineClaims(caseData, session, input, off);
  }

  // ③ 记录：历史、证词、矛盾、剧情事件
  st.history.push({ role: 'user', content: describeInput(caseData, input) });
  st.history.push({ role: 'assistant', content: reply });
  trimHistory(st);

  addClaims(session, input.npc_id, claims);
  const hints = detectContradictions(caseData, session);
  const eventNarrators = checkEvents(caseData, session);
  const narrator = gate.narrator_event || (eventNarrators.length ? eventNarrators.join(' ') : null);
  if (narrator) session.narrators.push(narrator);

  return {
    npc_id: input.npc_id,
    npc_name: npc.name,
    reply,
    lies_broken: gate.break_lies,
    evidence_unlocked: gate.unlock_evidence,
    narrator,
    hints,
    checkErrors,
  };
}
