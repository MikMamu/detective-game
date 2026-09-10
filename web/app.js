// 主机城 · 教学版前端逻辑（零依赖）

const state = {
  sessionId: null,
  caseInfo: null,
  game: null,        // 服务端 stateView
  activeId: null,
  chats: {},         // component_id → [{from, text, kind}]
};

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const castById = (id) => state.caseInfo?.cast?.find((c) => c.id === id);

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const { case: caseInfo } = await api('/api/cases/featured');
    state.caseInfo = caseInfo;
    $('case-title').textContent = `《${caseInfo.title}》`;
    $('case-subtitle').textContent = `${caseInfo.subtitle} ｜ ${caseInfo.theme} ｜ 你是${caseInfo.player_role}`;
    $('case-opening').textContent = caseInfo.opening;
    const badge = $('mode-badge');
    badge.textContent = caseInfo.has_api_key ? 'AI 在线' : '离线模式';
    badge.classList.toggle('online', Boolean(caseInfo.has_api_key));

    const created = await api('/api/sessions', { case_id: caseInfo.case_id });
    state.sessionId = created.session_id;
    state.game = created.state;

    renderAll();
    const firstOther = caseInfo.cast.find((c) => c.id !== state.game.player_role?.id) || caseInfo.cast[0];
    selectComponent(firstOther.id);
  } catch (e) {
    $('case-title').textContent = '启动失败';
    $('case-opening').textContent = e.message;
  }
}

/* ---------------- 渲染 ---------------- */

function renderAll() {
  renderIdentity();
  renderComponents();
  renderScore();
  renderClues();
  renderCards();
  renderProgress();
}

function renderIdentity() {
  const box = $('identity-card');
  const me = state.game?.player_role;
  if (!box) return;
  box.innerHTML = '';
  if (!me) return;
  const head = el('div', 'id-head');
  const av = el('div', 'id-avatar', me.name.charAt(0));
  av.style.background = me.avatar_color || '#3b6fd4';
  const meta = el('div');
  meta.append(el('div', 'id-name', `${me.name} · ${me.component}`), el('div', 'id-sub', '你的身份（你就是这个部件）'));
  head.append(av, meta);
  box.appendChild(head);
  box.appendChild(el('div', 'id-row', `🎯 目标：${me.objective}`));
  box.appendChild(el('div', 'id-row', `⚖️ 处境：${me.stake}`));
  if (me.secrets?.length) {
    const s = el('div', 'id-secret');
    s.append(el('b', '', '你的秘密：'), document.createTextNode(me.secrets.join(' ')));
    box.appendChild(s);
  }
  box.appendChild(el('div', 'id-row', `📚 你的知识卡：${me.concept}（讲清自己的卡额外 +1 费曼点）`));
}

function renderScore() {
  const g = state.game;
  if (!g) return;
  $('feynman-points').textContent = g.feynman_points;
  const mastered = state.caseInfo.cast.filter((c) => {
    const e = g.explanations.find((x) => x.concept_id === c.knowledge_card.concept_id);
    return e && e.best_score >= 2;
  }).length;
  $('mastered-count').textContent = `${mastered}/${state.caseInfo.cast.length}`;
  const unlocked = g.private_clues.filter((c) => c.unlocked).length;
  $('clue-count').textContent = `${unlocked}/${g.private_clues.length}`;
}

function renderComponents() {
  const list = $('component-list');
  list.innerHTML = '';
  for (const c of state.caseInfo.cast) {
    const st = state.game.components.find((x) => x.id === c.id) || {};
    const exp = state.game.explanations.find((x) => x.concept_id === c.knowledge_card.concept_id);
    const isSelf = Boolean(st.is_self);
    const item = el('div', `comp-item${c.id === state.activeId ? ' active' : ''}${isSelf ? ' self' : ''}`);
    const avatar = el('div', 'avatar', c.name.charAt(0));
    avatar.style.background = c.avatar_color;
    const meta = el('div', 'comp-meta');
    meta.append(el('div', 'comp-name', `${c.name} · ${c.component}`), el('div', 'comp-role', c.role.split('·')[1]?.trim() || c.role));
    const badges = el('div', 'comp-badges');
    if (isSelf) badges.appendChild(el('span', 'mini done', '你自己'));
    if (st.secrets_found) badges.appendChild(el('span', 'mini secret', `秘密 ${st.secrets_found}/${st.secrets_total}`));
    if (exp && exp.best_score > 0) badges.appendChild(el('span', `mini${exp.best_score >= 2 ? ' done' : ''}`, `讲解 ${exp.best_score}/3`));
    item.append(avatar, meta, badges);
    if (!isSelf) item.onclick = () => selectComponent(c.id);
    list.appendChild(item);
  }
}

