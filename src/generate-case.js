// 剧本生成流水线：骨架抽取 → LLM 填血肉 → 结构校验 → 可解性验收 → 带原因重试

import { apiKey, chatCompletion, extractJson, CHAT_MODEL } from './deepseek.js';
import { pickSkeleton } from './skeleton.js';
import { buildGeneratorMessages, buildValidatorMessages } from './prompt-factory.js';
import { validateStructure } from './validate.js';

async function runValidator(caseData) {
  if (!apiKey()) {
    return { verdict: 'pass', warnings: ['未配置 DEEPSEEK_API_KEY，跳过 LLM 可解性验收（仅结构校验）'] };
  }
  try {
    const content = await chatCompletion({
      model: CHAT_MODEL,
      messages: buildValidatorMessages(caseData),
      jsonMode: true,
      maxTokens: 1500,
    });
    return extractJson(content);
  } catch (e) {
    return { verdict: 'pass', warnings: [`LLM 验收调用失败，需人工复核：${e.message}`] };
  }
}

/**
 * 生成一个完整案件。
 * @param {object} options { genre?, difficulty?, seed?, maxRetries? }
 * @returns 案件 JSON（含 _meta 生成记录）
 */
export async function generateCase({ genre, difficulty, seed, maxRetries = 3 } = {}) {
  if (!apiKey()) {
    throw new Error('生成器依赖 LLM，请先配置 $env:DEEPSEEK_API_KEY="sk-..."');
  }

  const skeleton = pickSkeleton({ genre, difficulty, seed });
  let fixNotes = '';
  const attempts = [];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const raw = await chatCompletion({
      model: CHAT_MODEL,
      messages: buildGeneratorMessages(skeleton, fixNotes),
      jsonMode: true,
      maxTokens: 8000,
      temperature: 0.9,
    });

    let caseData;
    try {
      caseData = extractJson(raw);
    } catch (e) {
      fixNotes = `上次输出无法解析为 JSON：${e.message}，请重新完整输出。`;
      attempts.push('json-parse-fail');
      continue;
    }

    const structErrors = validateStructure(caseData);
    if (structErrors.length) {
      fixNotes = `结构校验失败：${structErrors.join('；')}。请修正后重新输出完整 JSON。`;
      attempts.push('structure-fail');
      continue;
    }

    const verdict = await runValidator(caseData);
    if (verdict && verdict.verdict === 'fail') {
      fixNotes = `可解性验收未通过：${(verdict.fix_suggestions || []).join('；')}`;
      attempts.push('validation-fail');
      continue;
    }

    caseData._meta = {
      skeleton,
      attempts: attempts.concat('pass'),
      warnings: verdict?.warnings || [],
      generated: true,
    };
    return caseData;
  }

  throw new Error(
    `生成失败：连续 ${maxRetries} 次尝试未通过验收（${attempts.join(', ')}）${fixNotes ? '｜最后驳回原因：' + fixNotes : ''}`,
  );
}
