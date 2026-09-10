// 事故报告判官：评估学生写的故障分析报告（因果链 / 关键环节 / 修复建议）
// 三级策略：reasoner → chat → 规则兜底（离线可用）

import { apiKey, chatCompletion, extractJson, CHAT_MODEL, REASONER_MODEL } from './deepseek.js';
import { buildReportMessages } from './prompt-factory.js';

const PASS = 60;
const EXCELLENT = 85;

function offlineReport(caseData, text) {
  const items = caseData.report?.must_cover || [];
  const t = String(text || '');
  const covered = [];
  const missed = [];
  for (const it of items) {
    const hit = (it.keywords || []).some((k) => t.includes(k));
    (hit ? covered : missed).push(it.point);
  }
  const ratio = items.length ? covered.length / items.length : 0;
  let score = Math.round(ratio * 100);
  if (t.length < 120) score = Math.min(score, 55); // 太短：说明没展开

  const parts = [];
  if (score >= EXCELLENT) parts.push('报告完整，因果链和修复建议都到位了。');
  else if (score >= PASS) parts.push('报告基本成立，但因果链还有缺口。');
  else parts.push('报告还不够完整，读者看不出事故是怎么一步步发生的。');
  if (missed.length) parts.push(`没写到：${missed.join('；')}。`);
  if (t.length < 120) parts.push('篇幅偏短，故障分析报告要说清「起因—经过—后果—对策」。');

  return {
    score,
    covered,
    missed,
    highlights: [],
    issues: [],
    feedback: parts.join(' '),
    best_fix_comment: '（离线模式不细评修复建议）',
    mode: 'rule-based',
  };
}

/**
 * 评判事故分析报告。
 * @param {object} caseData 案件（含 report.must_cover 与 truth）
 * @param {string} text 学生写的报告
 */
export async function judgeReport(caseData, text, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const rule = offlineReport(caseData, text);
  if (!useLLM) {
    return { ...rule, passed: rule.score >= PASS, note: '当前为离线模式：按要点关键词判分，配置 DeepSeek API Key 后可获得 AI 逐句点评。' };
  }

  const messages = buildReportMessages(caseData, text);
  const attempts = [
    { model: REASONER_MODEL, jsonMode: false, maxTokens: 2000 },
    { model: CHAT_MODEL, jsonMode: true, maxTokens: 1200 },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const content = await chatCompletion({ model: a.model, messages, jsonMode: a.jsonMode, maxTokens: a.maxTokens });
      const parsed = extractJson(content);
      const score = Math.max(0, Math.min(100, Number(parsed.score ?? rule.score)));
      return {
        score,
        passed: score >= PASS,
        covered: Array.isArray(parsed.covered) ? parsed.covered : [],
        missed: Array.isArray(parsed.missed) ? parsed.missed : [],
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        feedback: parsed.feedback || rule.feedback,
        best_fix_comment: parsed.best_fix_comment || '',
        mode: a.model,
      };
    } catch (e) {
      errors.push(`${a.model}: ${e.message}`);
    }
  }
  return { ...rule, passed: rule.score >= PASS, judge_errors: errors, note: 'AI 判官调用失败，已降级为关键词判分。' };
}

export const REPORT_PASS = PASS;
export const REPORT_EXCELLENT = EXCELLENT;