function renderClues() {
  const box = $('tab-clues');
  box.innerHTML = '';
  box.appendChild(el('div', 'sub', '公共线索（问对居民即可获得）'));
  for (const c of state.caseInfo.clues.public) {
    const unlocked = state.game.public_clues.some((x) => x.clue_id === c.clue_id);
    const full = state.game.public_clues.find((x) => x.clue_id === c.clue_id);
    const card = el('div', `clue${unlocked ? '' : ' locked'}`);
    const head = el('div', 'clue-title');
    head.append(el('span', '', unlocked ? `📄 ${c.title}` : `🔒 ${c.title}（未获得）`));
    card.appendChild(head);
    if (unlocked && full) card.appendChild(el('div', 'clue-body', full.content));
    box.appendChild(card);
  }
  box.appendChild(el('div', 'sub', `私人线索（费曼点兑换，当前 ${state.game.feynman_points} 点）`));
  for (const c of state.game.private_clues) {
    const card = el('div', `clue${c.unlocked ? '' : ' locked'}`);
    const head = el('div', 'clue-title');
    head.append(el('span', '', c.unlocked ? `🔑 ${c.title}` : `🔒 ${c.title}`));
    head.appendChild(el('span', c.unlocked ? 'unlocked-tag' : 'cost', c.unlocked ? '已获得' : `${c.cost} 点`));
    card.appendChild(head);
    if (c.unlocked) {
      card.appendChild(el('div', 'clue-body', c.content));
    } else {
      card.appendChild(el('div', 'clue-body', `提示：${c.unlock_hint || '与案情相关'}`));
      const btn = el('button', 'small', `用 ${c.cost} 点兑换`);
      btn.disabled = state.game.feynman_points < c.cost;
      btn.onclick = () => doUnlock(c.clue_id);
      card.appendChild(btn);
    }
    box.appendChild(card);
  }
}

function renderCards() {
  const box = $('tab-cards');
  box.innerHTML = '';
  box.appendChild(el('div', 'sub', '知识卡：把要点用自己的话讲清楚，才能拿分'));
  for (const c of state.caseInfo.cast) {
    const kc = c.knowledge_card;
    const rec = state.game.explanations.find((x) => x.concept_id === kc.concept_id);
    const card = el('div', 'kcard');
    const head = el('div', 'kc-head');
    head.append(el('div', 'kc-title', `${c.name} · ${kc.concept}`));
    const pill = el('span', `pill${rec && rec.best_score >= 2 ? ' good' : rec && rec.best_score === 1 ? ' mid' : ''}`,
      rec && rec.best_score > 0 ? `最高 ${rec.best_score}/3` : '未讲解');
    head.appendChild(pill);
    card.appendChild(head);
    const ol = el('ol');
    for (const p of kc.must_explain) ol.appendChild(el('li', '', p));
    card.appendChild(ol);
    if (kc.misconceptions?.length) {
      card.appendChild(el('div', 'kc-misc', `常见误区：${kc.misconceptions.join('；')}`));
    }
    const toggle = el('span', 'hint-toggle', '💡 想不出来类比？点这里看提示');
    const hint = el('div', 'kc-misc', `类比提示：${kc.analogy_hint}`);
    hint.style.display = 'none';
    toggle.onclick = () => {
      hint.style.display = hint.style.display === 'none' ? 'block' : 'none';
    };
    card.append(toggle, hint);
    const btn = el('button', 'small', '🎓 讲解这张卡');
    btn.style.marginTop = '8px';
    btn.onclick = () => openFeynmanModal(kc.concept_id);
    card.appendChild(btn);
    box.appendChild(card);
  }
}

