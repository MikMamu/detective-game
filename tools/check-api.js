// 端到端冒烟测试：模拟网页前端的完整调用序列，校验返回字段（需先启动服务）
// 用法：node tools/check-api.js [baseUrl]

const base = process.argv[2] || 'http://127.0.0.1:3123';
let failed = false;

function need(cond, label) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failed = true;
}

async function api(path, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${data.error || res.status}`);
  return data;
}

// 1. 首页与静态资源
const home = await fetch(base + '/');
const html = await home.text();
need(home.ok && html.includes('谁动了我的0和1'), '首页可访问且内容正确');
const jsRes = await fetch(base + '/app.js');
need(jsRes.ok && jsRes.headers.get('cache-control')?.includes('no-store'), 'app.js 可访问且禁用缓存');

// 2. 案件公开信息（前端渲染依赖的字段）
const { case: caseInfo } = await api('/api/cases/featured');
need(Boolean(caseInfo.title && caseInfo.subtitle && caseInfo.opening), '案件标题/副标题/开场白存在');
need(caseInfo.cast?.length === 7, `7 位部件角色（实际 ${caseInfo.cast?.length}）`);
need(
  caseInfo.cast.every((c) => c.knowledge_card?.concept && c.knowledge_card.must_explain?.length),
  '每位角色都有知识卡与要点清单',
);
need(caseInfo.vote_options?.length === 4, '4 个投票选项');
need(Boolean(caseInfo.clues?.public?.length && caseInfo.clues?.private?.length), '公共线索与私人线索清单存在');
need(!JSON.stringify(caseInfo).includes('"secrets"') && !JSON.stringify(caseInfo).includes('culprit'), '秘密与真相未下发前端');

// 3. 开局（指定身份，保证断言稳定）
const sess = await api('/api/sessions', { case_id: caseInfo.case_id, role: 'cache' });
const sid = sess.session_id;
need(Boolean(sid && sess.state), '开局返回 session_id 与初始状态');
need(sess.state.components?.length === 7 && Array.isArray(sess.state.explanations), '初始状态含 7 位部件与讲解记录');
need(sess.state.private_clues?.every((c) => c.content === null), '未解锁的私人线索不下发内容');

// 4. 问话（真实 AI）
const ask = await api(`/api/sessions/${sid}/ask`, { component_id: 'os', text: '凌晨2:00你给谁开了网络权限？' });
need(Boolean(ask.reply && ask.component_name), '问话返回角色台词');
need(ask.secrets_revealed?.length >= 1, '问对关键点后说出秘密');
need(Boolean(ask.public_clue?.title), '首次接触获得公共线索');
need(Boolean(ask.state), '问话后返回最新状态');

// 5. 费曼讲解
const explain = await api(`/api/sessions/${sid}/explain`, {
  concept_id: 'kc_cache',
  text: '缓存就像手边的便利贴，内存像桌上的笔记本。便利贴上抄了最近常用的数据，CPU 一要就有叫命中，没有就得回笔记本翻叫未命中；笔记本改了内容但便利贴没撕掉重抄，就会照旧数字办事，这就是缓存不一致，所以要有失效同步机制。',
});
need(explain.score >= 2, `费曼判官给出合理分数（${explain.score}/3，${explain.mode}）`);
need(Boolean(explain.feedback && explain.state), '讲解返回反馈与最新状态');
need(explain.feynman_points > 0, `赚到费曼点（${explain.feynman_points}）`);

// 6. 兑换线索与出示
const unlock = await api(`/api/sessions/${sid}/unlock`, { clue_id: 'pv_cache' });
need(Boolean(unlock.clue?.content && unlock.state), '费曼点可兑换私人线索');
const present = await api(`/api/sessions/${sid}/present`, { component_id: 'cpu', clue_id: 'pv_cache' });
need(present.secrets_revealed?.length === 1, `出示线索只解锁对应的那一条秘密（实际 ${present.secrets_revealed?.length}）`);

// 7. 身份卡（你是其中一个部件）
need(Boolean(sess.state.player_role?.objective && sess.state.player_role?.concept), '开局抽到身份卡（目标 + 自己的知识卡）');
need(sess.state.player_role.secrets?.length >= 1, '身份卡含你自己的秘密');
need(sess.state.components.filter((c) => c.is_self).length === 1, '居民列表标记出「你自己」');
need(sess.state.public_clues.length === 1, '自己的日志开局就在手上');

// 8. 结案前必须还原时间线
let blocked = false;
try {
  await api(`/api/sessions/${sid}/vote`, { component_id: 'compiler' });
} catch {
  blocked = true;
}
need(blocked, '未还原时间线时投票被拦下');

const task = sess.state.timeline_task;
need(Boolean(task?.events?.length >= 6 && task?.actor_options?.length === 8), `时间线任务下发 ${task?.events?.length} 条事件与责任环节选项`);
need(task.events.every((e) => !e.actor && !e.why), '时间线答案未下发前端');

// 先故意排错：倒序 + 不选责任环节 → 应该低分
const reversed = task.events.map((e, i) => ({ event_id: e.id, order: task.events.length - 1 - i, actor: 'none' }));
const bad = await api(`/api/sessions/${sid}/timeline`, { placements: reversed });
need(bad.score < 80 && bad.passed === false, `乱序提交得低分（${bad.score}/100）`);

// 再按正确顺序提交（用真值重建正确顺序）
const order = ['ev_user', 'ev_disk', 'ev_ram', 'ev_cache', 'ev_backdoor', 'ev_net', 'ev_blue'];
const actors = { ev_user: 'os', ev_disk: 'disk', ev_ram: 'ram', ev_cache: 'cache', ev_backdoor: 'compiler', ev_net: 'net', ev_blue: 'none' };
const placements = order.map((id, i) => ({ event_id: id, order: i, actor: actors[id] }));
const good = await api(`/api/sessions/${sid}/timeline`, { placements });
need(good.score === 100 && good.passed === true, `正确时间线满分（${good.score}/100，顺序 ${good.order_score}/60 + 归因 ${good.actor_score}/40）`);
need(Boolean(good.key_link?.note && good.correct_order?.length === 7), '提交后揭晓正确时间线与关键环节');

// 9. 投票与复盘
const vote = await api(`/api/sessions/${sid}/vote`, { component_id: 'compiler' });
need(vote.correct === true && vote.review?.culprit_name, '投票正确并返回复盘数据');
const review = await api(`/api/sessions/${sid}/review`);
const rFields = ['culprit_explanation', 'explanation', 'truth_timeline', 'systemic_causes', 'data_flow', 'concept_summary', 'reflection_questions', 'concept_report', 'score', 'ending', 'player_role'];
need(rFields.every((f) => review[f] !== undefined), '复盘包含全部前端渲染字段');
need(Boolean(review.ending?.text && review.personal_ending), '复盘含总结局与身份结局');
need(review.timeline_result?.score === 100, '复盘含时间线成绩');
need(review.score.total_concepts === 7, '复盘成绩单覆盖 7 个知识点');
need(review.truth_timeline.length >= 5 && review.systemic_causes.length >= 4, '复盘含真实时间线与系统性原因');

console.log(failed ? '\n✗ 冒烟测试未全部通过' : '\n✓ 全部通过：网页端数据链路正常');
process.exitCode = failed ? 1 : 0;
