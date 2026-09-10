// 桌游包生成：把教学案件渲染成可打印的 HTML（角色卡 / 线索卡 / DM 手册 + 真相复盘）
// 用法：node src/cli.js pack --case cases/zero-one.json --out pack-zero-one.html

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const CSS = `
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1a1a1a; margin: 0; padding: 24px; background: #f5f5f2; }
h1 { font-size: 26px; margin: 0 0 6px; }
h2 { font-size: 20px; margin: 28px 0 12px; border-left: 6px solid #c9a45c; padding-left: 10px; }
h3 { font-size: 16px; margin: 0 0 8px; }
.sub { color: #666; margin-bottom: 18px; }
.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.card { background: #fff; border: 2px solid #333; border-radius: 10px; padding: 16px; break-inside: avoid; }
.card.role { border-color: #c9a45c; }
.card.clue { border-style: dashed; }
.card.dm { border-color: #4a6fa5; background: #f7faff; }
.tag { display: inline-block; font-size: 12px; background: #eee; border-radius: 999px; padding: 2px 10px; margin-right: 6px; }
.secret { background: #fff6f6; border-left: 4px solid #d96c5f; padding: 8px 10px; margin: 8px 0; font-size: 13.5px; }
.kc { background: #f6fbf6; border-left: 4px solid #7fb98a; padding: 8px 10px; margin: 8px 0; font-size: 13.5px; }
ol, ul { margin: 6px 0 6px 20px; padding: 0; font-size: 13.5px; line-height: 1.7; }
p { font-size: 13.5px; line-height: 1.75; margin: 6px 0; }
.small { font-size: 12px; color: #777; }
.timeline li { margin-bottom: 4px; }
@media print {
  body { background: #fff; padding: 0; }
  .card { page-break-inside: avoid; }
  .page-break { page-break-before: always; }
}
`;