function renderProgress() {
  const box = $('tab-progress');
  box.innerHTML = '';
  const g = state.game;
  box.appendChild(el('div', 'sub', '调查进度'));
  if (g.player_role) {
    const me = el('div', 'clue');
    me.appendChild(el('div', 'clue-title', `我的身份：${g.player_role.name}（${g.player_role.component}）`));
    me.appendChild(el('div', 'clue-body', `目标：${g.player_role.objective}`));
    box.appendChild(me);
  }
  const rep = el('div', 'clue');
  rep.appendChild(el('div', 'clue-title', '还原事故时间线'));
  rep.appendChild(
    el('div', 'clue-body', g.timeline?.submitted ? `已提交：${g.timeline.score}/100（${g.timeline.passed ? '合格' : '未合格'}）` : '未提交（结案前必须完成）'),
  );
  box.appendChild(rep);
  for (const c of g.components) {
    const card = el('div', 'clue');
    const head = el('div', 'clue-title');
    head.append(el('span', '', `${c.name} · ${c.component}`));
    card.appendChild(head);
    card.appendChild(
      el('div', 'clue-body', `${c.first_contact ? '已问过话' : '还没聊过'}｜秘密 ${c.secrets_found}/${c.secrets_total}`),
    );
    box.appendChild(card);
  }
  box.appendChild(el('div', 'sub', '费曼成绩单'));
  for (const e of g.explanations) {
    const card = el('div', 'clue');
    card.appendChild(el('div', 'clue-title', `${e.concept}（${e.component}）`));
    card.appendChild(
      el('div', 'clue-body', e.best_score > 0 ? `最高 ${e.best_score}/3，共讲 ${e.attempts} 次` : '还没讲过'),
    );
    box.appendChild(card);
  }
}

/* ---------------- 聊天 ---------------- */

function selectComponent(id) {
  const isSelf = state.game?.player_role?.id === id;
  if (isSelf) {
    selectComponent(state.caseInfo.cast.find((c) => c.id !== id)?.id);
    return;
  }
  state.activeId = id;
  const c = castById(id);
  $('chat-title').textContent = `正在和 ${c.name}（${c.component}）说话 · ${c.speech_style}`;
  renderComponents();
  const box = $('chat-messages');
  box.innerHTML = '';
  const log = state.chats[id] || [];
  if (!log.length) {
    box.appendChild(mkSys(`你走到${c.name}面前。${c.role}`, 'hint'));
  } else {
    for (const m of log) box.appendChild(mkMsg(m));
  }
  box.scrollTop = box.scrollHeight;
}

function mkMsg(m) {
  if (m.from === 'sys') return mkSys(m.text, m.kind);
  const div = el('div', `msg ${m.from === 'me' ? 'me' : 'comp'}`);
  const who = el('div', 'who', m.from === 'me' ? '你（调查员）' : castById(state.activeId)?.name || '');
  div.append(who, el('div', 'bubble', m.text));
  return div;
}

function mkSys(text, kind) {
  return el('div', `msg sys ${kind || ''}`, text);
}

function pushMsg(compId, from, text, kind) {
  const log = state.chats[compId] || (state.chats[compId] = []);
  const m = { from, text, kind };
  log.push(m);
  const box = $('chat-messages');
  if (compId === state.activeId) {
    box.appendChild(mkMsg(m));
    box.scrollTop = box.scrollHeight;
  }
}

/* ---------------- 动作 ---------------- */

function applyTurnResult(r) {
  const id = r.component_id;
  if (r.reply) pushMsg(id, 'comp', r.reply);
  for (const s of r.secrets_revealed || []) {
    pushMsg(id, 'sys', `🔓 ${r.component_name}说出了秘密：${s.content}`, 'secret');
  }
  if (r.public_clue) {
    pushMsg(id, 'sys', `📄 获得公共线索「${r.public_clue.title}」：${r.public_clue.content}`, 'clue');
  }
  for (const h of r.hints || []) pushMsg(id, 'sys', h, 'hint');
  if (r.state) state.game = r.state;
  renderAll();
}

async function doAsk() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  pushMsg(state.activeId, 'me', text);
  input.value = '';
  setBusy(true);
  try {
    const r = await api(`/api/sessions/${state.sessionId}/ask`, { component_id: state.activeId, text });
    applyTurnResult(r);
  } catch (e) {
    pushMsg(state.activeId, 'sys', `出错：${e.message}`, 'err');
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  $('btn-send').disabled = b;
  $('chat-input').disabled = b;
}

