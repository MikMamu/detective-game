// 规则化结构校验：免费、确定性，拦截 schema 错误与引用悬空。
// 泄露/可解性等语义检查由 LLM 验收员负责。

export function validateStructure(caseData) {
  const errors = [];
  const npcs = caseData?.npcs || [];
  const evidence = caseData?.evidence || [];
  const ids = new Set(npcs.map((n) => n.npc_id));
  const evidenceIds = new Set(evidence.map((e) => e.evidence_id));

  if (!caseData) return ['剧本为空'];

  // 顶层字段
  for (const key of ['case_id', 'title', 'opening', 'truth', 'timeline', 'npcs', 'evidence', 'final_answer', 'scoring']) {
    if (caseData[key] === undefined) errors.push(`缺少字段 ${key}`);
  }
  const truth = caseData.truth || {};
  if (truth.killer && !ids.has(truth.killer)) errors.push(`truth.killer 引用了不存在的 NPC: ${truth.killer}`);

  // NPC 数量与结构
  if (npcs.length !== 5) errors.push(`NPC 数量应为5，实际 ${npcs.length}`);
  let liars = 0;
  for (const npc of npcs) {
    if (!npc.npc_id || !npc.name) errors.push('NPC 缺少 npc_id/name');
    if (!Array.isArray(npc.memory) || npc.memory.length < 6) errors.push(`${npc.name} 的 memory 少于6条`);
    const lies = npc.lie_rules || [];
    if (lies.length < 1 || lies.length > 2) errors.push(`${npc.name} 的 lie_rules 数量应为1-2，实际 ${lies.length}`);
    if (lies.length > 0) liars += 1;
    for (const lie of lies) {
      if (!lie.lie_id || !lie.lie_text || !lie.truth || !lie.after_break) {
        errors.push(`${npc.name} 的某条 lie_rule 缺少必要字段`);
      }
      for (const bc of lie.break_conditions || []) {
        if (!['追问次数', '出示物证', '组合', '对质'].includes(bc.type)) {
          errors.push(`${lie.lie_id} 的击穿条件类型非法: ${bc.type}`);
        }
        if (bc.evidence_id && !evidenceIds.has(bc.evidence_id)) {
          errors.push(`${lie.lie_id} 引用了不存在的物证: ${bc.evidence_id}`);
        }
      }
    }
  }

  // 物证数量与引用
  if (evidence.length < 6 || evidence.length > 10) errors.push(`物证数量应为6-10，实际 ${evidence.length}`);
  for (const e of evidence) {
    if (!e.evidence_id || !e.name || !e.desc) errors.push('物证缺少 evidence_id/name/desc');
    if (e.points_to) {
      // points_to 支持多目标："npc_a或npc_b" / 手法 / 动机 等标签
      const refs = String(e.points_to)
        .split(/[、,，或\/]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const ref of refs) {
        if (ref.startsWith('npc_') && !ids.has(ref)) {
          errors.push(`物证 ${e.evidence_id} 指向不存在的 NPC: ${ref}`);
        }
      }
    }
  }

  // 时间线引用
  for (const t of caseData.timeline || []) {
    for (const ref of t.known_to || []) {
      if (!ids.has(ref)) errors.push(`timeline 引用了不存在的 NPC: ${ref}`);
    }
  }

  // final_answer 与 scoring
  const fa = caseData.final_answer || {};
  if (fa.killer && !ids.has(fa.killer)) errors.push(`final_answer.killer 引用了不存在的 NPC`);
  for (const id of fa.key_evidence || []) {
    if (!evidenceIds.has(id)) errors.push(`final_answer.key_evidence 引用了不存在的物证: ${id}`);
  }
  const scoring = caseData.scoring || {};
  const total = (scoring.killer || 0) + (scoring.motive || 0) + (scoring.method || 0) + (scoring.evidence_chain || 0);
  if (total !== 100) errors.push(`scoring 各项之和应为100，实际 ${total}`);

  return errors;
}
