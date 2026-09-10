// 教学案件运行时：提问 / 出示线索 / 费曼讲解 / 兑换线索 / 投票 / 复盘
// 设计原则：秘密的解锁由规则引擎决定（确定性），台词由 AI 生成（可降级为脚本）。

import crypto from 'node:crypto';
import { apiKey, chatCompletion, extractJson, CHAT_MODEL } from './deepseek.js';
import { buildComponentSystemPrompt } from './prompt-factory.js';
import { judgeExplanation } from './feynman.js';

/* ---------------- 基础工具 ---------------- */

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

function matchAny(text, keywords = []) {
  const t = String(text || '');
  return keywords.some((k) => {
    const kw = String(k).replace(/[？?!.。！\s]+$/g, '');
    if (!kw) return false;
    if (t.includes(kw)) return true;
    return kw.length >= 4 && similarity(t, kw) >= 0.6;
  });
}

export function castById(caseData, id) {
  return (caseData.cast || []).find((c) => c.id === id);
}

function privateClueById(caseData, id) {
  return (caseData.clues?.private || []).find((c) => c.clue_id === id);
}

/* ---------------- 会话 ---------------- */

export function createIncidentSession(caseData, opts = {}) {
  const ids = (caseData.cast || []).map((c) => c.id);
  const roleId = opts.roleId && ids.includes(opts.roleId) ? opts.roleId : ids[Math.floor(Math.random() * ids.length)];

  const components = {};
  for (const c of caseData.cast || []) {
    components[c.id] = { history: [], revealed: [], first_contact: false, asked: 0 };
  }
  // 你自己就是其中一个部件：你自己的日志一开始就在手上，自己的秘密你本来就知道
  const ownPublicClue = (caseData.clues?.public || []).find((c) => c.from === roleId);
  const ownCast = (caseData.cast || []).find((c) => c.id === roleId);
  for (const s of ownCast?.secrets || []) components[roleId].revealed.push(s.secret_id);

  return {
    session_id: `s_${crypto.randomBytes(4).toString('hex')}`,
    case_id: caseData.case_id,
    created_at: Date.now(),
    player_role_id: roleId,
    feynman_points: 0,
    feynman_earned: 0,
    explanations: {}, // concept_id → { best_score, attempts: [], mastered, bonus }
    components,
    unlocked_clues: [],                      // 私人线索（费曼点兑换）
    public_clues: ownPublicClue ? [ownPublicClue.clue_id] : [], // 自己的日志开局就有
    presented: [],                           // 已出示过的线索
    hints: [],
    timeline: null,                          // 时间线还原成绩 { score, order_score, actor_score, attempts, details }
    vote: null,
    finished: false,
  };
}

/* ---------------- 秘密解锁规则引擎 ---------------- */

function evaluateSecrets(caseData, session, cast, text, mode) {
  const st = session.components[cast.id];
  const newlyRevealed = [];
  const locked = [];
  for (const s of cast.secrets || []) {
    if (st.revealed.includes(s.secret_id)) continue;
    const asked = matchAny(text, s.triggers || []);
    const clueForThis =
      Boolean(s.requires_clue) &&
      (session.presented.includes(s.requires_clue) || session.unlocked_clues.includes(s.requires_clue));
    const gateOk = !s.requires_clue || clueForThis;
    const pointsOk = !s.requires_points || session.feynman_points >= s.requires_points;
    // 提问：靠问对关键点解锁；出示线索：只解锁"明确需要这条线索"的秘密
    const triggered = mode === 'present' ? clueForThis : asked;
    if (triggered && gateOk && pointsOk) {
      st.revealed.push(s.secret_id);
      newlyRevealed.push(s);
    } else if (asked && s.requires_clue && !clueForThis) {
      locked.push(s);
    }
  }
  return { newlyRevealed, locked };
}

function unlockPublicClue(caseData, session, componentId) {
  const clue = (caseData.clues?.public || []).find((c) => c.from === componentId);
  if (!clue || session.public_clues.includes(clue.clue_id)) return null;
  session.public_clues.push(clue.clue_id);
  return clue;
}

/* ---------------- 离线台词兜底 ---------------- */