async function doPresent(clueId) {
  closeModal();
  const clue = [...(state.game.public_clues || []), ...state.game.private_clues.filter((c) => c.unlocked)]
    .find((c) => c.clue_id === clueId);
  pushMsg(state.activeId, 'me', `（出示线索：${clue?.title || clueId}）`);
  setBusy(true);
  try {
    const r = await api(`/api/sessions/${state.sessionId}/present`, { component_id: state.activeId, clue_id: clueId });
    applyTurnResult(r);
  } catch (e) {
    pushMsg(state.activeId, 'sys', `出错：${e.message}`, 'err');
  } finally {
    setBusy(false);
  }
}

async function doUnlock(clueId) {
  try {
    const r = await api(`/api/sessions/${state.sessionId}/unlock`, { clue_id: clueId });
    if (r.state) state.game = r.state;
    renderAll();
    const node = el('div');
    node.appendChild(el('div', 'fb-box good', `「${r.clue.title}」\n\n${r.clue.content}`));
    node.appendChild(el('p', 'sub', `剩余费曼点：${r.feynman_points}`));
    openModal('线索已解锁', node);
  } catch (e) {
    alert(e.message);
  }
}

function openPresentModal() {
  const wrap = el('div');
  const owned = [
    ...state.game.public_clues.map((c) => ({ ...c, kind: '公共' })),
    ...state.game.private_clues.filter((c) => c.unlocked).map((c) => ({ ...c, kind: '私人' })),
  ];
  if (!owned.length) {
    wrap.appendChild(el('p', 'sub', '你还没有任何线索。先去问问居民吧。'));
  }
  for (const c of owned) {
    const btn = el('button', '', `【${c.kind}】${c.title}`);
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.textAlign = 'left';
    btn.style.marginBottom = '6px';
    btn.onclick = () => doPresent(c.clue_id);
    wrap.appendChild(btn);
  }
  openModal(`把线索出示给 ${castById(state.activeId)?.name || ''}`, wrap);
}

/* ---------------- 费曼讲解 ---------------- */

function openFeynmanModal(preConceptId) {
  const options = state.caseInfo.cast
    .map((c) => `<option value="${c.knowledge_card.concept_id}"${c.knowledge_card.concept_id === preConceptId ? ' selected' : ''}>${c.name} · ${c.knowledge_card.concept}</option>`)
    .join('');
  const wrap = el('div');
  wrap.innerHTML = `
    <label>选择你要讲解的知识点（讲给完全不懂电脑的人听）</label>
    <select id="fy-concept">${options}</select>
    <div id="fy-card"></div>
    <label>你的讲解 —— 用大白话 + 一个生活里的比方</label>
    <textarea id="fy-text" placeholder="例如：缓存就像贴在显示器边上的便利贴……"></textarea>
    <div style="margin-top:10px"><button id="fy-submit" class="primary">提交给费曼判官</button>
    <span class="sub" id="fy-mode" style="margin-left:10px"></span></div>
    <div id="fy-result"></div>`;
  openModal('🎓 费曼讲解挑战', wrap);

  const renderCard = () => {
    const cid = $('fy-concept').value;
    const cast = state.caseInfo.cast.find((c) => c.knowledge_card.concept_id === cid);
    const box = $('fy-card');
    box.innerHTML = '';
    const card = el('div', 'kcard');
    card.appendChild(el('div', 'kc-title', `要点清单：${cast.knowledge_card.concept}`));
    const ol = el('ol');
    for (const p of cast.knowledge_card.must_explain) ol.appendChild(el('li', '', p));
    card.appendChild(ol);
    if (cast.knowledge_card.misconceptions?.length) {
      card.appendChild(el('div', 'kc-misc', `常见误区：${cast.knowledge_card.misconceptions.join('；')}`));
    }
    const toggle = el('span', 'hint-toggle', '💡 实在想不出类比？点这里');
    const hint = el('div', 'kc-misc', `类比提示：${cast.knowledge_card.analogy_hint}（别照抄，用自己的话说）`);
    hint.style.display = 'none';
    toggle.onclick = () => { hint.style.display = hint.style.display === 'none' ? 'block' : 'none'; };
    card.append(toggle, hint);
    box.appendChild(card);
  };
  renderCard();
  $('fy-concept').onchange = renderCard;

  $('fy-submit').onclick = async () => {
    const concept_id = $('fy-concept').value;
    const text = $('fy-text').value.trim();
    if (text.length < 5) { alert('先写点内容吧，哪怕两三句话'); return; }
    $('fy-submit').disabled = true;
    $('fy-result').innerHTML = '<p class="sub">判官正在阅读你的讲解…</p>';
    try {
      const r = await api(`/api/sessions/${state.sessionId}/explain`, { concept_id, text });
      if (r.state) state.game = r.state;
      renderAll();
      renderFeynmanResult(r);
      $('fy-text').value = '';
    } catch (e) {
      $('fy-result').innerHTML = `<div class="fb-box bad">出错：${e.message}</div>`;
    } finally {
      $('fy-submit').disabled = false;
    }
  };
}

