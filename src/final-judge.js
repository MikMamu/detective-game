// 终局裁定模块（本程序的核心交付之一）
// 三级策略：
//   1. deepseek-reasoner 深度裁定（推理链评分 + 小说口吻结案陈词）
//   2. 失败降级 deepseek-chat + JSON 模式
//   3. 无 Key / 全部失败 → 本地规则裁定兜底，保证接口永远可用

import { apiKey, chatCompletion, extractJson, CHAT_MODEL, REASONER_MODEL } from './deepseek.js';
import { buildJudgeMessages } from './prompt-factory.js';

export function npcName(caseData, npcId) {
  const npc = (caseData.npcs || []).find((n) => n.npc_id === npcId);
  return npc ? npc.name : String(npcId || '');
}

// 把玩家列举的证据（可能是 id，也可能是名称/关键词）解析成物证 id
function resolveEvidenceIds(caseData, entries) {
  const byId = new Map((caseData.evidence || []).map((e) => [e.evidence_id, e]));
  return (entries || []).map((x) => {
    const s = String(x || '').trim();
    if (byId.has(s)) return s;
    for (const [id, e] of byId) {
      if (s.length >= 2 && e.name.includes(s)) return id;
    }
    return s;
  });
}

function keywordHits(text, keywords) {
  const t = String(text || '');
  return (keywords || []).filter((kw) => kw && t.includes(kw)).length;
}

/**
 * 本地规则裁定：确定性打分，作为兜底与快速预评分。
 * 语义级裁定交给 LLM；规则打分保证服务在无网络/无 Key 时依然给出可用的结果。
 */
export function ruleBasedScore(caseData, answer) {
  const truth = caseData.truth || {};
  const fa = caseData.final_answer || {};
  const hints = caseData.score_hints || {};
  const scoring = caseData.scoring || { killer: 25, motive: 25, method: 25, evidence_chain: 25, pass_threshold: 80 };

  const killerScore = String(answer.killer || '').trim() === String(truth.killer || '').trim()
    ? scoring.killer
    : 0;

  const motiveKws = hints.motive_keywords || [];
  const motiveScore = motiveKws.length
    ? Math.round((keywordHits(answer.motive, motiveKws) / motiveKws.length) * scoring.motive)
    : (String(answer.motive || '') === String(fa.motive || '') ? scoring.motive : 0);

  const methodKws = hints.method_keywords || [];
  const methodScore = methodKws.length
    ? Math.round((keywordHits(answer.method, methodKws) / methodKws.length) * scoring.method)
    : (String(answer.method || '') === String(fa.method || '') ? scoring.method : 0);

  const keyEv = hints.key_evidence || fa.key_evidence || [];
  const playerIds = resolveEvidenceIds(caseData, answer.evidence);
  const evHits = keyEv.filter((id) => playerIds.includes(id)).length;
  const evidenceScore = keyEv.length
    ? Math.round((evHits / keyEv.length) * scoring.evidence_chain)
    : 0;

  const total = killerScore + motiveScore + methodScore + evidenceScore;
  const passThreshold = scoring.pass_threshold ?? 80;
  return {
    killer_score: killerScore,
    motive_score: motiveScore,
    method_score: methodScore,
    evidence_score: evidenceScore,
    total,
    passed: total >= passThreshold,
  };
}

function trimPunct(s) {
  return String(s || '').replace(/[。；，、\s]+$/, '');
}

export function buildFallbackStory(caseData, answer, score) {
  const truth = caseData.truth || {};
  const killerName = npcName(caseData, truth.killer);
  const answerName = npcName(caseData, answer.killer) || String(answer.killer || '未指明');
  const right = score.killer_score > 0;
  return [
    `${caseData.title}，至此尘埃落定。`,
    `真凶是${killerName}——${trimPunct(truth.motive)}；${trimPunct(truth.method)}。`,
    `你的推理指认了${answerName}，${right ? '一击中的。' : '与真相擦肩而过。'}`,
    `综合评定 ${score.total}/100，${score.passed ? '勘破迷局，顺利通关。' : '尚未抵达真相，还差关键一环。'}`,
  ].join('');
}

function fallbackComments(score) {
  const g = (s, max) => `${s}/${max}${s >= max ? ' ✓' : s > 0 ? ' ◐' : ' ✗'}`;
  return {
    killer_comment: g(score.killer_score, 25),
    motive_comment: g(score.motive_score, 25),
    method_comment: g(score.method_score, 25),
    evidence_comment: g(score.evidence_score, 25),
  };
}

/**
 * 终局裁定主入口。
 * @param {object} caseData 案件剧本（含 truth / final_answer / score_hints）
 * @param {object} answer 玩家答案 { killer, motive, method, evidence: [] }
 * @param {object|null} sessionSummary { unlocked: [], broken_lies: [] } 可选调查记录
 * @param {object} opts { useLLM }
 * @returns 裁定结果：四项得分 + 总分 + passed + verdict_story + mode
 */
export async function adjudicate(caseData, answer, sessionSummary = null, opts = {}) {
  const rule = ruleBasedScore(caseData, answer);
  const useApi = opts.useLLM ?? Boolean(apiKey());

  if (!useApi) {
    return {
      ...rule,
      mode: 'rule-based',
      comments: fallbackComments(rule),
      verdict_story: buildFallbackStory(caseData, answer, rule),
      note: '未配置 DEEPSEEK_API_KEY，使用本地规则裁定；配置 Key 后自动升级为 deepseek-reasoner 深度裁定。',
    };
  }

  const messages = buildJudgeMessages(caseData, answer, sessionSummary);
  const attempts = [
    { model: REASONER_MODEL, jsonMode: false, maxTokens: 3000 },
    { model: CHAT_MODEL, jsonMode: true, maxTokens: 2000 },
  ];
  const errors = [];

  for (const a of attempts) {
    try {
      const content = await chatCompletion({
        model: a.model,
        messages,
        jsonMode: a.jsonMode,
        maxTokens: a.maxTokens,
      });
      const parsed = extractJson(content);
      const total = Number.isFinite(parsed.total)
        ? parsed.total
        : (parsed.killer_score || 0) + (parsed.motive_score || 0) + (parsed.method_score || 0) + (parsed.evidence_score || 0);
      const passThreshold = caseData.scoring?.pass_threshold ?? 80;
      return {
        killer_score: Number(parsed.killer_score ?? 0),
        motive_score: Number(parsed.motive_score ?? 0),
        method_score: Number(parsed.method_score ?? 0),
        evidence_score: Number(parsed.evidence_score ?? 0),
        total,
        passed: parsed.passed ?? total >= passThreshold,
        comments: {
          killer_comment: parsed.killer_comment || '',
          motive_comment: parsed.motive_comment || '',
          method_comment: parsed.method_comment || '',
          evidence_comment: parsed.evidence_comment || '',
        },
        verdict_story: parsed.verdict_story || buildFallbackStory(caseData, answer, rule),
        mode: a.model,
      };
    } catch (e) {
      errors.push(`${a.model}: ${e.message}`);
    }
  }

  return {
    ...rule,
    mode: 'rule-based',
    comments: fallbackComments(rule),
    verdict_story: buildFallbackStory(caseData, answer, rule),
    judge_errors: errors,
    note: 'LLM 裁定失败，已降级为本地规则裁定。',
  };
}