function offlineComponentReply(caseData, session, cast, text, newlyRevealed, locked) {
  const st = session.components[cast.id];
  if (newlyRevealed.length) {
    return `${cast.name}（犹豫了一下）……好吧，我跟你说实话。${newlyRevealed[0].content}`;
  }
  if (locked.length) {
    return `${cast.name}：${cast.deflect}（他瞟了一眼你手里的东西——你好像还缺一份能让他开口的记录）`;
  }
  const card = cast.knowledge_card;
  if (matchAny(text, (card.must_explain || []).flatMap((p) => p.keywords || []).concat([card.concept]))) {
    return `${cast.name}：这个我熟啊——${card.analogy_hint}。你要是能用自己的话讲一遍，才算真懂。`;
  }
  const hit = (cast.memory || []).filter((m) => similarity(text, m) > 0.12);
  if (hit.length) return hit.slice(0, 2).join(' ');
  return `${cast.name}：${cast.deflect}`;
}

/* ---------------- 组件回复（AI / 离线） ---------------- */

async function componentReply(caseData, session, cast, input, newlyRevealed, locked, useLLM) {
  const fallback = () => offlineComponentReply(caseData, session, cast, input.text || '', newlyRevealed, locked);
  if (!useLLM) return fallback();
  try {
    const st = session.components[cast.id];
    const system = buildComponentSystemPrompt(caseData, session, cast, { newlyRevealed, locked, input });
    const userLine = input.presentedClue
      ? `（我把「${input.presentedClue.title}」放在你面前）`
      : input.text;
    const messages = [
      { role: 'system', content: system },
      ...(st.history || []).slice(-6),
      { role: 'user', content: userLine },
    ];
    const content = await chatCompletion({ model: CHAT_MODEL, messages, maxTokens: 400, temperature: 0.9 });
    const text = String(content || '').trim();
    return text || fallback();
  } catch (e) {
    return `${fallback()}\n（AI 暂时不可用，本轮用备用台词）`;
  }
}

/* ---------------- 动作：提问 ---------------- */

export async function ask(caseData, session, input, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const cast = castById(caseData, input.component_id);
  if (!cast) throw new Error(`部件不存在：${input.component_id}`);
  const st = session.components[cast.id];
  const text = String(input.text || '').trim();
  if (!text) throw new Error('请先输入你要问的话');

  const { newlyRevealed, locked } = evaluateSecrets(caseData, session, cast, text, 'ask');
  const reply = await componentReply(caseData, session, cast, { text }, newlyRevealed, locked, useLLM);

  st.history.push({ role: 'user', content: text });
  st.history.push({ role: 'assistant', content: reply });
  if (st.history.length > 12) st.history = st.history.slice(-12);
  st.asked += 1;
  st.first_contact = true;

  const publicClue = unlockPublicClue(caseData, session, cast.id);
  const hints = [];
  for (const s of locked) {
    if (s.unlock_hint) hints.push(`【提示】${s.unlock_hint}`);
  }

  return {
    component_id: cast.id,
    component_name: cast.name,
    reply,
    secrets_revealed: newlyRevealed.map((s) => ({ secret_id: s.secret_id, content: s.content })),
    public_clue: publicClue,
    hints,
    feynman_points: session.feynman_points,
  };
}

/* ---------------- 动作：出示线索 ---------------- */

export async function present(caseData, session, input, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const cast = castById(caseData, input.component_id);
  if (!cast) throw new Error(`部件不存在：${input.component_id}`);
  const clue =
    privateClueById(caseData, input.clue_id) || (caseData.clues?.public || []).find((c) => c.clue_id === input.clue_id);
  if (!clue) throw new Error(`线索不存在：${input.clue_id}`);
  const owned = session.unlocked_clues.includes(clue.clue_id) || session.public_clues.includes(clue.clue_id);
  if (!owned) throw new Error(`你还没有这条线索：${clue.title}`);

  if (!session.presented.includes(clue.clue_id)) session.presented.push(clue.clue_id);

  const st = session.components[cast.id];
  const { newlyRevealed, locked } = evaluateSecrets(caseData, session, cast, '', 'present');
  const reply = await componentReply(
    caseData,
    session,
    cast,
    { text: `（你把「${clue.title}」放在他面前）`, presentedClue: clue },
    newlyRevealed,
    locked,
    useLLM,
  );

  st.history.push({ role: 'user', content: `（出示线索：${clue.title}）` });
  st.history.push({ role: 'assistant', content: reply });
  st.first_contact = true;

  const publicClue = unlockPublicClue(caseData, session, cast.id);
  return {
    component_id: cast.id,
    component_name: cast.name,
    reply,
    clue,
    secrets_revealed: newlyRevealed.map((s) => ({ secret_id: s.secret_id, content: s.content })),
    public_clue: publicClue,
    hints: [],
  };
}