function renderFeynmanResult(r) {
  const box = $('fy-result');
  const cls = r.score >= 3 ? 'good' : r.score === 2 ? 'mid' : 'bad';
  box.innerHTML = '';
  const card = el('div', `fb-box ${cls}`);
  const head = el('div');
  head.innerHTML = `<span class="score-big">${r.score}/3</span> <b>${r.concept}</b>
    <span class="sub">（本次 ${r.points_gained > 0 ? `+${r.points_gained} 费曼点` : '无新增费曼点（已有更高分）'}，当前共 ${r.feynman_points} 点）</span>`;
  card.appendChild(head);
  if (r.covered?.length) card.appendChild(el('div', '', `✅ 讲清楚了：${r.covered.join('；')}`));
  if (r.missed?.length) card.appendChild(el('div', '', `⚠️ 还没讲到：${r.missed.join('；')}`));
  if (r.jargon?.length) card.appendChild(el('div', '', `🚫 只是念了术语没解释：${r.jargon.join('、')}`));
  if (r.analogy_comment) card.appendChild(el('div', '', `🔍 类比点评：${r.analogy_comment}`));
  box.appendChild(card);

  const fb = el('div', `fb-box ${cls}`);
  fb.appendChild(el('div', '', `📝 ${r.feedback}`));
  if (r.followup_question) fb.appendChild(el('div', '', `❓ 追问：${r.followup_question}`));
  fb.appendChild(el('div', 'sub', `判分：${r.mode}${r.note ? `｜${r.note}` : ''}`));
  box.appendChild(fb);

  const again = el('button', '', '再讲一次（讲得更好可以拿更多点）');
  again.style.marginTop = '10px';
  again.onclick = () => { box.innerHTML = ''; $('fy-text').focus(); };
  box.appendChild(again);
}

/* ---------------- 还原事故时间线 ---------------- */

