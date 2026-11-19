/**
 * 依角色顯示的首頁
 * - 專案經理：專案健康（含原因）、進度、預算、逾期、預警、風險；KPI 可點開明細
 * - 組長：組內任務、組員負荷、逾期與阻塞
 * - 組員：今天／本週到期、逾期、阻塞或退回、我的任務（可直接回報進度）
 * - 新公司：顯示「開始使用」檢查清單，而不是一堆 0 和空圖表
 */
const Dash = (() => {
  const me = () => Auth.current();
  const isPM = () => me()?.role === '專案經理';
  const isLeader = () => me()?.role === '組長';
  const OPEN = (t) => !['完成', '取消'].includes(t.status);

  const baseOpts = (extra = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
    ...extra
  });
  const kTick = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString('zh-TW') + 'k' : v);
  const STATUS_COLOR = { '未開始': '#94a3b8', '進行中': '#2563eb', '阻塞': '#dc2626', '完成': '#059669', '取消': '#cbd5e1' };

  function noData(id, text) {
    const c = document.getElementById(id);
    if (c && c.parentElement) c.parentElement.innerHTML = `<div class="chart-empty">${U.esc(text)}</div>`;
  }

  function isOverdue(t) {
    return t.planned_end && OPEN(t) && t.planned_end < U.today();
  }
  function dueIn(t, days) {
    if (!t.planned_end || !OPEN(t)) return false;
    const d = U.daysBetween(U.today(), t.planned_end);
    return d >= 0 && d <= days;
  }
  const isReturned = (t) => ['退回', '已退回', '退件'].includes(t.review_status);

  // ---------- 專案健康：一定附上原因；沒有任務時不顯示燈號 ----------
  function health(o, tasks, alerts) {
    if (!tasks.length) return { level: null, label: '尚無資料', reasons: ['尚未建立任務，無法判斷'] };
    const gap = U.num(o.progress_gap);
    const overdue = tasks.filter(isOverdue).length;
    const blocked = tasks.filter((t) => t.status === '阻塞').length;
    const high = alerts.filter((a) => a.handle_status !== '已結案' && a.alert_level === '高').length;
    const reasons = [];
    if (gap < -0.0001) reasons.push(`整體進度落後 ${U.pct(-gap)}`);
    if (overdue) reasons.push(`逾期任務 ${overdue} 項`);
    if (blocked) reasons.push(`阻塞任務 ${blocked} 項`);
    if (high) reasons.push(`高等級預警 ${high} 則`);
    let level = '綠';
    if (gap <= -0.2 || overdue >= 5 || high > 0) level = '紅';
    else if (gap <= -0.1 || overdue > 0 || blocked > 0) level = '黃';
    if (!reasons.length) reasons.push('進度正常，沒有逾期與阻塞');
    return { level, label: level + '燈', reasons };
  }

  // ---------- KPI 卡片（按鈕，可點開明細） ----------
  function kpi({ key, label, value, sub = '', tone = '', hint = '', mine = false }) {
    return `<button type="button" class="kpi kpi-btn ${mine ? 'mine' : ''}" data-kpi="${key}" aria-label="${U.esc(label)}：${U.esc(String(value))}，點擊查看明細">
      <span class="kpi-label">${U.esc(label)}${hint ? `<span class="kpi-hint" title="${U.esc(hint)}">ⓘ</span>` : ''}</span>
      <span class="kpi-value ${tone}">${value}</span>
      <span class="kpi-sub">${sub}</span>
      <span class="kpi-more" aria-hidden="true">查看明細 →</span>
    </button>`;
  }

  // 任務清單（抽屜與首頁共用）
  function taskList(list, { showOwner = true, empty = '沒有符合的任務' } = {}) {
    if (!list.length) return `<div class="empty small-empty">${U.esc(empty)}</div>`;
    return `<ul class="task-list">${list.map((t) => {
      const over = isOverdue(t);
      const d = t.planned_end ? U.daysBetween(U.today(), t.planned_end) : null;
      const dueText = d === null ? '未設定截止日' : over ? `逾期 ${-d} 天` : d === 0 ? '今天到期' : `剩 ${d} 天`;
      return `<li>
        <button type="button" class="task-row" data-open-task="${U.esc(t.task_id)}">
          <span class="task-main">
            <span class="cell-title">${U.esc(t.name)}</span>
            <span class="muted small">${U.esc(t.task_id)}${showOwner ? '・' + U.esc(API.memberName(t.owner_id)) : ''}・${U.esc(API.campaignName(t.campaign_id))}</span>
            ${t.blocked_reason ? `<span class="small bad-text">阻塞：${U.esc(t.blocked_reason)}</span>` : ''}
            ${isReturned(t) ? '<span class="small bad-text">已被退回，請依意見修改</span>' : ''}
          </span>
          <span class="task-side">
            <span class="due ${over ? 'bad-text' : d !== null && d <= 1 ? 'warn-text' : ''}">${dueText}</span>
            ${U.progressBar(t.actual_progress, t.planned_progress)}
            ${U.chip(t.status)}
          </span>
        </button>
      </li>`;
    }).join('')}</ul>`;
  }

  function bindTaskOpen(scope, tasks) {
    scope.querySelectorAll('[data-open-task]').forEach((b) => {
      b.onclick = () => {
        const t = tasks.find((x) => x.task_id === b.dataset.openTask);
        if (t) Pages.openTaskModal(t, Pages.canEditTask(t));
      };
    });
  }

  function drawer(title, html, tasks = []) {
    const m = U.openDrawer({ title, body: html });
    bindTaskOpen(m, tasks);
    m.querySelectorAll('a[href^="#/"]').forEach((a) => a.addEventListener('click', () => U.closeModal()));
    return m;
  }

  // ---------- 新公司：開始使用 ----------
  function onboarding(el, { projects, camps, members, tasks }) {
    const steps = [
      { done: true, text: '建立公司', link: null },
      { done: projects.length > 0, text: '建立第一個專案', link: '#/projects', who: '專案經理、組長' },
      { done: camps.length > 0, text: '建立第一個行銷活動', link: '#/campaigns', who: '專案經理、組長' },
      { done: members.length > 1, text: '邀請成員加入', link: '#/accounts', who: '專案經理' },
      { done: tasks.length > 0, text: '建立第一個任務並指派', link: '#/tasks', who: '專案經理、組長' }
    ];
    const doneN = steps.filter((s) => s.done).length;
    el.innerHTML = `
      <section class="card welcome" aria-labelledby="ob-title">
        <h2 id="ob-title" class="h-section">👋 開始使用（已完成 ${doneN}／${steps.length}）</h2>
        <p class="muted">完成以下步驟後，首頁就會顯示專案進度、預算與預警。</p>
        <div class="progress-steps" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${doneN}">
          <div style="width:${(doneN / steps.length) * 100}%"></div>
        </div>
        <ol class="checklist">
          ${steps.map((s) => `<li class="${s.done ? 'done' : ''}">
            <span class="check-icon" aria-hidden="true">${s.done ? '✓' : ''}</span>
            <span class="check-text">${U.esc(s.text)}${s.done ? '<span class="sr-only">（已完成）</span>' : ''}</span>
            ${!s.done && s.link ? (isPM() || (isLeader() && s.who.includes('組長'))
              ? `<a class="btn small primary" href="${s.link}">前往</a>`
              : `<span class="muted small">由${U.esc(s.who)}完成</span>`) : ''}
          </li>`).join('')}
        </ol>
      </section>`;
  }

  // =====================================================================
  // 專案經理首頁
  // =====================================================================
  async function pm(el, d) {
    const { o, tasks, camps, work, alerts, metrics, risks, issues } = d;
    const h = health(o, tasks, alerts);
    const openAlerts = alerts.filter((a) => a.handle_status !== '已結案');
    const highAlerts = openAlerts.filter((a) => a.alert_level === '高');
    const overdue = tasks.filter(isOverdue).sort((a, b) => a.planned_end.localeCompare(b.planned_end));
    const behind = tasks.filter((t) => OPEN(t) && U.num(t.progress_gap) < -0.0001).sort((a, b) => U.num(a.progress_gap) - U.num(b.progress_gap));
    const myOpen = tasks.filter((t) => t.owner_id === me().member_id && OPEN(t));
    const usedRate = U.num(o.total_budget) > 0 ? U.num(o.used_budget) / U.num(o.total_budget) : null;
    const highRisks = risks.filter((r) => r.status !== '已結案' && r.risk_level === '高');
    const openIssues = issues.filter((i) => i.status !== '已解決');
    const gap = U.num(o.progress_gap);
    const hasProgress = tasks.length > 0;
    const roasTarget = API.roasTarget();

    el.innerHTML = `
      ${projectHead(o, h)}
      <section aria-label="關鍵指標" class="kpis">
        ${kpi({ key: 'progress', label: '整體實際進度', value: hasProgress ? U.pct(o.overall_actual_progress) : '—',
          sub: hasProgress ? `預計 ${U.pct(o.overall_planned_progress)}・<span class="${gap < 0 ? 'bad-text' : 'ok-text'}">落差 ${gap > 0 ? '+' : ''}${U.pct(gap)}</span>` : '尚無任務',
          hint: '所有任務實際進度的平均；落差＝實際－預計' })}
        ${kpi({ key: 'budget', label: '預算使用率', value: usedRate === null ? '—' : U.pct(usedRate), tone: usedRate > 0.9 ? 'bad-text' : '',
          sub: usedRate === null ? '尚未設定專案總預算' : `${U.money(o.used_budget)} / ${U.money(o.total_budget)}`,
          hint: '各活動實際支出加總 ÷ 專案總預算' })}
        ${kpi({ key: 'overdue', label: '逾期任務', value: overdue.length, tone: overdue.length ? 'bad-text' : '',
          sub: `未完成 ${U.int(o.open_tasks || 0)} 項`, hint: '預計完成日已過、且狀態不是完成或取消' })}
        ${kpi({ key: 'alerts', label: '待處理預警', value: openAlerts.length, tone: highAlerts.length ? 'bad-text' : '',
          sub: `其中高等級 ${highAlerts.length} 則`, hint: 'AI 預警中處理狀態不是「已結案」的數量' })}
        ${kpi({ key: 'risks', label: '高風險／未解決問題', value: `${highRisks.length}<span class="kpi-slash">/</span>${openIssues.length}`,
          sub: '風險 / 問題', hint: '風險等級為高且未結案；問題狀態不是已解決' })}
        ${kpi({ key: 'mine', label: '我的進行中任務', value: myOpen.length, mine: true,
          sub: `其中逾期 ${myOpen.filter(isOverdue).length} 項`, hint: '負責人是你、且未完成的任務' })}
      </section>

      <div class="grid g-3">
        <section class="card span-2" aria-labelledby="t-attn">
          <div class="card-head"><h2 id="t-attn" class="h-card">需要處理</h2><a href="#/tasks" class="small">全部任務 →</a></div>
          ${taskList([...overdue, ...behind.filter((t) => !isOverdue(t))].slice(0, 6), { empty: '目前沒有逾期或落後的任務 🎉' })}
        </section>
        <section class="card" aria-labelledby="t-alert">
          <div class="card-head"><h2 id="t-alert" class="h-card">待處理 AI 預警</h2><a href="#/alerts" class="small">全部 →</a></div>
          <ul class="mini-list">
            ${openAlerts.slice(0, 5).map((a) => `
              <li>${U.chip(a.alert_level || '—')}
                <div><b>${U.esc(a.alert_type || '預警')}</b><div class="muted small">${U.esc(a.task_id || a.campaign_id || '')}・${U.dateTime(a.alert_time)}</div></div></li>`).join('')
              || '<li class="muted">目前沒有待處理的預警</li>'}
          </ul>
        </section>
        <section class="card" aria-labelledby="t-status"><div class="card-head"><h2 id="t-status" class="h-card">任務狀態分布</h2></div><div class="chart-box"><canvas id="c-status" role="img" aria-label="任務狀態分布圖"></canvas></div></section>
        <section class="card span-2" aria-labelledby="t-budget"><div class="card-head"><h2 id="t-budget" class="h-card">各活動預算 vs 實際支出</h2></div><div class="chart-box"><canvas id="c-budget" role="img" aria-label="各活動預算與實際支出比較圖"></canvas></div></section>
        <section class="card span-2" aria-labelledby="t-trend"><div class="card-head"><h2 id="t-trend" class="h-card">每日營收與廣告花費</h2></div><div class="chart-box"><canvas id="c-trend" role="img" aria-label="每日營收與廣告花費趨勢圖"></canvas></div></section>
        <section class="card" aria-labelledby="t-roas"><div class="card-head"><h2 id="t-roas" class="h-card">各活動 ROAS</h2><span class="muted small">目標 ${roasTarget}</span></div><div class="chart-box"><canvas id="c-roas" role="img" aria-label="各活動 ROAS 與目標比較圖"></canvas></div></section>
        <section class="card span-3" aria-labelledby="t-work"><div class="card-head"><h2 id="t-work" class="h-card">組員本週負荷</h2><a href="#/members" class="small">詳細 →</a></div><div class="chart-box short"><canvas id="c-work" role="img" aria-label="組員本週工作負荷率圖"></canvas></div></section>
      </div>`;

    // 圖表
    const sc = U.groupCount(tasks, 'status');
    const sKeys = Object.keys(sc);
    if (!tasks.length) noData('c-status', '尚無任務');
    else U.chart('c-status', { type: 'doughnut', data: { labels: sKeys, datasets: [{ data: sKeys.map((k) => sc[k]), backgroundColor: sKeys.map((k, i) => STATUS_COLOR[k] || U.PALETTE[i % 8]) }] }, options: baseOpts({ cutout: '62%' }) });

    if (!camps.length) noData('c-budget', '尚無行銷活動');
    else U.chart('c-budget', {
      type: 'bar',
      data: { labels: camps.map((c) => c.name), datasets: [
        { label: '核定預算', data: camps.map((c) => U.num(c.approved_budget)), backgroundColor: '#c7d2fe' },
        { label: '實際支出', data: camps.map((c) => U.num(c.actual_spend)), backgroundColor: camps.map((c) => U.num(c.budget_usage_rate) > 1 ? '#dc2626' : '#4f46e5') }
      ] },
      options: baseOpts({ scales: { y: { ticks: { callback: kTick } } } })
    });

    const byDate = {};
    metrics.forEach((m) => { byDate[m.data_date] = byDate[m.data_date] || { rev: 0, spend: 0 }; byDate[m.data_date].rev += U.num(m.revenue); byDate[m.data_date].spend += U.num(m.ad_spend); });
    const dates = Object.keys(byDate).sort();
    if (!dates.length) noData('c-trend', '尚無成效資料');
    else U.chart('c-trend', {
      type: 'line',
      data: { labels: dates.map((x) => x.slice(5)), datasets: [
        { label: '歸因營收', data: dates.map((x) => byDate[x].rev), borderColor: '#059669', backgroundColor: 'rgba(5,150,105,.12)', fill: true, tension: 0.3 },
        { label: '廣告花費', data: dates.map((x) => byDate[x].spend), borderColor: '#d97706', backgroundColor: 'transparent', borderDash: [6, 4], tension: 0.3 }
      ] },
      options: baseOpts({ scales: { y: { ticks: { callback: kTick } } } })
    });

    const rc = camps.filter((c) => c.roas !== null);
    if (!rc.length) noData('c-roas', '尚無廣告成效資料');
    else U.chart('c-roas', {
      data: { labels: rc.map((c) => c.name), datasets: [
        { type: 'bar', label: 'ROAS', data: rc.map((c) => U.num(c.roas)), backgroundColor: rc.map((c) => U.num(c.roas) < roasTarget ? '#f87171' : '#34d399') },
        { type: 'line', label: '目標', data: rc.map(() => roasTarget), borderColor: '#334155', borderDash: [6, 4], pointRadius: 0 }
      ] },
      options: baseOpts()
    });

    Pages.drawWorkloadChart('c-work', work);
    bindTaskOpen(el, tasks);

    // KPI 明細抽屜
    const handlers = {
      progress: () => drawer('進度落後的任務', `<p class="muted small drawer-note">依落差由大到小排序。落差＝實際進度－預計進度。</p>${taskList(behind, { empty: '沒有進度落後的任務' })}`, tasks),
      budget: () => drawer('各活動預算使用', camps.length ? `<table class="table compact"><caption class="sr-only">各活動預算使用</caption>
          <thead><tr><th scope="col">活動</th><th scope="col">實際／核定</th><th scope="col">使用率</th></tr></thead>
          <tbody>${camps.map((c) => `<tr><td>${U.esc(c.name)}</td><td>${U.money(c.actual_spend)} / ${U.money(c.approved_budget)}</td>
            <td class="${U.num(c.budget_usage_rate) > 1 ? 'bad-text' : ''}">${U.pct(c.budget_usage_rate)}</td></tr>`).join('')}</tbody></table>
          <p class="drawer-actions"><a class="btn outline" href="#/campaigns">前往行銷活動 →</a></p>` : '<div class="empty small-empty">尚無行銷活動</div>'),
      overdue: () => drawer(`逾期任務（${overdue.length}）`, `<p class="muted small drawer-note">點選任務可查看詳情、調整期限或重新指派負責人。</p>${taskList(overdue, { empty: '沒有逾期任務 🎉' })}`, tasks),
      alerts: () => drawer(`待處理預警（${openAlerts.length}）`, `<ul class="mini-list">${openAlerts.map((a) => `<li>${U.chip(a.alert_level || '—')}<div><b>${U.esc(a.alert_type || '預警')}</b>
          <div class="muted small">${U.esc(a.task_id || '')}・處理人 ${U.esc(API.memberName(a.handler_id))}・${U.dateTime(a.alert_time)}</div></div></li>`).join('') || '<li class="muted">沒有待處理預警</li>'}</ul>
          <p class="drawer-actions"><a class="btn outline" href="#/alerts">前往 AI 預警處理 →</a></p>`),
      risks: () => drawer('高風險與未解決問題', `<h3 class="h-sub">高風險（${highRisks.length}）</h3>
          <ul class="mini-list">${highRisks.map((r) => `<li>${U.chip(r.risk_level)}<div><b>${U.esc(r.name)}</b><div class="muted small">分數 ${U.esc(r.risk_score)}・負責 ${U.esc(API.memberName(r.owner_id))}・期限 ${U.date(r.response_due)}</div></div></li>`).join('') || '<li class="muted">沒有高風險</li>'}</ul>
          <h3 class="h-sub">未解決問題（${openIssues.length}）</h3>
          <ul class="mini-list">${openIssues.map((i) => `<li>${U.chip(i.severity)}<div><b>${U.esc(i.name)}</b><div class="muted small">負責 ${U.esc(API.memberName(i.owner_id))}${i.overdue_days > 0 ? `・<span class="bad-text">逾期 ${i.overdue_days} 天</span>` : ''}</div></div></li>`).join('') || '<li class="muted">沒有未解決問題</li>'}</ul>
          <p class="drawer-actions"><a class="btn outline" href="#/risks">前往風險與問題 →</a></p>`),
      mine: () => drawer(`我的進行中任務（${myOpen.length}）`, taskList(myOpen, { showOwner: false, empty: '你目前沒有進行中的任務' }), tasks)
    };
    el.querySelectorAll('[data-kpi]').forEach((b) => { b.onclick = () => handlers[b.dataset.kpi] && handlers[b.dataset.kpi](); });
  }

  function projectHead(o, h) {
    const cls = h.level === '紅' ? 'bad' : h.level === '黃' ? 'warn' : h.level === '綠' ? 'ok' : 'none';
    return `<section class="project-head" aria-label="專案摘要">
      <div>
        <div class="ph-id">${U.esc(o.project_id || '')}</div>
        <h2 class="ph-name">${U.esc(o.name || '尚無專案資料')}</h2>
        <div class="ph-meta">${U.date(o.start_date)} → ${U.date(o.planned_end_date)}・負責人 ${U.esc(o.owner_name || '—')}</div>
      </div>
      <div class="health ${cls}" role="status">
        <span class="health-title">專案健康</span>
        <b>${h.level ? `<span aria-hidden="true">●</span> ` : ''}${U.esc(h.label)}</b>
        <ul class="health-reasons">${h.reasons.map((r) => `<li>${U.esc(r)}</li>`).join('')}</ul>
      </div>
    </section>`;
  }

  // =====================================================================
  // 組長首頁
  // =====================================================================
  async function leader(el, d) {
    const { o, tasks, work, alerts } = d;
    const myId = me().member_id;
    const teamIds = new Set((API.cache.members || []).filter((m) => m.leader_id === myId).map((m) => m.member_id));
    teamIds.add(myId);
    const teamTasks = tasks.filter((t) => teamIds.has(t.owner_id));
    const open = teamTasks.filter(OPEN);
    const overdue = open.filter(isOverdue);
    const week = open.filter((t) => dueIn(t, 7));
    const blocked = open.filter((t) => t.status === '阻塞' || isReturned(t));
    const teamWork = work.filter((w) => teamIds.has(w.member_id));
    const teamAlerts = alerts.filter((a) => a.handle_status !== '已結案' && (teamIds.has(a.handler_id) || teamTasks.some((t) => t.task_id === a.task_id)));
    const h = health(o, tasks, alerts);
    const sorted = [...open].sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.planned_end || '9').localeCompare(String(b.planned_end || '9')));

    el.innerHTML = `
      ${projectHead(o, h)}
      <section aria-label="組內關鍵指標" class="kpis kpis-4">
        ${kpi({ key: 'open', label: '組內進行中任務', value: open.length, sub: `組員 ${teamIds.size - 1} 人＋你`, hint: '負責人是你或你的直屬組員、且未完成' })}
        ${kpi({ key: 'overdue', label: '組內逾期', value: overdue.length, tone: overdue.length ? 'bad-text' : '', sub: '需要協助或調整期限', hint: '預計完成日已過' })}
        ${kpi({ key: 'week', label: '7 天內到期', value: week.length, tone: week.length ? 'warn-text' : '', sub: '本週需要追蹤', hint: '預計完成日在今天到 7 天內' })}
        ${kpi({ key: 'blocked', label: '阻塞／被退回', value: blocked.length, tone: blocked.length ? 'bad-text' : '', sub: '需要排除障礙', hint: '狀態為阻塞，或審核被退回' })}
      </section>
      <div class="grid g-3">
        <section class="card span-2" aria-labelledby="l-tasks">
          <div class="card-head"><h2 id="l-tasks" class="h-card">組內任務（依急迫程度）</h2><a href="#/tasks" class="small">全部任務 →</a></div>
          ${taskList(sorted.slice(0, 8), { empty: teamIds.size > 1 ? '組內目前沒有進行中的任務' : '你還沒有直屬組員，請專案經理在「成員與帳號」設定直屬組長' })}
        </section>
        <section class="card" aria-labelledby="l-alerts">
          <div class="card-head"><h2 id="l-alerts" class="h-card">組內預警</h2><a href="#/alerts" class="small">全部 →</a></div>
          <ul class="mini-list">${teamAlerts.slice(0, 5).map((a) => `<li>${U.chip(a.alert_level || '—')}<div><b>${U.esc(a.alert_type || '預警')}</b><div class="muted small">${U.esc(a.task_id || '')}・${U.esc(API.memberName(a.handler_id))}</div></div></li>`).join('') || '<li class="muted">組內沒有待處理預警</li>'}</ul>
        </section>
        <section class="card span-3" aria-labelledby="l-work">
          <div class="card-head"><h2 id="l-work" class="h-card">組員本週負荷</h2><a href="#/members" class="small">詳細 →</a></div>
          <div class="chart-box short"><canvas id="c-work" role="img" aria-label="組員本週工作負荷率圖"></canvas></div>
        </section>
      </div>`;

    Pages.drawWorkloadChart('c-work', teamWork);
    bindTaskOpen(el, tasks);
    const handlers = {
      open: () => drawer(`組內進行中任務（${open.length}）`, taskList(sorted), tasks),
      overdue: () => drawer(`組內逾期任務（${overdue.length}）`, `<p class="muted small drawer-note">點選任務可調整期限或重新指派。</p>${taskList(overdue, { empty: '沒有逾期任務 🎉' })}`, tasks),
      week: () => drawer(`7 天內到期（${week.length}）`, taskList(week, { empty: '7 天內沒有到期任務' }), tasks),
      blocked: () => drawer(`阻塞／被退回（${blocked.length}）`, taskList(blocked, { empty: '沒有阻塞或被退回的任務' }), tasks)
    };
    el.querySelectorAll('[data-kpi]').forEach((b) => { b.onclick = () => handlers[b.dataset.kpi] && handlers[b.dataset.kpi](); });
  }

  // =====================================================================
  // 組員首頁
  // =====================================================================
  async function member(el, d) {
    const { tasks } = d;
    const myId = me().member_id;
    const mine = tasks.filter((t) => t.owner_id === myId);
    const open = mine.filter(OPEN);
    const todayList = open.filter((t) => dueIn(t, 0));
    const overdue = open.filter(isOverdue);
    const week = open.filter((t) => dueIn(t, 7));
    const attention = open.filter((t) => t.status === '阻塞' || isReturned(t));
    const sorted = [...open].sort((a, b) => (isOverdue(b) - isOverdue(a)) || String(a.planned_end || '9').localeCompare(String(b.planned_end || '9')));
    const doneWeek = mine.filter((t) => t.status === '完成' && t.actual_end && U.daysBetween(t.actual_end, U.today()) <= 7).length;

    el.innerHTML = `
      <section class="greeting" aria-label="今日摘要">
        <h2 class="h-section">${U.esc(me().name)}，你好</h2>
        <p class="muted">${todayList.length || overdue.length
          ? `今天有 <b>${todayList.length}</b> 項到期${overdue.length ? `，另有 <b class="bad-text">${overdue.length}</b> 項已逾期` : ''}。`
          : open.length ? '今天沒有到期的任務，可以先處理本週的工作。' : '目前沒有指派給你的任務。'}</p>
      </section>
      <section aria-label="我的任務指標" class="kpis kpis-4">
        ${kpi({ key: 'today', label: '今天到期', value: todayList.length, tone: todayList.length ? 'warn-text' : '', sub: '優先完成', mine: true })}
        ${kpi({ key: 'overdue', label: '已逾期', value: overdue.length, tone: overdue.length ? 'bad-text' : '', sub: '請更新進度或回報困難' })}
        ${kpi({ key: 'week', label: '7 天內到期', value: week.length, sub: '本週工作' })}
        ${kpi({ key: 'attention', label: '阻塞／被退回', value: attention.length, tone: attention.length ? 'bad-text' : '', sub: '需要協助或修改' })}
      </section>
      <div class="grid g-3">
        <section class="card span-2" aria-labelledby="m-tasks">
          <div class="card-head"><h2 id="m-tasks" class="h-card">我的任務</h2><span class="muted small">點選任務即可回報進度</span></div>
          ${taskList(sorted, { showOwner: false, empty: '目前沒有指派給你的任務' })}
        </section>
        <section class="card" aria-labelledby="m-stat">
          <div class="card-head"><h2 id="m-stat" class="h-card">本週成果</h2></div>
          <div class="stat-big"><b>${doneWeek}</b><span>項任務完成</span></div>
          <p class="muted small">進行中 ${open.length} 項・全部 ${mine.length} 項</p>
          <a class="btn outline block" href="#/tasks">查看全部任務</a>
        </section>
      </div>`;

    bindTaskOpen(el, tasks);
    const handlers = {
      today: () => drawer(`今天到期（${todayList.length}）`, taskList(todayList, { showOwner: false, empty: '今天沒有到期任務' }), tasks),
      overdue: () => drawer(`已逾期（${overdue.length}）`, taskList(overdue, { showOwner: false, empty: '沒有逾期任務 🎉' }), tasks),
      week: () => drawer(`7 天內到期（${week.length}）`, taskList(week, { showOwner: false, empty: '7 天內沒有到期任務' }), tasks),
      attention: () => drawer(`阻塞／被退回（${attention.length}）`, taskList(attention, { showOwner: false, empty: '沒有阻塞或被退回的任務' }), tasks)
    };
    el.querySelectorAll('[data-kpi]').forEach((b) => { b.onclick = () => handlers[b.dataset.kpi] && handlers[b.dataset.kpi](); });
  }

  // =====================================================================
  // 入口
  // =====================================================================
  async function render(el) {
    const names = ['專案總覽', '任務', '活動', '負荷', '預警', '成效', '風險', '問題'];
    const [ovAll, tasksAll, campsAll, work, alertsAll, metricsAll, risksAll, issuesAll] = await Promise.all([
      API.q.projectOverview(), API.q.tasks(), API.q.campaignSummary(), API.q.workload(),
      API.q.alerts(), API.q.metrics(), API.q.risks(), API.q.issues()
    ]).then((rs) => rs.map((r, i) => API.check(r, '讀取' + names[i])));

    const pid = API.currentProjectId();
    const projects = API.cache.projects || [];
    const members = API.cache.members || [];

    // 新公司：還缺專案、活動、成員或任務 → 顯示開始使用清單（組員除外）
    const needOnboarding = !pid || (!campsAll.length && !tasksAll.length);
    if (needOnboarding && me().role !== '組員') {
      return onboarding(el, { projects, camps: campsAll, members, tasks: tasksAll });
    }

    const o = ovAll.find((p) => p.project_id === pid) || {};
    const campIds = new Set(campsAll.filter((c) => c.project_id === pid).map((c) => c.campaign_id));
    const inProject = (x) => !x.campaign_id || campIds.has(x.campaign_id);
    const data = {
      o,
      tasks: tasksAll.filter(inProject),
      camps: campsAll.filter((c) => campIds.has(c.campaign_id)),
      work,
      alerts: alertsAll.filter(inProject),
      metrics: metricsAll.filter((m) => campIds.has(m.campaign_id)),
      risks: risksAll.filter(inProject),
      issues: issuesAll
    };

    if (isPM()) return pm(el, data);
    if (isLeader()) return leader(el, data);
    // 組員看所有專案中「自己的」任務
    return member(el, { tasks: tasksAll });
  }

  return { render, health, isOverdue };
})();