/* ---------------- 动作：费曼讲解 ---------------- */

export async function explain(caseData, session, input, opts = {}) {
  const useLLM = opts.useLLM ?? Boolean(apiKey());
  const cast = (caseData.cast || []).find((c) => c.knowledge_card?.concept_id === input.concept_id);
  if (!cast) throw new Error(`找不到这个知识点：${input.concept_id}`);
  const text = String(input.text || '').trim();
  if (text.length < 5) throw new Error('讲解太短了，至少要说出你的理解');

  const result = await judgeExplanation(cast.knowledge_card, text, { useLLM });

  const rec = session.explanations[input.concept_id] || { best_score: 0, attempts: [], mastered: false, bonus: 0 };
  const prevBest = rec.best_score;
  const delta = Math.max(0, result.score - prevBest);
  rec.best_score = Math.max(prevBest, result.score);
  rec.mastered = rec.best_score >= 2;
  rec.attempts.push({
    score: result.score,
    text,
    feedback: result.feedback,
    followup_question: result.followup_question,
    ts: Date.now(),
  });
  session.explanations[input.concept_id] = rec;

  // 讲清"你自己"的知识卡有额外奖励：你是本人，讲不明白最说不过去
  const isOwnCard = cast.id === session.player_role_id;
  let bonus = 0;
  if (isOwnCard && !rec.bonus && result.score >= 2) {
    bonus = 1;
    rec.bonus = 1;
  }

  session.feynman_points += delta + bonus;
  session.feynman_earned += delta + bonus;

  return {
    component_id: cast.id,
    component_name: cast.name,
    concept: cast.knowledge_card.concept,
    concept_id: input.concept_id,
    is_own_card: isOwnCard,
    score: result.score,
    best_score: rec.best_score,
    points_gained: delta + bonus,
    bonus,
    feynman_points: session.feynman_points,
    covered: result.covered,
    missed: result.missed,
    jargon: result.jargon,
    analogy_ok: result.analogy_ok,
    analogy_comment: result.analogy_comment,
    feedback: result.feedback,
    followup_question: result.followup_question,
    mode: result.mode,
    note: result.note,
  };
}

/* ---------------- 动作：兑换线索 ---------------- */

export function unlockClue(caseData, session, input) {
  const clue = privateClueById(caseData, input.clue_id);
  if (!clue) throw new Error(`线索不存在：${input.clue_id}`);
  if (session.unlocked_clues.includes(clue.clue_id)) return { already: true, clue, feynman_points: session.feynman_points };
  if (session.feynman_points < clue.cost) {
    throw new Error(`费曼点不够：需要 ${clue.cost} 点，你现在有 ${session.feynman_points} 点。去把还没讲清的知识卡讲一遍吧。`);
  }
  session.feynman_points -= clue.cost;
  session.unlocked_clues.push(clue.clue_id);
  return { already: false, clue, feynman_points: session.feynman_points };
}

/* ---------------- 动作：还原事故时间线 ---------------- */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 对外暴露"待排序的事件"：只给 id 与文字，顺序每次重新打乱，答案不下发 */
export function timelineTaskView(caseData, session) {
  const task = caseData.timeline_task;
  if (!task) return null;
  return {
    title: task.title,
    prompt: task.prompt,
    pass_score: task.pass_score ?? 80,
    events: shuffle(task.events).map((e) => ({ id: e.id, text: e.text })),
    actor_options: [
      ...(caseData.cast || []).map((c) => ({ id: c.id, label: `${c.name}（${c.component}）` })),
      { id: 'none', label: '系统自身（非某个部件）' },
    ],
    result: session.timeline
      ? {
          score: session.timeline.score,
          order_score: session.timeline.order_score,
          actor_score: session.timeline.actor_score,
          passed: session.timeline.passed,
          attempts: session.timeline.attempts,
          details: session.timeline.details,
        }
      : null,
  };
}

/**
 * 判分：顺序分 60 + 归因分 40，纯规则、零 AI 成本。
 * placements: [{ event_id, order(从0开始), actor }]
 */