function openTimelineModal() {
  const task = state.game.timeline_task;
  if (!task) {
    openModal('还原时间线', el('div', 'modal-note', '本案件没有时间线任务。'));
    return;
  }
  const wrap = el('div');
  wrap.appendChild(el('p', 'sub', task.prompt));
  if (task.result) {
    wrap.appendChild(
      el(
        'div',
        `fb-box ${task.result.passed ? 'good' : 'mid'}`,
        `你已提交过：${task.result.score}/100（顺序 ${task.result.order_score}/60 ｜ 归因 ${task.result.actor_score}/40）${task.result.passed ? ' ✅ 合格' : ' ⚠️ 可以再来一次'}，共尝试 ${task.result.attempts} 次。`,
      ),
    );
  }
  wrap.appendChild(el('div', 'tl-hint', '① 点上方事件，按发生顺序排到下方；② 给每条选一个主要责任环节；③ 提交看结果（顺序 60 分 + 归因 40 分，80 分合格）。'));

  const pool = el('div', 'tl-pool');
  const list = el('div', 'tl-list');
  const submit = el('button', 'primary', '提交时间线');
  submit.style.marginTop = '12px';
  const out = el('div');
  wrap.append(pool, list, submit, out);

  const evById = new Map(task.events.map((e) => [e.id, e]));
  const order = [];
  const actorOf = {};

  const render = () => {
    pool.innerHTML = '';
    list.innerHTML = '';
    for (const e of task.events) {
      if (order.includes(e.id)) continue;
      const b = el('button', 'tl-item', e.text);
      b.onclick = () => {
        order.push(e.id);
        render();
      };
      pool.appendChild(b);
    }
    order.forEach((id, i) => {
      const e = evById.get(id);
      const row = el('div', 'tl-row');
      row.appendChild(el('span', 'tl-idx', String(i + 1)));
      const body = el('div', 'tl-body');
      body.appendChild(el('div', 'tl-text', e.text));
      const sel = document.createElement('select');
      sel.className = 'tl-select';
      sel.innerHTML =
        '<option value="">— 主要责任环节 —</option>' +
        task.actor_options.map((o) => `<option value="${o.id}"${actorOf[id] === o.id ? ' selected' : ''}>${o.label}</option>`).join('');
      sel.onchange = () => {
        actorOf[id] = sel.value;
      };
      body.appendChild(sel);
      row.appendChild(body);
      const ctrl = el('div', 'tl-ctrl');
      const up = el('button', 'small', '↑');
      up.disabled = i === 0;
      up.onclick = () => {
        [order[i - 1], order[i]] = [order[i], order[i - 1]];
        render();
      };
      const down = el('button', 'small', '↓');
      down.disabled = i === order.length - 1;
      down.onclick = () => {
        [order[i + 1], order[i]] = [order[i], order[i + 1]];
        render();
      };
      const del = el('button', 'small', '✕');
      del.onclick = () => {
        order.splice(i, 1);
        render();
      };
      ctrl.append(up, down, del);
      row.appendChild(ctrl);
      list.appendChild(row);
    });
  };
  render();

  submit.onclick = async () => {
    if (order.length !== task.events.length) {
      alert('还有事件没有排进时间线');
      return;
    }
    const placements = order.map((id, i) => ({ event_id: id, order: i, actor: actorOf[id] || '' }));
    submit.disabled = true;
    out.innerHTML = '';
    out.appendChild(el('p', 'sub', '正在比对主机城的原始日志…'));
    try {
      const r = await api(`/api/sessions/${state.sessionId}/timeline`, { placements });
      if (r.state) state.game = r.state;
      renderAll();
      renderTimelineResult(out, r);
    } catch (e) {
      out.innerHTML = '';
      out.appendChild(el('div', 'fb-box bad', e.message));
    } finally {
      submit.disabled = false;
    }
  };

  openModal('🧩 还原事故时间线', wrap);
}

function actorLabel(task, id) {
  return task?.actor_options?.find((o) => o.id === id)?.label || id;
}

function renderTimelineResult(box, r) {
  const task = state.game.timeline_task;
  box.innerHTML = '';
  const cls = r.passed ? 'good' : r.score >= 60 ? 'mid' : 'bad';
  const head = el('div', `fb-box ${cls}`);
  head.appendChild(
    el('div', '', `总分 ${r.score}/100（顺序 ${r.order_score}/60 ｜ 归因 ${r.actor_score}/40）${r.passed ? ' ✅ 合格' : ' ⚠️ 未达 80 分，可以再试一次'}`),
  );
  head.appendChild(el('div', '', `顺序排对 ${r.order_correct}/${r.total} 步；责任环节指认对 ${r.actor_correct}/${r.total} 步。`));
  if (r.key_link) head.appendChild(el('div', '', `★ ${r.key_link.note}`));
  box.appendChild(head);

  const sec = el('div', 'review-sec');
  sec.appendChild(el('h4', '', '正确的时间线'));
  const ol = el('ol', 'tl-truth');
  for (const e of r.correct_order) {
    const li = el('li');
    li.appendChild(el('div', 'tl-truth-text', e.text));
    li.appendChild(el('div', 'sub', e.why));
    ol.appendChild(li);
  }
  sec.appendChild(ol);
  box.appendChild(sec);

  const mine = el('div', 'review-sec');
  mine.appendChild(el('h4', '', '你的排序逐条点评'));
  const ul = el('ul');
  for (const d of r.details) {
    const li = el('li', d.order_ok && d.actor_ok ? '' : 'tl-wrong');
    li.appendChild(document.createTextNode(`${d.order_ok ? '✅ 顺序正确' : `❌ 顺序不对（应在第 ${d.correct_order + 1} 位）`}：${d.text}`));
    if (!d.actor_ok) li.appendChild(el('span', '', ` ｜ 责任环节应为：${actorLabel(task, d.correct_actor)}`));
    ul.appendChild(li);
  }
  mine.appendChild(ul);
  box.appendChild(mine);
}

