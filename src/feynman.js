// 费曼判官：评估学生"用生活类比讲清概念"的讲解质量
// 三级策略：deepseek-reasoner/chat 深度评判 → 规则兜底（离线可玩）

import { apiKey, chatCompletion, extractJson, CHAT_MODEL, REASONER_MODEL } from './deepseek.js';
import { buildFeynmanMessages } from './prompt-factory.js';

/* ---------------- 离线规则判分（无 Key / 调用失败时使用） ---------------- */

const ANALOGY_PATTERN = /像|好比|就像|相当于|比如|如同|跟.{1,8}一样|打个比方|可以理解为/;

function offlineJudge(card, text) {
  const t = String(text || '').trim();
  const points = card.must_explain || [];
  const covered = [];
  const missed = [];
  for (const p of points) {
    const hit = (p.keywords || []).some((k) => t.includes(k));
    (hit ? covered : missed).push(p.point);
  }
  const ratio = points.length ? covered.length / points.length : 0;
  const hasAnalogy = ANALOGY_PATTERN.test(t);
  const tooShort = t.length < 30;

  let score;
  if (ratio >= 0.85) score = 3;
  else if (ratio >= 0.55) score = 2;
  else if (ratio > 0) score = 1;
  else score = 0;
  if (score === 3 && !hasAnalogy) score = 2; // 费曼标准：必须落到类比
  if (tooShort && score > 1) score = 1;

  const feedbackParts = [];
  if (score >= 3) feedbackParts.push('讲得很清楚，关键点都到位了，类比也贴切。');
  else if (score === 2) feedbackParts.push(hasAnalogy ? '基本讲清了，但还有要点没覆盖。' : '内容不错，不过还缺一个生活类比——费曼的标准是「能让外行听懂」。');
  else if (score === 1) feedbackParts.push('方向对，但只讲到了一部分，别人听完还是一知半解。');
  else feedbackParts.push('这段还没把概念讲出来，试试从「它是什么、为什么需要它、不用会怎样」三个角度说。');
  if (missed.length) feedbackParts.push(`缺了：${missed.join('；')}。`);
  if (tooShort) feedbackParts.push('内容太短了，多说两句，把过程讲完整。');

  return {
    score,
    covered,
    missed,
    jargon: [],
    analogy_ok: hasAnalogy,
    analogy_comment: hasAnalogy ? '检测到类比表达（离线模式无法细评质量）' : '没有检测到生活类比',
    feedback: feedbackParts.join(' '),
    followup_question: missed.length ? `能再解释一下「${missed[0]}」吗？` : '如果数据量特别大，这个机制还成立吗？',
    mode: 'rule-based',
  };
}

/* ---------------- 对外接口 ---------------- */

/**
 * 评判一次费曼讲解。
 * @param {object} card 知识卡（含 concept / must_explain / misconceptions / analogy_hint）
 * @param {string} text 学生的讲解
 * @param {object} opts { useLLM, context: {component} }
 */
export async function judgeExplanation(card, text, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const rule = offlineJudge(card, text);
  if (!useLLM) return { ...rule, note: '当前为离线模式：使用关键词规则判分，配置 DeepSeek API Key 后可获得 AI 逐句点评。' };

  const messages = buildFeynmanMessages(card, text);
  const attempts = [
    { model: REASONER_MODEL, jsonMode: false, maxTokens: 2000 },
    { model: CHAT_MODEL, jsonMode: true, maxTokens: 1200 },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const content = await chatCompletion({ model: a.model, messages, jsonMode: a.jsonMode, maxTokens: a.maxTokens });
      const parsed = extractJson(content);
      const score = Math.max(0, Math.min(3, Number(parsed.score ?? rule.score)));
      return {
        score,
        covered: Array.isArray(parsed.covered) ? parsed.covered : [],
        missed: Array.isArray(parsed.missed) ? parsed.missed : [],
        jargon: Array.isArray(parsed.jargon) ? parsed.jargon : [],
        analogy_ok: Boolean(parsed.analogy_ok),
        analogy_comment: parsed.analogy_comment || '',
        feedback: parsed.feedback || rule.feedback,
        followup_question: parsed.followup_question || rule.followup_question,
        mode: a.model,
      };
    } catch (e) {
      errors.push(`${a.model}: ${e.message}`);
    }
  }
  return { ...rule, judge_errors: errors, note: 'AI 判官调用失败，已降级为关键词判分。' };
}