export function submitTimeline(caseData, session, input) {
  const task = caseData.timeline_task;
  if (!task) throw new Error('本案件没有时间线任务');
  const placements = Array.isArray(input.placements) ? input.placements : [];
  const correct = new Map(task.events.map((e, i) => [e.id, { ...e, index: i }]));
  const seen = new Set();

  const details = [];
  let orderCorrect = 0;
  let actorCorrect = 0;

  for (const p of placements) {
    const ev = correct.get(p.event_id);
    if (!ev || seen.has(p.event_id)) continue; // 忽略未知/重复
    seen.add(p.event_id);
    const orderOk = Number(p.order) === ev.index;
    const actorOk = String(p.actor || '') === ev.actor;
    if (orderOk) orderCorrect++;
    if (actorOk) actorCorrect++;
    details.push({
      event_id: ev.id,
      text: ev.text,
      your_order: Number(p.order),
      correct_order: ev.index,
      order_ok: orderOk,
      your_actor: p.actor || null,
      correct_actor: ev.actor,
      actor_ok: actorOk,
      why: ev.why,
    });
  }

  const total = task.events.length;
  if (seen.size < total) {
    throw new Error(`还有 ${total - seen.size} 个事件没有排进时间线`);
  }

  const order_score = Math.round((orderCorrect / total) * 60);
  const actor_score = Math.round((actorCorrect / total) * 40);
  const score = order_score + actor_score;
  const passed = score >= (task.pass_score ?? 80);
  const attempts = (session.timeline?.attempts || 0) + 1;

  // 记录最好成绩
  if (!session.timeline || score >= session.timeline.score) {
    session.timeline = { score, order_score, actor_score, passed, attempts, details, ts: Date.now() };
  } else {
    session.timeline.attempts = attempts;
  }

  const keyEvent = task.events.find((e) => e.id === task.key_link_event);
  return {
    score,
    order_score,
    actor_score,
    passed,
    attempts,
    order_correct: orderCorrect,
    actor_correct: actorCorrect,
    total,
    best_score: session.timeline.score,
    details,
    correct_order: task.events.map((e) => ({ event_id: e.id, text: e.text, why: e.why })),
    key_link: keyEvent ? { event_id: keyEvent.id, text: keyEvent.text, note: task.key_link_note } : null,
  };
}

/* ---------------- 动作：投票与复盘 ---------------- */

export function vote(caseData, session, input) {
  const target = castById(caseData, input.component_id);
  if (!target) throw new Error(`投票对象不存在：${input.component_id}`);
  if (!(caseData.vote_options || []).includes(input.component_id)) {
    throw new Error('只能从给出的四个选项里选一个');
  }
  if (!session.timeline) {
    throw new Error('结案前请先还原事故时间线——光指认凶手不够，还要说清事故是怎么一步步发生的。');
  }
  session.vote = input.component_id;
  session.finished = true;
  return { vote: input.component_id, correct: input.component_id === caseData.truth.direct_culprit };
}