/* ---------------- 投票与复盘 ---------------- */

function openVoteModal() {
  if (state.game.finished) { openReviewModal(); return; }
  if (!state.game.timeline?.submitted) {
    const wrap = el('div');
    wrap.appendChild(el('div', 'fb-box mid', '结案前请先还原《事故时间线》——光指认凶手不够，还要说清事故是怎么一步步发生的。'));
    const btn = el('button', 'primary', '🧩 现在去还原时间线');
    btn.style.marginTop = '10px';
    btn.onclick = () => { closeModal(); openTimelineModal(); };
    wrap.appendChild(btn);
    openModal('还差一步', wrap);
    return;
  }
  const wrap = el('div');
  wrap.appendChild(el('p', 'sub', `问题：${state.caseInfo.incident.question}（投票后不能改）`));
  wrap.appendChild(
    el(
      'p',
      'sub',
      '为什么只有 4 个选项？只有能接触「源码 → 编译 → 运行 → 通信」这条链路的部件，才有机会把后门放进源码。另外三位的故障属于「系统性原因」，会在复盘里逐条说明。',
    ),
  );
  for (const o of state.caseInfo.vote_options) {
    const btn = el('button', '', `指认 ${o.name}（${o.component}）`);
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.marginBottom = '8px';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api(`/api/sessions/${state.sessionId}/vote`, { component_id: o.id });
        if (r.state) state.game = r.state;
        renderAll();
        $('btn-review').disabled = false;
        renderVoteResult(r);
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
      }
    };
    wrap.appendChild(btn);
  }
  const others = state.caseInfo.cast.filter((c) => !state.caseInfo.vote_options.some((v) => v.id === c.id));
  if (others.length) {
    const sec = el('div', 'review-sec');
    sec.appendChild(el('h4', '', '不在指认范围的三位（他们的故障是助推因素，不是植入者）'));
    const ul = el('ul');
    for (const c of others) ul.appendChild(el('li', 'sub', `${c.name}（${c.component}）`));
    sec.appendChild(ul);
    wrap.appendChild(sec);
  }
  const out = el('div');
  out.id = 'vote-out';
  wrap.appendChild(out);
  openModal('🗳️ 投票指认', wrap);
}

function renderVoteResult(r) {
  const box = $('vote-out');
  if (!box) return;
  box.innerHTML = '';
  const banner = el('div', `result-banner ${r.correct ? 'right' : 'wrong'}`,
    r.correct ? '✅ 你指认对了！' : '❌ 你指认错了——真相往往比直觉复杂');
  box.appendChild(banner);
  const btn = el('button', 'primary', '📋 打开真相复盘');
  btn.onclick = openReviewModal;
  box.appendChild(btn);
}