export function buildPackHtml(caseData) {
  const cast = caseData.cast || [];
  const pub = caseData.clues?.public || [];
  const priv = caseData.clues?.private || [];
  const t = caseData.truth || {};

  const roleCards = cast
    .map(
      (c) => `
  <div class="card role">
    <h3>${esc(c.name)} · ${esc(c.component)}</h3>
    <div class="small">${esc(c.role)}</div>
    <p><b>性格与说话方式：</b>${esc(c.persona)}<br><span class="small">${esc(c.speech_style)}</span></p>
    <div class="kc">
      <b>知识卡：${esc(c.knowledge_card.concept)}</b>
      <ol>${(c.knowledge_card.must_explain || []).map((p) => `<li>${esc(p.point)}</li>`).join('')}</ol>
      <div class="small">类比提示：${esc(c.knowledge_card.analogy_hint)}</div>
    </div>
    <div class="secret">
      <b>你的秘密（别主动说）：</b>
      <ul>${(c.secrets || []).map((s) => `<li>${esc(s.content)}<br><span class="small">解锁条件：${esc(s.unlock_hint || '被问到关键点')}</span></li>`).join('')}</ul>
    </div>
    <p><b>你的任务：</b>${esc(c.as_player?.objective || '把知识卡讲给至少两名玩家听懂，并为自己辩解。')}<br>
    　　<span class="small">你的处境：${esc(c.as_player?.stake || '别人对你的印象，取决于你讲不讲得清。')}</span><br>
    　　<span class="small">${c.id === t.direct_culprit ? '⚠️ 你是内鬼：尽量把怀疑引向别人，但被证据锁死时要承认。' : '找出真正动了手脚的人。'}</span></p>
  </div>`,
    )
    .join('');

  const clueCards = [...pub.map((c) => ({ ...c, kind: '公共线索（第一轮公开）', cost: null })), ...priv.map((c) => ({ ...c, kind: '私人线索（费曼点兑换）' }))]
    .map(
      (c) => `
  <div class="card clue">
    <h3>${esc(c.title)}</h3>
    <div><span class="tag">${esc(c.kind)}</span>${c.cost ? `<span class="tag">需要 ${c.cost} 费曼点</span>` : ''}</div>
    <p>${esc(c.content)}</p>
    ${c.unlock_hint ? `<div class="small">提示：${esc(c.unlock_hint)}</div>` : ''}
    ${c.from ? `<div class="small">来源：${esc(c.from)}</div>` : ''}
  </div>`,
    )
    .join('');

  const timeline = (t.timeline || [])
    .map((x) => `<li><b>${esc(x.time)}</b> ${esc(x.event)}</li>`)
    .join('');
  const causes = (t.systemic_causes || []).map((x) => `<li>${esc(x.cause)}</li>`).join('');
  const flow = (caseData.review?.data_flow || []).join(' → ');
  const concepts = (caseData.review?.concept_summary || [])
    .map((c) => `<li><b>${esc(c.concept)}</b>：${esc(c.one_liner)}</li>`)
    .join('');
  const questions = (caseData.review?.reflection_questions || []).map((q) => `<li>${esc(q)}</li>`).join('');
  const teacherNotes = (caseData.review?.teacher_notes || []).map((q) => `<li>${esc(q)}</li>`).join('');
  const voteCards = (caseData.vote_options || [])
    .map((id) => {
      const c = cast.find((x) => x.id === id);
      return `<div class="card clue" style="text-align:center"><h3>投票：${esc(c?.name || id)}（${esc(c?.component || '')}）</h3><p class="small">把这张卡投进票箱就代表你指认他</p></div>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(caseData.title)} · 桌游包</title><style>${CSS}</style></head>
<body>
  <h1>《${esc(caseData.title)}》桌游包</h1>
  <div class="sub">${esc(caseData.subtitle || '')} ｜ 主题：${esc(caseData.theme || '')} ｜ 人数：${cast.length} 人 + 1 名 DM ｜ 时长：2.5–3 小时</div>
  <div class="card dm">
    <h3>DM 开场词（照着念）</h3>
    <p>${esc(caseData.opening)}</p>
    <p><b>调查目标：</b>${esc(caseData.incident.question)}<br>
    <b>时间：</b>${esc(caseData.incident.time)}<br>
    <b>规则：</b>${esc(caseData.rules?.feynman || '')} ${esc(caseData.rules?.spend || '')}</p>
  </div>

  <h2>一、角色卡（每人一张，只给自己看）</h2>
  <div class="grid">${roleCards}</div>

  <div class="page-break"></div>
  <h2>二、线索卡（公共线索第一轮发；私人线索用费曼点兑换）</h2>
  <div class="grid">${clueCards}</div>

  <div class="page-break"></div>
  <h2>三、DM 手册</h2>
  <div class="card dm">
    <h3>流程（建议时长）</h3>
    <ol>
      <li><b>开场（10 分钟）</b>：念开场词，讲清费曼规则——<b>禁止念术语，必须用生活类比讲明白</b>。</li>
      <li><b>第一轮 · 费曼自我介绍（30 分钟）</b>：每人 2 分钟讲自己的知识卡；其他人给"听懂/没听懂"；听懂人数 = 费曼点。</li>
      <li><b>第二轮 · 线索与私聊（40 分钟）</b>：用费曼点兑换私人线索；公聊对时间线。DM 可追问"你说的'工作台'对应什么？"答错扣 1 点。</li>
      <li><b>第三轮 · 费曼挑战（30 分钟）</b>：每人向两名非本领域玩家讲一个概念，成功获得投票权重。</li>
      <li><b>投票与揭晓（20 分钟）</b>：<u>每人先交一份《事故分析报告》（150–300 字：①事故怎么一步步发生的 ②哪一环最关键 ③只能修一个环节，你修哪个、为什么）</u>，再投票。
        投票选项：${(caseData.vote_options || []).map((id) => esc(cast.find((c) => c.id === id)?.name || id)).join(' / ')}
        <br><span class="small">说明：只有能接触「源码 → 编译 → 运行 → 通信」链路的部件才有机会植入后门；其余部件（${cast.filter((c) => !(caseData.vote_options || []).includes(c.id)).map((c) => esc(c.name)).join('、')}）的故障属于系统性原因，在复盘中逐条说明。</span></li>
      <li><b>费曼复盘（≥30 分钟，必做）</b>：见下。</li>
    </ol>
  </div>

  <div class="card dm">
    <h3>真相（DM 专用）</h3>
    <p><b>直接元凶：</b>${esc(cast.find((c) => c.id === t.direct_culprit)?.name || t.direct_culprit)}（${esc(cast.find((c) => c.id === t.direct_culprit)?.component || '')}）</p>
    <p>${esc(t.culprit_explanation)}</p>
    <h3>真实时间线</h3>
    <ol class="timeline">${timeline}</ol>
    <h3>系统性原因（复盘重点：不是一个人的错）</h3>
    <ul>${causes}</ul>
    <p>${esc(t.explanation)}</p>
    <p class="small">延伸：${esc(t.real_world_hook || '')}</p>
  </div>

  <div class="card dm">
    <h3>费曼复盘环节（必做）</h3>
    <ol>
      <li>每人用 1 分钟向"小学生"解释一个概念，不能出现 CPU、RAM、TCP 等术语。</li>
      <li>其他人可提问，讲不清就重讲——<b>讲不清的地方就是教学起点</b>。</li>
      <li>一起画出数据流：<b>${esc(flow)}</b></li>
    </ol>
    <h3>知识清单</h3>
    <ul>${concepts}</ul>
    <h3>反思问题</h3>
    <ul>${questions}</ul>
    <h3>教学提示</h3>
    <ul>${teacherNotes}</ul>
  </div>

  <h2>四、投票卡（打印后裁开）</h2>
  <div class="grid">${voteCards}</div>
  <p class="small">生成时间：${new Date().toLocaleString('zh-CN')} ｜ 由 detective-game 教学版自动生成</p>
</body></html>`;
}