export function reviewPayload(caseData, session) {
  const culprit = castById(caseData, caseData.truth.direct_culprit);
  const voteCast = session.vote ? castById(caseData, session.vote) : null;
  const own = castById(caseData, session.player_role_id);
  const ownRec = own ? session.explanations[own.knowledge_card.concept_id] : null;
  const timelineScore = session.timeline?.score ?? 0;
  const correct = session.vote === caseData.truth.direct_culprit;
  const blamed = session.vote === session.player_role_id;

  // 结局：破案 + 讲清自己的卡 + 时间线还原合格 = 最佳；被投到自己头上 = 替罪羊
  const endingKey = correct
    ? ownRec?.best_score >= 2 && timelineScore >= 80
      ? 'perfect'
      : 'good'
    : blamed
      ? 'scapegoat'
      : 'wrong';

  const conceptReport = (caseData.cast || []).map((c) => {
    const rec = session.explanations[c.knowledge_card.concept_id];
    return {
      concept_id: c.knowledge_card.concept_id,
      concept: c.knowledge_card.concept,
      component: c.name,
      is_own_card: c.id === session.player_role_id,
      best_score: rec?.best_score ?? 0,
      attempts: rec?.attempts?.length ?? 0,
      mastered: Boolean(rec?.mastered),
      last_feedback: rec?.attempts?.length ? rec.attempts[rec.attempts.length - 1].feedback : null,
    };
  });
  const mastered = conceptReport.filter((c) => c.mastered).length;
  return {
    correct,
    vote: session.vote,
    vote_name: voteCast?.name || null,
    culprit: caseData.truth.direct_culprit,
    culprit_name: culprit?.name || null,
    culprit_component: culprit?.component || null,
    culprit_explanation: caseData.truth.culprit_explanation,
    systemic_causes: caseData.truth.systemic_causes,
    truth_timeline: caseData.truth.timeline,
    explanation: caseData.truth.explanation,
    real_world_hook: caseData.truth.real_world_hook,
    data_flow: caseData.review?.data_flow || [],
    concept_summary: caseData.review?.concept_summary || [],
    reflection_questions: caseData.review?.reflection_questions || [],
    ending: { key: endingKey, text: caseData.review?.endings?.[endingKey] || '' },
    player_role: own
      ? {
          id: own.id,
          name: own.name,
          component: own.component,
          objective: own.as_player?.objective || '',
          stake: own.as_player?.stake || '',
        }
      : null,
    blamed_self: blamed,
    personal_ending: own?.as_player ? (blamed ? own.as_player.ending_bad : own.as_player.ending_good) : null,
    timeline_result: session.timeline
      ? {
          score: session.timeline.score,
          order_score: session.timeline.order_score,
          actor_score: session.timeline.actor_score,
          passed: session.timeline.passed,
          attempts: session.timeline.attempts,
          details: session.timeline.details,
        }
      : null,
    timeline_task: timelineTaskView(caseData, session),
    score: {
      feynman_earned: session.feynman_earned,
      feynman_left: session.feynman_points,
      mastered_concepts: mastered,
      total_concepts: conceptReport.length,
      clues_unlocked: session.unlocked_clues.length,
      clues_total: (caseData.clues?.private || []).length,
      talked_components: Object.values(session.components).filter((c) => c.first_contact).length,
      timeline_score: timelineScore,
    },
    concept_report: conceptReport,
  };
}

/* ---------------- 视图 ---------------- */

export function stateView(caseData, session) {
  const own = castById(caseData, session.player_role_id);
  return {
    session_id: session.session_id,
    case_id: session.case_id,
    player_role: own
      ? {
          id: own.id,
          name: own.name,
          component: own.component,
          role: own.role,
          avatar_color: own.avatar_color,
          objective: own.as_player?.objective || '',
          stake: own.as_player?.stake || '',
          // 你自己的秘密，你本来就知道（这是你的身份卡）
          secrets: (own.secrets || []).map((s) => s.content),
          concept_id: own.knowledge_card.concept_id,
          concept: own.knowledge_card.concept,
        }
      : null,
    feynman_points: session.feynman_points,
    feynman_earned: session.feynman_earned,
    public_clues: (caseData.clues?.public || []).filter((c) => session.public_clues.includes(c.clue_id)),
    private_clues: (caseData.clues?.private || []).map((c) => ({
      clue_id: c.clue_id,
      title: c.title,
      cost: c.cost,
      unlock_hint: c.unlock_hint,
      unlocked: session.unlocked_clues.includes(c.clue_id),
      content: session.unlocked_clues.includes(c.clue_id) ? c.content : null,
    })),
    presented: session.presented,
    components: (caseData.cast || []).map((c) => {
      const st = session.components[c.id];
      return {
        id: c.id,
        name: c.name,
        component: c.component,
        is_self: c.id === session.player_role_id,
        first_contact: st.first_contact,
        secrets_found: st.revealed.length,
        secrets_total: (c.secrets || []).length,
      };
    }),
    explanations: (caseData.cast || []).map((c) => {
      const rec = session.explanations[c.knowledge_card.concept_id];
      return {
        concept_id: c.knowledge_card.concept_id,
        component: c.name,
        concept: c.knowledge_card.concept,
        is_own_card: c.id === session.player_role_id,
        best_score: rec?.best_score ?? 0,
        attempts: rec?.attempts?.length ?? 0,
      };
    }),
    timeline: session.timeline
      ? { submitted: true, score: session.timeline.score, passed: session.timeline.passed }
      : { submitted: false },
    timeline_task: timelineTaskView(caseData, session),
    vote: session.vote,
    finished: session.finished,
    hints: session.hints,
  };
}