async function openReviewModal() {
  try {
    const r = await api(`/api/sessions/${state.sessionId}/review`);
    const wrap = el('div');
    const banner = el('div', `result-banner ${r.correct ? 'right' : 'wrong'}`,
      r.correct ? `✅ 正确！真凶是 ${r.culprit_name}（${r.culprit_component}）` : `❌ 你指认了 ${r.vote_name}，真正的元凶是 ${r.culprit_name}（${r.culprit_component}）`);
    wrap.appendChild(banner);

    if (r.ending?.text) {
      const s = el('div', 'review-sec');
      s.appendChild(el('h4', '', '你的结局'));
      s.appendChild(el('div', `fb-box ${r.ending.key === 'wrong' || r.ending.key === 'scapegoat' ? 'bad' : 'good'}`, r.ending.text));
      if (r.player_role) {
        s.appendChild(el('p', 'sub', `你的身份：${r.player_role.name}（${r.player_role.component}）｜目标：${r.player_role.objective}`));
      }
      if (r.personal_ending) s.appendChild(el('p', '', `📌 ${r.personal_ending}`));
      wrap.appendChild(s);
    }

    if (r.timeline_result) {
      const s = el('div', 'review-sec');
      s.appendChild(el('h4', '', `你还原的时间线（${r.timeline_result.score}/100 ${r.timeline_result.passed ? '合格' : '未合格'}）`));
      s.appendChild(el('p', '', `顺序 ${r.timeline_result.order_score}/60 ｜ 责任环节归因 ${r.timeline_result.actor_score}/40 ｜ 共尝试 ${r.timeline_result.attempts} 次`));
      const wrong = (r.timeline_result.details || []).filter((d) => !d.order_ok);
      if (wrong.length) {
        const ul = el('ul');
        for (const d of wrong) ul.appendChild(el('li', 'tl-wrong', `${d.text} —— 应在第 ${d.correct_order + 1} 位`));
        s.appendChild(el('p', 'sub', '排错顺序的事件：'));
        s.appendChild(ul);
      } else {
        s.appendChild(el('p', 'sub', '事件顺序全部正确 ✓'));
      }
      wrap.appendChild(s);
    }

    const sec = (title, node) => {
      const s = el('div', 'review-sec');
      s.appendChild(el('h4', '', title));
      s.appendChild(node);
      return s;
    };

    wrap.appendChild(sec('真相', (() => {
      const d = el('div');
      d.appendChild(el('p', '', r.culprit_explanation));
      d.appendChild(el('p', '', r.explanation));
      if (r.real_world_hook) d.appendChild(el('p', 'sub', `延伸：${r.real_world_hook}`));
      return d;
    })()));

    wrap.appendChild(sec('真实时间线', (() => {
      const ol = el('ol');
      for (const x of r.truth_timeline) ol.appendChild(el('li', '', `${x.time} ${x.event}`));
      return ol;
    })()));

    wrap.appendChild(sec('这不是一个人的错：系统性原因', (() => {
      const ul = el('ul');
      for (const c of r.systemic_causes) ul.appendChild(el('li', '', c.cause));
      return ul;
    })()));

    wrap.appendChild(sec('数据流', (() => {
      const d = el('div', 'flow');
      r.data_flow.forEach((x, i) => {
        d.appendChild(el('span', '', x));
        if (i < r.data_flow.length - 1) d.appendChild(el('b', '', '→'));
      });
      return d;
    })()));

    wrap.appendChild(sec('知识清单', (() => {
      const ul = el('ul');
      for (const c of r.concept_summary) {
        const li = el('li');
        li.append(el('b', '', `${c.concept}：`), document.createTextNode(c.one_liner));
        ul.appendChild(li);
      }
      return ul;
    })()));

    wrap.appendChild(sec('你的费曼成绩单', (() => {
      const d = el('div');
      d.appendChild(el('p', '', `共赚得 ${r.score.feynman_earned} 费曼点，讲清 ${r.score.mastered_concepts}/${r.score.total_concepts} 个概念，解锁 ${r.score.clues_unlocked}/${r.score.clues_total} 条私人线索，问过 ${r.score.talked_components} 位居民，时间线还原 ${r.score.timeline_score}/100。`));
      const ul = el('ul');
      for (const c of r.concept_report) {
        const li = el('li');
        li.append(el('b', '', `${c.concept}：`));
        li.append(document.createTextNode(c.best_score >= 2 ? `讲清了（${c.best_score}/3）` : c.best_score === 1 ? '讲了一半（1/3），值得再讲一次' : '没讲（0/3）'));
        if (c.last_feedback) li.append(el('span', 'sub', ` — ${c.last_feedback}`));
        ul.appendChild(li);
      }
      d.appendChild(ul);
      return d;
    })()));

    wrap.appendChild(sec('课后追问（想清楚再回答）', (() => {
      const ol = el('ol');
      for (const q of r.reflection_questions) ol.appendChild(el('li', '', q));
      return ol;
    })()));

    openModal('📋 真相复盘', wrap);
  } catch (e) {
    alert(e.message);
  }
}

/* ---------------- 模态框 ---------------- */

function openModal(title, node) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = '';
  $('modal-body').appendChild(node);
  $('modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('modal-backdrop').classList.add('hidden');
}

/* ---------------- 事件 ---------------- */

function bind() {
  $('btn-send').onclick = doAsk;
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(); }
  });
  $('btn-present').onclick = openPresentModal;
  $('btn-feynman').onclick = () => openFeynmanModal();
  $('btn-timeline').onclick = openTimelineModal;
  $('btn-vote').onclick = openVoteModal;
  $('btn-review').onclick = openReviewModal;
  $('modal-close').onclick = closeModal;
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const name of ['clues', 'cards', 'progress']) {
        $(`tab-${name}`).classList.toggle('hidden', name !== tab.dataset.tab);
      }
    };
  });
}

bind();
init();
