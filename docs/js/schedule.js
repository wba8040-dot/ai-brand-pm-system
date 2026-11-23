/**
 * 活動日程：列表／日曆（月、週）／甘特圖
 *
 * 顯示內容（依目前選擇的專案過濾）：
 *   - 行銷活動：計畫開始～計畫結束
 *   - 任務：預計開始～預計完成（截止日）
 *   - 里程碑：預計完成日
 *   - AI 預警：建議處理期限（未結案者）
 *   - 到期提醒：逾期、今天到期、7 天內到期、日程衝突
 *
 * 權限（與資料庫 RLS／觸發器一致，資料庫仍是最後防線）：
 *   - 專案經理：所有活動、任務、里程碑都可拖曳調整日期
 *   - 組長：可拖曳活動、里程碑，以及自己或直屬組員負責的任務
 *   - 組員：只能檢視（資料庫也禁止組員修改任務計畫日期）
 *
 * 拖曳寫入使用樂觀鎖（version）；異動由資料庫 audit_log 觸發器自動留下紀錄。
 * 鍵盤替代操作：在甘特圖的長條上按 ← → 移動一天、Shift + ← → 調整結束日、Enter 開啟明細。
 */
const Schedule = (() => {
  const me = () => Auth.current();
  const isPM = () => me()?.role === '專案經理';
  const isLeaderOrPM = () => ['專案經理', '組長'].includes(me()?.role);
  const OPEN_TASK = (t) => !['完成', '取消'].includes(t.status);

  // 類型：顏色之外一定搭配形狀與文字，不只靠顏色辨識（WCAG 1.4.1）
  const KIND = {
    campaign:  { label: '行銷活動', glyph: '▬' },
    task:      { label: '任務',     glyph: '■' },
    milestone: { label: '里程碑',   glyph: '◆' },
    alert:     { label: '預警',     glyph: '▲' }
  };
  const VIEWS = { list: '列表', calendar: '日曆', gantt: '甘特圖' };
  const ZOOMS = { day: '日', week: '週', month: '月' };
  const PX = { day: 32, week: 14, month: 5 };      // 每一天的寬度（像素）
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  // 畫面狀態保留在模組內：自動重新整理或存檔後重畫時，不會跳回預設
  const state = {
    view: null,
    calMode: 'month',
    cursor: null,
    zoom: 'day',
    kinds: { campaign: true, task: true, milestone: true, alert: true },
    owner: '',
    mine: false,
    hideDone: false,
    focus: null,            // 到期提醒的快速篩選：overdue／today／week／conflict
    ganttScroll: null,
    listLimit: 80
  };

  let data = null;          // 最近一次載入的資料（開啟明細時使用）
  let itemsAll = [];        // 最近一次組好的全部事項

  // ---------------------------------------------------------------------
  // 資料載入與整理
  // ---------------------------------------------------------------------
  async function load() {
    const [tasksR, campsR, msR, alertsR, collabR] = await Promise.all([
      API.q.tasks(), API.q.campaigns(), API.q.milestones(), API.q.alerts(),
      API.sb.from('task_collaborators').select('task_id')
        .eq('member_id', me().member_id).eq('is_deleted', false)
    ]);
    const tasks = API.check(tasksR, '讀取任務');
    const camps = API.check(campsR, '讀取活動');
    const milestones = API.check(msR, '讀取里程碑');
    const alerts = API.check(alertsR, '讀取預警');
    const collab = new Set((collabR.data || []).map((c) => c.task_id));

    const pid = API.currentProjectId();
    const campsP = camps.filter((c) => c.project_id === pid);
    const campIds = new Set(campsP.map((c) => c.campaign_id));
    // 與首頁相同規則：沒有關聯活動的資料視為全公司共用，每個專案都顯示
    const inProject = (x) => !x.campaign_id || campIds.has(x.campaign_id);
    return {
      camps: campsP,
      tasks: tasks.filter(inProject),
      milestones: milestones.filter(inProject),
      alerts: alerts.filter(inProject),
      collab
    };
  }

  /** 把各種資料轉成統一的「事項」格式，並檢查日程衝突 */
  function buildItems(d) {
    const today = U.today();
    const items = [];
    const campById = Object.fromEntries(d.camps.map((c) => [c.campaign_id, c]));
    const taskById = Object.fromEntries(d.tasks.map((t) => [t.task_id, t]));

    d.camps.forEach((c) => {
      const s = c.planned_start || c.planned_end || null;
      const e = c.planned_end || c.planned_start || null;
      const done = ['已完成', '已取消'].includes(c.status);
      items.push({
        kind: 'campaign', id: c.campaign_id, title: c.name, start: s, end: e,
        owner: c.owner_id, status: c.status || '—', raw: c, done,
        overdue: !done && e && e < today, group: c.campaign_id,
        draggable: isLeaderOrPM(), conflicts: []
      });
    });

    d.tasks.forEach((t) => {
      const e = t.planned_end || t.planned_start || null;
      const s = t.planned_start || t.planned_end || null;
      const open = OPEN_TASK(t);
      const conflicts = [];
      const c = campById[t.campaign_id];
      if (open && c) {
        if (c.planned_end && e && e > c.planned_end) conflicts.push(`截止日晚於活動「${c.name}」的結束日 ${c.planned_end}`);
        if (c.planned_start && s && s < c.planned_start) conflicts.push(`開始日早於活動「${c.name}」的開始日 ${c.planned_start}`);
      }
      if (open && s) {
        String(t.predecessor_ids || '').split(/[,，、\s]+/).filter(Boolean).forEach((pid) => {
          const p = taskById[pid];
          if (p && OPEN_TASK(p) && p.planned_end && s <= p.planned_end) {
            conflicts.push(`前置任務 ${pid} 預計 ${p.planned_end} 完成，本任務卻排在 ${s} 開始`);
          }
        });
      }
      items.push({
        kind: 'task', id: t.task_id, title: t.name, start: s, end: e,
        owner: t.owner_id, status: t.status || '—', raw: t, done: !open,
        overdue: open && e && e < today, group: t.campaign_id || '',
        progress: U.num(t.actual_progress),
        // 組員不能改計畫日期（資料庫觸發器也會擋）
        draggable: isLeaderOrPM() && Pages.canEditTask(t, d.collab),
        conflicts
      });
    });

    d.milestones.forEach((m) => {
      const dt = m.planned_end || null;
      const done = m.acceptance_status === '通過' || !!m.actual_end;
      const c = campById[m.campaign_id];
      const conflicts = [];
      if (!done && c && c.planned_end && dt && dt > c.planned_end) conflicts.push(`預計完成日晚於活動「${c.name}」的結束日 ${c.planned_end}`);
      items.push({
        kind: 'milestone', id: m.milestone_id, title: m.name, start: dt, end: dt,
        owner: null, status: m.acceptance_status || '未驗收', raw: m, done,
        overdue: !done && dt && dt < today, group: m.campaign_id || '',
        draggable: isLeaderOrPM(), conflicts
      });
    });

    d.alerts.filter((a) => a.handle_status !== '已結案' && a.suggested_due).forEach((a) => {
      const t = taskById[a.task_id];
      items.push({
        kind: 'alert', id: a.alert_id, title: `${a.alert_type || '預警'}${t ? '｜' + t.name : ''}`,
        start: a.suggested_due, end: a.suggested_due, owner: a.handler_id,
        status: a.handle_status || '待處理', level: a.alert_level, raw: a, done: false,
        overdue: a.suggested_due < today, group: a.campaign_id || t?.campaign_id || '',
        taskId: a.task_id || null, draggable: false, conflicts: []
      });
    });
    return items;
  }

  function filtered(items) {
    const mine = me().member_id;
    return items.filter((i) =>
      state.kinds[i.kind]
      && (!state.owner || i.owner === state.owner)
      && (!state.mine || i.owner === mine)
      && (!state.hideDone || !i.done));
  }

  const FOCUS = {
    overdue:  { label: '已逾期',   test: (i) => i.overdue },
    today:    { label: '今天到期', test: (i) => !i.done && i.end === U.today() },
    week:     { label: '7 天內到期', test: (i) => !i.done && i.end > U.today() && i.end <= U.addDays(U.today(), 7) },
    conflict: { label: '日程衝突', test: (i) => i.conflicts.length > 0 }
  };

  // ---------------------------------------------------------------------
  // 主畫面
  // ---------------------------------------------------------------------
  async function render(el) {
    // 甘特圖捲動位置：重畫前先記下
    const sc = el.querySelector('#g-scroll');
    if (sc) state.ganttScroll = { left: sc.scrollLeft, top: sc.scrollTop };

    data = await load();
    if (!state.view) state.view = window.matchMedia('(max-width: 640px)').matches ? 'list' : 'gantt';
    if (!state.cursor) state.cursor = U.today();

    itemsAll = buildItems(data);
    const items = filtered(itemsAll);
    const members = (API.cache.members || []).filter((m) => m.status !== '離職');
    const counts = Object.fromEntries(Object.keys(FOCUS).map((k) => [k, items.filter(FOCUS[k].test).length]));

    el.innerHTML = `
      <div class="sched-toolbar">
        <div class="seg" role="group" aria-label="檢視方式">
          ${Object.entries(VIEWS).map(([k, v]) => `<button type="button" class="seg-btn" data-view="${k}" aria-pressed="${state.view === k}">${v}</button>`).join('')}
        </div>
        <div class="sched-actions">
          <button type="button" class="btn ghost small" id="btn-ics" title="下載 .ics 檔，可匯入 Google 日曆、Outlook、Apple 行事曆">⤓ 匯出行事曆</button>
          ${isLeaderOrPM() ? '<button type="button" class="btn primary small" id="btn-new-ms">＋ 新增里程碑</button>' : ''}
        </div>
      </div>

      <div class="sched-filters card">
        <fieldset class="kind-toggles">
          <legend class="sr-only">顯示類型</legend>
          ${Object.entries(KIND).map(([k, v]) => `<label class="kind-chip k-${k}">
            <input type="checkbox" data-kind="${k}" ${state.kinds[k] ? 'checked' : ''}>
            <span class="kind-glyph" aria-hidden="true">${v.glyph}</span>${v.label}</label>`).join('')}
        </fieldset>
        <label class="inline-field">負責人
          <select id="f-owner">${U.options(members.map((m) => m.member_id), state.owner, { blank: true, labels: Object.fromEntries(members.map((m) => [m.member_id, m.name])) })}</select>
        </label>
        <label class="check"><input type="checkbox" id="f-mine" ${state.mine ? 'checked' : ''}> 只看我的</label>
        <label class="check"><input type="checkbox" id="f-hide-done" ${state.hideDone ? 'checked' : ''}> 隱藏已完成</label>
      </div>

      <div class="remind-strip" role="group" aria-label="到期提醒（點選可在列表中篩選）">
        ${Object.entries(FOCUS).map(([k, v]) => `<button type="button" class="remind r-${k}" data-focus="${k}"
            aria-pressed="${state.focus === k}" ${counts[k] ? '' : 'data-zero="1"'}>
            <span class="remind-n">${counts[k]}</span><span class="remind-l">${v.label}</span></button>`).join('')}
      </div>

      <div id="sched-body" class="sched-body"></div>
      <div class="sr-only" aria-live="polite" id="sched-live"></div>`;

    const body = el.querySelector('#sched-body');
    if (state.view === 'list') listView(body, items);
    else if (state.view === 'calendar') calendarView(body, items);
    else ganttView(body, items);

    bindToolbar(el);
  }

  function bindToolbar(el) {
    const rerender = () => App.renderPage();
    el.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => { state.view = b.dataset.view; rerender(); };
    });
    el.querySelectorAll('[data-kind]').forEach((c) => {
      c.onchange = () => { state.kinds[c.dataset.kind] = c.checked; rerender(); };
    });
    el.querySelector('#f-owner').onchange = (e) => { state.owner = e.target.value; rerender(); };
    el.querySelector('#f-mine').onchange = (e) => { state.mine = e.target.checked; rerender(); };
    el.querySelector('#f-hide-done').onchange = (e) => { state.hideDone = e.target.checked; rerender(); };
    el.querySelectorAll('[data-focus]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.focus;
        state.focus = state.focus === k ? null : k;
        state.view = 'list';
        rerender();
      };
    });
    const ms = el.querySelector('#btn-new-ms');
    if (ms) ms.onclick = () => openMilestoneModal(null);
    el.querySelector('#btn-ics').onclick = () => exportIcs(filtered(itemsAll));
  }

  // ---------------------------------------------------------------------
  // 1. 列表
  // ---------------------------------------------------------------------
  function listView(body, items) {
    const today = U.today();
    const week = U.addDays(today, 7);
    let rows = items.slice();
    if (state.focus) rows = rows.filter(FOCUS[state.focus].test);

    const GROUPS = [
      ['overdue', '已逾期'], ['today', '今天'], ['week', '未來 7 天'],
      ['later', '之後'], ['done', '已完成／已過'], ['nodate', '未排日期']
    ];
    const groupOf = (i) => {
      if (!i.end) return 'nodate';
      if (i.overdue) return 'overdue';
      if (i.done || i.end < today) return 'done';
      if (i.end === today) return 'today';
      if (i.end <= week) return 'week';
      return 'later';
    };
    rows.sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999') || a.kind.localeCompare(b.kind));
    const total = rows.length;
    rows = rows.slice(0, state.listLimit);
    const by = {};
    rows.forEach((i) => { (by[groupOf(i)] = by[groupOf(i)] || []).push(i); });

    if (!total) {
      body.innerHTML = `<div class="empty card">${state.focus ? `目前沒有「${FOCUS[state.focus].label}」的事項 🎉` : emptyText()}</div>`;
      return;
    }

    body.innerHTML = `
      ${state.focus ? `<div class="focus-bar">篩選中：<b>${FOCUS[state.focus].label}</b>
        <button type="button" class="link-btn" id="btn-clear-focus">清除篩選</button></div>` : ''}
      ${GROUPS.filter(([k]) => by[k]).map(([k, label]) => `
        <section class="card no-pad list-group lg-${k}">
          <h3 class="list-group-h">${label}<span class="muted small">（${by[k].length}）</span></h3>
          <div class="table-wrap"><table class="table">
            <caption class="sr-only">${label}的事項</caption>
            <thead><tr><th style="width:110px">類型</th><th>名稱</th><th style="width:200px">日期</th><th>負責人</th><th>狀態</th><th style="width:110px">剩餘</th></tr></thead>
            <tbody>${by[k].map(rowHtml).join('')}</tbody>
          </table></div>
        </section>`).join('')}
      ${total > rows.length ? `<div class="more-row"><button type="button" class="btn outline" id="btn-more">顯示更多（還有 ${total - rows.length} 筆）</button></div>` : ''}`;

    body.querySelectorAll('tr[data-key]').forEach((tr) => {
      tr.onclick = () => openItem(findItem(tr.dataset.key));
    });
    U.rowsA11y(body);
    const clr = body.querySelector('#btn-clear-focus');
    if (clr) clr.onclick = () => { state.focus = null; App.renderPage(); };
    const more = body.querySelector('#btn-more');
    if (more) more.onclick = () => { state.listLimit += 80; App.renderPage(); };
  }

  function rowHtml(i) {
    const left = i.end && !i.done ? U.daysBetween(U.today(), i.end) : null;
    const leftTxt = left === null ? '—'
      : left < 0 ? `<span class="bad-text">逾期 ${-left} 天</span>`
      : left === 0 ? '<span class="warn-text">今天</span>' : `${left} 天`;
    const dateTxt = !i.start ? '未排日期' : i.start === i.end ? U.date(i.end) : `${U.date(i.start)} ～ ${U.date(i.end)}`;
    return `<tr class="clickable ${i.done ? 'is-done' : ''}" data-key="${keyOf(i)}">
      <td><span class="kind-tag k-${i.kind}"><span aria-hidden="true">${KIND[i.kind].glyph}</span>${KIND[i.kind].label}</span></td>
      <td><div class="cell-title">${U.esc(i.title)}</div>
        ${i.conflicts.length ? `<div class="conflict-note" title="${U.esc(i.conflicts.join('\n'))}">⚠ ${U.esc(i.conflicts[0])}${i.conflicts.length > 1 ? `（另 ${i.conflicts.length - 1} 項）` : ''}</div>` : ''}
        ${i.kind !== 'campaign' && i.group ? `<div class="muted small">${U.esc(API.campaignName(i.group))}</div>` : ''}</td>
      <td class="nowrap">${dateTxt}</td>
      <td>${i.owner ? U.esc(API.memberName(i.owner)) : '—'}</td>
      <td>${U.chip(i.kind === 'alert' && i.level ? i.level : i.status)}</td>
      <td class="nowrap">${leftTxt}</td>
    </tr>`;
  }

  // ---------------------------------------------------------------------
  // 2. 日曆（月／週）
  // ---------------------------------------------------------------------
  /** 日曆上每一天要顯示的事件：活動顯示開始與結束、任務顯示截止、里程碑與預警顯示當天 */
  function eventsByDay(items) {
    const map = {};
    const add = (d, i, tag) => { if (d) (map[d] = map[d] || []).push({ i, tag }); };
    items.forEach((i) => {
      if (i.kind === 'campaign') {
        add(i.start, i, i.start === i.end ? '' : '開始');
        if (i.end !== i.start) add(i.end, i, '結束');
      } else if (i.kind === 'task') {
        add(i.end, i, '截止');
      } else {
        add(i.end, i, '');
      }
    });
    const order = { milestone: 0, alert: 1, task: 2, campaign: 3 };
    Object.values(map).forEach((arr) => arr.sort((a, b) => order[a.i.kind] - order[b.i.kind]));
    return map;
  }

  function calendarView(body, items) {
    const cur = state.cursor;
    const today = U.today();
    const dow = (d) => new Date(d + 'T00:00:00').getDay();
    let start; let days; let title;
    if (state.calMode === 'month') {
      const first = cur.slice(0, 8) + '01';
      const [y, m] = first.split('-').map(Number);
      const dim = new Date(y, m, 0).getDate();
      start = U.addDays(first, -dow(first));
      days = Math.ceil((dow(first) + dim) / 7) * 7;
      title = `${y} 年 ${m} 月`;
    } else {
      start = U.addDays(cur, -dow(cur));
      days = 7;
      const end = U.addDays(start, 6);
      title = `${start.replace(/-/g, '/')} ～ ${end.slice(5).replace('-', '/')}`;
    }
    const ev = eventsByDay(items);
    const month = cur.slice(0, 7);
    const maxShow = state.calMode === 'month' ? 3 : 50;

    const cells = [];
    for (let k = 0; k < days; k++) {
      const d = U.addDays(start, k);
      const list = ev[d] || [];
      const outside = state.calMode === 'month' && d.slice(0, 7) !== month;
      const wd = dow(d);
      cells.push(`<div class="cal-cell ${outside ? 'outside' : ''} ${d === today ? 'is-today' : ''} ${wd === 0 || wd === 6 ? 'weekend' : ''}" role="gridcell">
        <button type="button" class="cal-date" data-day="${d}"
          aria-label="${Number(d.slice(5, 7))} 月 ${Number(d.slice(8))} 日（星期${WEEKDAYS[wd]}），${list.length ? list.length + ' 個事項' : '沒有事項'}${d === today ? '，今天' : ''}">
          ${state.calMode === 'week' ? `<span class="cal-wd">週${WEEKDAYS[wd]}</span>` : ''}${Number(d.slice(8))}</button>
        <ul class="cal-events">
          ${list.slice(0, maxShow).map(({ i, tag }) => `<li><button type="button" class="ev k-${i.kind} ${i.overdue ? 'is-overdue' : ''} ${i.done ? 'is-done' : ''} ${i.conflicts.length ? 'has-conflict' : ''}"
              data-key="${keyOf(i)}" title="${U.esc(KIND[i.kind].label + (tag ? '（' + tag + '）' : '') + '：' + i.title)}">
              <span class="ev-glyph" aria-hidden="true">${KIND[i.kind].glyph}</span>
              <span class="ev-text">${tag ? `<b>${tag}</b> ` : ''}${U.esc(i.title)}</span></button></li>`).join('')}
          ${list.length > maxShow ? `<li><button type="button" class="ev-more" data-day="${d}">＋${list.length - maxShow} 更多</button></li>` : ''}
        </ul>
        ${list.length ? `<div class="ev-dots" aria-hidden="true">${list.slice(0, 4).map(({ i }) => `<i class="k-${i.kind}"></i>`).join('')}${list.length > 4 ? '<b>…</b>' : ''}</div>` : ''}
      </div>`);
    }

    body.innerHTML = `
      <div class="card cal">
        <div class="cal-head">
          <div class="cal-nav">
            <button type="button" class="icon-btn" id="cal-prev" aria-label="上一${state.calMode === 'month' ? '個月' : '週'}">‹</button>
            <h3 class="cal-title" aria-live="polite">${title}</h3>
            <button type="button" class="icon-btn" id="cal-next" aria-label="下一${state.calMode === 'month' ? '個月' : '週'}">›</button>
            <button type="button" class="btn small ghost" id="cal-today">今天</button>
          </div>
          <div class="seg small" role="group" aria-label="日曆範圍">
            <button type="button" class="seg-btn" data-cal="month" aria-pressed="${state.calMode === 'month'}">月</button>
            <button type="button" class="seg-btn" data-cal="week" aria-pressed="${state.calMode === 'week'}">週</button>
          </div>
        </div>
        <div class="cal-grid ${state.calMode}" role="grid" aria-label="${title}日曆">
          <div class="cal-wdays" role="row">${WEEKDAYS.map((w) => `<div role="columnheader">${w}</div>`).join('')}</div>
          <div class="cal-days" role="row">${cells.join('')}</div>
        </div>
      </div>`;

    const step = state.calMode === 'month' ? null : 7;
    const move = (dir) => {
      if (step) state.cursor = U.addDays(state.cursor, dir * step);
      else {
        const [y, m] = state.cursor.split('-').map(Number);
        const d = new Date(y, m - 1 + dir, 1);
        state.cursor = d.toLocaleDateString('sv-SE');
      }
      App.renderPage();
    };
    body.querySelector('#cal-prev').onclick = () => move(-1);
    body.querySelector('#cal-next').onclick = () => move(1);
    body.querySelector('#cal-today').onclick = () => { state.cursor = U.today(); App.renderPage(); };
    body.querySelectorAll('[data-cal]').forEach((b) => { b.onclick = () => { state.calMode = b.dataset.cal; App.renderPage(); }; });
    body.querySelectorAll('.ev[data-key]').forEach((b) => { b.onclick = () => openItem(findItem(b.dataset.key)); });
    body.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => openDay(b.dataset.day, ev[b.dataset.day] || []); });
  }

  function openDay(d, list) {
    const wd = WEEKDAYS[new Date(d + 'T00:00:00').getDay()];
    const m = U.openDrawer({
      title: `${d.replace(/-/g, '/')}（${wd}）`,
      dirtyCheck: false,
      body: list.length ? `<ul class="day-list">${list.map(({ i, tag }) => `<li>
          <button type="button" class="day-item k-${i.kind}" data-key="${keyOf(i)}">
            <span class="kind-tag k-${i.kind}"><span aria-hidden="true">${KIND[i.kind].glyph}</span>${KIND[i.kind].label}${tag ? '・' + tag : ''}</span>
            <span class="day-title">${U.esc(i.title)}</span>
            <span class="muted small">${i.owner ? U.esc(API.memberName(i.owner)) + '・' : ''}${U.esc(i.kind === 'alert' && i.level ? i.level : i.status)}</span>
            ${i.conflicts.length ? `<span class="conflict-note">⚠ ${U.esc(i.conflicts[0])}</span>` : ''}
          </button></li>`).join('')}</ul>`
        : '<p class="muted">這一天沒有事項。</p>',
      footer: `<span class="spacer"></span>
        ${isLeaderOrPM() ? '<button type="button" class="btn outline" id="day-new-ms">＋ 在這天新增里程碑</button>' : ''}
        <button type="button" class="btn ghost" data-cancel>關閉</button>`
    });
    m.querySelectorAll('[data-key]').forEach((b) => {
      b.onclick = () => { const it = findItem(b.dataset.key); U.closeModal(); setTimeout(() => openItem(it), 0); };
    });
    const nm = m.querySelector('#day-new-ms');
    if (nm) nm.onclick = () => { U.closeModal(); setTimeout(() => openMilestoneModal(null, d), 0); };
  }

  // ---------------------------------------------------------------------
  // 3. 甘特圖（可拖曳）
  // ---------------------------------------------------------------------
  function ganttView(body, items) {
    const dated = items.filter((i) => i.start && i.end);
    const undated = items.length - dated.length;
    if (!dated.length) {
      body.innerHTML = `<div class="empty card">${items.length ? '目前顯示的事項都還沒有排日期，請先在任務或活動中填入日期。' : emptyText()}</div>`;
      return;
    }
    const px = PX[state.zoom];
    const today = U.today();
    let min = dated.reduce((a, i) => (i.start < a ? i.start : a), today);
    let max = dated.reduce((a, i) => (i.end > a ? i.end : a), today);
    min = U.addDays(min, -7);
    max = U.addDays(max, 14);
    // 對齊：週檢視從星期日開始、月檢視從 1 號開始
    if (state.zoom === 'week') min = U.addDays(min, -new Date(min + 'T00:00:00').getDay());
    if (state.zoom === 'month') min = min.slice(0, 8) + '01';
    const totalDays = U.daysBetween(min, max) + 1;
    const width = totalDays * px;
    const xOf = (d) => U.daysBetween(min, d) * px;

    // ---- 時間刻度 ----
    const months = [];
    const ticks = [];
    for (let k = 0; k < totalDays; k++) {
      const d = U.addDays(min, k);
      const day = Number(d.slice(8));
      if (k === 0 || day === 1) months.push({ x: k * px, label: `${d.slice(0, 4)}/${Number(d.slice(5, 7))}` });
      const wd = new Date(d + 'T00:00:00').getDay();
      if (state.zoom === 'day') ticks.push(`<div class="g-tick ${wd === 0 || wd === 6 ? 'we' : ''} ${d === today ? 'td' : ''}" style="left:${k * px}px;width:${px}px">${day}</div>`);
      else if (state.zoom === 'week' && wd === 0) ticks.push(`<div class="g-tick" style="left:${k * px}px;width:${px * 7}px">${Number(d.slice(5, 7))}/${day}</div>`);
    }
    const weekends = state.zoom === 'day'
      ? Array.from({ length: totalDays }, (_, k) => {
        const wd = new Date(U.addDays(min, k) + 'T00:00:00').getDay();
        return wd === 0 || wd === 6 ? `<div class="g-we" style="left:${k * px}px;width:${px}px"></div>` : '';
      }).join('')
      : '';

    // ---- 依活動分組：活動列 → 該活動的里程碑與任務；預警標在對應任務或活動那一列 ----
    const alerts = items.filter((i) => i.kind === 'alert');
    const alertsOn = (rowKind, id) => alerts.filter((a) => (rowKind === 'task' ? a.taskId === id : !a.taskId && a.group === id));
    const groups = [];
    const campOrder = data.camps.slice().sort((a, b) => (a.planned_start || '9999').localeCompare(b.planned_start || '9999'));
    const byStart = (a, b) => (a.start || '9999').localeCompare(b.start || '9999');
    campOrder.forEach((c) => {
      const campItem = items.find((i) => i.kind === 'campaign' && i.id === c.campaign_id);
      const children = items.filter((i) => (i.kind === 'task' || i.kind === 'milestone') && i.group === c.campaign_id).sort(byStart);
      const loose = alertsOn('campaign', c.campaign_id);
      if (campItem || children.length || loose.length) groups.push({ id: c.campaign_id, name: c.name, campItem, children, loose });
    });
    const orphan = items.filter((i) => (i.kind === 'task' || i.kind === 'milestone') && (!i.group || !data.camps.some((c) => c.campaign_id === i.group))).sort(byStart);
    const orphanAlerts = alerts.filter((a) => !a.taskId && (!a.group || !data.camps.some((c) => c.campaign_id === a.group)));
    if (orphan.length || orphanAlerts.length) groups.push({ id: '', name: '未歸屬活動', campItem: null, children: orphan, loose: orphanAlerts });

    const barHtml = (i) => {
      if (!i.start || !i.end) return '<span class="g-nodate muted small">未排日期</span>';
      const tip = `${KIND[i.kind].label}「${i.title}」，${i.start === i.end ? i.end : i.start + ' 至 ' + i.end}，${i.status}`
        + (i.overdue ? '，已逾期' : '') + (i.conflicts.length ? '，有日程衝突' : '')
        + (i.draggable ? '。可拖曳調整；方向鍵移動一天，Shift 加方向鍵調整結束日' : '');
      const cls = `g-bar k-${i.kind} ${i.draggable ? 'can-drag' : ''} ${i.overdue ? 'is-overdue' : ''} ${i.done ? 'is-done' : ''} ${i.conflicts.length ? 'has-conflict' : ''}`;
      if (i.kind === 'milestone') {
        return `<div class="${cls}" style="left:${xOf(i.end) + px / 2 - 9}px" data-key="${keyOf(i)}" tabindex="0" role="button" aria-label="${U.esc(tip)}" title="${U.esc(tip)}"></div>
          <span class="g-text" style="left:${xOf(i.end) + px / 2 + 12}px">${U.esc(i.title)}</span>`;
      }
      const w = Math.max(px, (U.daysBetween(i.start, i.end) + 1) * px);
      const inside = w >= 90;
      return `<div class="${cls}" style="left:${xOf(i.start)}px;width:${w}px" data-key="${keyOf(i)}" tabindex="0" role="button" aria-label="${U.esc(tip)}" title="${U.esc(tip)}">
          ${i.kind === 'task' ? `<span class="g-fill" style="width:${Math.round(Math.min(1, i.progress || 0) * 100)}%"></span>` : ''}
          ${inside ? `<span class="g-in">${U.esc(i.title)}</span>` : ''}
          ${i.draggable ? '<span class="g-h g-h-l" aria-hidden="true"></span><span class="g-h g-h-r" aria-hidden="true"></span>' : ''}
        </div>${inside ? '' : `<span class="g-text" style="left:${xOf(i.start) + w + 6}px">${U.esc(i.title)}</span>`}`;
    };
    const alertMarks = (list) => list.map((a) => `<button type="button" class="g-alert lv-${U.esc(a.level || '中')} ${a.overdue ? 'is-overdue' : ''}" style="left:${xOf(a.end) + px / 2 - 8}px"
        data-key="${keyOf(a)}" aria-label="預警「${U.esc(a.title)}」，處理期限 ${a.end}" title="預警：${U.esc(a.title)}（期限 ${a.end}）">▲</button>`).join('');

    const rows = [];
    groups.forEach((g) => {
      const ci = g.campItem;
      rows.push(`<div class="g-row g-group">
        <div class="g-label">${ci ? `<button type="button" class="g-name" data-key="${keyOf(ci)}"><span class="kind-glyph k-campaign" aria-hidden="true">▬</span>${U.esc(g.name)}</button>`
          : `<span class="g-name plain">${U.esc(g.name)}</span>`}</div>
        <div class="g-track">${ci ? barHtml(ci) : ''}${alertMarks(g.loose)}</div></div>`);
      g.children.forEach((i) => {
        rows.push(`<div class="g-row ${i.done ? 'is-done' : ''}">
          <div class="g-label"><button type="button" class="g-name child" data-key="${keyOf(i)}">
            <span class="kind-glyph k-${i.kind}" aria-hidden="true">${KIND[i.kind].glyph}</span><span class="g-name-t">${U.esc(i.title)}</span>
            ${i.owner ? `<span class="g-owner">${U.esc(API.memberName(i.owner))}</span>` : ''}
            ${i.conflicts.length ? '<span class="g-warn" aria-label="有日程衝突" title="有日程衝突">⚠</span>' : ''}</button></div>
          <div class="g-track">${barHtml(i)}${i.kind === 'task' ? alertMarks(alertsOn('task', i.id)) : ''}</div></div>`);
      });
    });
    // 被篩選掉活動（例如隱藏任務），但預警指向任務的情況：預警仍需看得到
    const shownTaskIds = new Set(groups.flatMap((g) => g.children.filter((c) => c.kind === 'task').map((c) => c.id)));
    const strayAlerts = alerts.filter((a) => a.taskId && !shownTaskIds.has(a.taskId));
    if (strayAlerts.length) {
      rows.push(`<div class="g-row g-group"><div class="g-label"><span class="g-name plain">其他預警</span></div>
        <div class="g-track">${alertMarks(strayAlerts)}</div></div>`);
    }

    body.innerHTML = `
      <div class="card no-pad gantt-card">
        <div class="gantt-head">
          <div class="seg small" role="group" aria-label="時間刻度">
            ${Object.entries(ZOOMS).map(([k, v]) => `<button type="button" class="seg-btn" data-zoom="${k}" aria-pressed="${state.zoom === k}">${v}</button>`).join('')}
          </div>
          <button type="button" class="btn small ghost" id="g-today">回到今天</button>
          <span class="muted small gantt-hint">${isLeaderOrPM() ? '拖曳長條可移動日期，拖曳兩端可調整開始／結束；鍵盤：← → 移動、Shift + ← → 調整結束日' : '組員僅能檢視；日期調整請洽組長或專案經理'}</span>
          ${undated ? `<span class="muted small">另有 ${undated} 項未排日期（見列表）</span>` : ''}
        </div>
        <div class="g-scroll" id="g-scroll" tabindex="-1">
          <div class="g-inner" style="--w:${width}px;--px:${px}px">
            <div class="g-header">
              <div class="g-corner">名稱</div>
              <div class="g-scale">
                <div class="g-months">${months.map((m) => `<div class="g-month" style="left:${m.x}px">${m.label}</div>`).join('')}</div>
                <div class="g-ticks ${state.zoom}">${ticks.join('')}</div>
              </div>
            </div>
            <div class="g-body">
              <div class="g-bg" aria-hidden="true">${weekends}<div class="g-today" style="left:${xOf(today) + px / 2}px"><span>今天</span></div></div>
              ${rows.join('')}
            </div>
          </div>
        </div>
        <div class="g-legend" aria-label="圖例">
          <span><i class="lg k-campaign"></i>行銷活動</span><span><i class="lg k-task"></i>任務（深色＝實際進度）</span>
          <span><i class="lg k-milestone"></i>里程碑</span><span><i class="lg k-alert">▲</i>預警期限</span>
          <span><i class="lg is-overdue"></i>紅框＝逾期</span><span><i class="lg has-conflict"></i>虛線＝日程衝突</span>
        </div>
      </div>`;

    const sc = body.querySelector('#g-scroll');
    const LABEL_W = 260;
    const scrollToday = () => { sc.scrollLeft = Math.max(0, xOf(today) - (sc.clientWidth - LABEL_W) / 3); };
    if (state.ganttScroll) { sc.scrollLeft = state.ganttScroll.left; sc.scrollTop = state.ganttScroll.top; state.ganttScroll = null; }
    else scrollToday();
    sc.addEventListener('scroll', () => { state.ganttScroll = { left: sc.scrollLeft, top: sc.scrollTop }; }, { passive: true });

    body.querySelectorAll('[data-zoom]').forEach((b) => { b.onclick = () => { state.zoom = b.dataset.zoom; state.ganttScroll = null; App.renderPage(); }; });
    body.querySelector('#g-today').onclick = scrollToday;
    body.querySelectorAll('.g-name[data-key], .g-alert[data-key]').forEach((b) => { b.onclick = () => openItem(findItem(b.dataset.key)); });
    body.querySelectorAll('.g-bar[data-key]').forEach((bar) => bindBar(bar, px));
  }

  /** 長條：點一下開明細；可拖曳者支援滑鼠／觸控拖曳與鍵盤調整 */
  function bindBar(bar, px) {
    const item = findItem(bar.dataset.key);
    if (!item) return;

    bar.addEventListener('click', () => {
      if (bar.dataset.justDragged) return;
      openItem(item);
    });

    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(item); return; }
      if (!item.draggable || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      const mode = e.shiftKey && item.kind !== 'milestone' ? 'end' : 'move';
      keyNudge(bar, item, mode, d, px);
    });

    if (!item.draggable) return;

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const mode = e.target.classList.contains('g-h-l') ? 'start'
        : e.target.classList.contains('g-h-r') ? 'end' : 'move';
      const x0 = e.clientX;
      const left0 = bar.offsetLeft;
      const w0 = bar.offsetWidth;
      let delta = 0;
      let moved = false;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      document.body.dataset.dragging = '1';
      const tip = document.createElement('div');
      tip.className = 'g-tip';
      bar.parentElement.appendChild(tip);

      const range = (dd) => shifted(item, mode, dd);
      const paint = () => {
        const r = range(delta);
        if (mode === 'move' || mode === 'start') bar.style.left = `${left0 + delta * px}px`;
        if (mode === 'start') bar.style.width = `${Math.max(px, w0 - delta * px)}px`;
        if (mode === 'end') bar.style.width = `${Math.max(px, w0 + delta * px)}px`;
        tip.textContent = r.s === r.e ? r.e : `${r.s} ～ ${r.e}`;
        tip.style.left = `${bar.offsetLeft}px`;
      };
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - x0) > 4) moved = true;
        if (!moved) return;
        let d = Math.round((ev.clientX - x0) / px);
        // 調整開始／結束時，不允許開始日晚於結束日
        if (mode === 'start') d = Math.min(d, U.daysBetween(item.start, item.end));
        if (mode === 'end') d = Math.max(d, -U.daysBetween(item.start, item.end));
        if (d !== delta) { delta = d; paint(); }
      };
      const onUp = async () => {
        bar.removeEventListener('pointermove', onMove);
        bar.removeEventListener('pointerup', onUp);
        bar.removeEventListener('pointercancel', onUp);
        bar.classList.remove('dragging');
        delete document.body.dataset.dragging;
        tip.remove();
        if (moved) {
          bar.dataset.justDragged = '1';
          setTimeout(() => { delete bar.dataset.justDragged; }, 0);
        }
        if (!moved || delta === 0) {
          bar.style.left = `${left0}px`;
          if (item.kind !== 'milestone') bar.style.width = `${w0}px`;
          return;
        }
        const r = range(delta);
        const revert = () => {
          bar.style.left = `${left0}px`;
          if (item.kind !== 'milestone') bar.style.width = `${w0}px`;
        };
        // 放開後先確認，確認了才存；取消就彈回原位
        bar.classList.add('pending');
        const ok = await confirmDates(item, r.s, r.e, mode, delta);
        bar.classList.remove('pending');
        if (!ok) { revert(); announce(`已取消，「${item.title}」維持原日期`); return; }
        await saveDates(item, r.s, r.e, revert);
      };
      bar.addEventListener('pointermove', onMove);
      bar.addEventListener('pointerup', onUp);
      bar.addEventListener('pointercancel', onUp);
    });
  }

  function shifted(item, mode, d) {
    let s = item.start;
    let e = item.end;
    if (mode === 'move') { s = U.addDays(s, d); e = U.addDays(e, d); }
    if (mode === 'start') s = U.addDays(s, d);
    if (mode === 'end') e = U.addDays(e, d);
    if (s > e) s = e;
    return { s, e };
  }

  // 鍵盤調整：連按時先在畫面上移動，停止 0.8 秒後才存檔（避免每按一次就寫一次資料庫）
  const nudge = { key: null, mode: null, delta: 0, timer: null, left0: 0, w0: 0 };
  function keyNudge(bar, item, mode, d, px) {
    const key = keyOf(item);
    if (nudge.key !== key || nudge.mode !== mode) {
      clearTimeout(nudge.timer);
      Object.assign(nudge, { key, mode, delta: 0, left0: bar.offsetLeft, w0: bar.offsetWidth });
    }
    let next = nudge.delta + d;
    if (mode === 'end') next = Math.max(next, -U.daysBetween(item.start, item.end));
    nudge.delta = next;
    if (mode === 'move') bar.style.left = `${nudge.left0 + next * px}px`;
    else bar.style.width = `${Math.max(px, nudge.w0 + next * px)}px`;
    const r = shifted(item, mode, next);
    announce(`${item.title}：${r.s === r.e ? r.e : r.s + ' 至 ' + r.e}（停止按鍵後會請你確認）`);
    clearTimeout(nudge.timer);
    nudge.timer = setTimeout(async () => {
      const total = nudge.delta;
      const left0 = nudge.left0;
      const w0 = nudge.w0;
      Object.assign(nudge, { key: null, mode: null, delta: 0 });
      if (!total) return;
      const rr = shifted(item, mode, total);
      const revert = () => { bar.style.left = `${left0}px`; bar.style.width = `${w0}px`; };
      bar.classList.add('pending');
      const ok = await confirmDates(item, rr.s, rr.e, mode, total);
      bar.classList.remove('pending');
      if (!ok) {
        revert(); announce(`已取消，「${item.title}」維持原日期`);
        const b = document.querySelector(`.g-bar[data-key="${key}"]`); if (b) b.focus();
        return;
      }
      await saveDates(item, rr.s, rr.e, revert, { refocus: key });
    }, 800);
  }

  /**
   * 拖曳／鍵盤調整後的確認框：顯示「原日期 → 新日期」、移動幾天、可能的衝突
   * 回傳 Promise<boolean>；按取消、Esc、點背景都視為取消
   */
  function confirmDates(item, s, e, mode, delta) {
    const kindName = { task: '任務', campaign: '行銷活動', milestone: '里程碑' }[item.kind] || '項目';
    const fmt = (a, b) => (a === b ? U.esc(a) : `${U.esc(a)} → ${U.esc(b)}`);
    const days = (a, b) => U.daysBetween(a, b) + 1;
    const n = Math.abs(delta);
    const what = mode === 'move' ? (delta > 0 ? `往後移 ${n} 天` : `往前移 ${n} 天`)
      : mode === 'start' ? (delta > 0 ? `開始日延後 ${n} 天` : `開始日提前 ${n} 天`)
      : (delta > 0 ? `延長 ${n} 天` : `縮短 ${n} 天`);

    // 衝突提醒：超出所屬活動期間、早於前置任務完成
    const warns = [];
    const r = item.raw || {};
    if (item.kind !== 'campaign' && r.campaign_id) {
      const c = (data?.camps || []).find((x) => x.campaign_id === r.campaign_id);
      if (c && ((c.planned_start && s < c.planned_start) || (c.planned_end && e > c.planned_end))) {
        warns.push(`超出活動「${c.name}」期間（${U.date(c.planned_start)} ～ ${U.date(c.planned_end)}）`);
      }
    }
    if (item.kind === 'task' && r.predecessor_ids) {
      String(r.predecessor_ids).split(/[,，\s]+/).filter(Boolean).forEach((pid) => {
        const pre = (data?.tasks || []).find((t) => t.task_id === pid.toUpperCase());
        if (pre && pre.planned_end && s <= pre.planned_end) warns.push(`開始日早於前置任務「${pre.name}」的完成日 ${pre.planned_end}`);
      });
    }
    if (item.kind === 'campaign') {
      const inside = (data?.tasks || []).filter((t) => t.campaign_id === r.campaign_id && OPEN_TASK(t)).length;
      if (inside) warns.push(`活動內 ${inside} 項任務的日期不會跟著移動`);
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const m = U.openModal({
        title: `確認調整${kindName}日期`,
        dirtyCheck: false,
        onClose: () => finish(false),
        body: `
          <div class="date-confirm">
            <div class="dc-title">${U.esc(item.title)}</div>
            <div class="dc-grid">
              <div class="dc-col old"><span class="dc-label">原日期</span>
                <b>${fmt(item.start, item.end)}</b><span class="muted small">共 ${days(item.start, item.end)} 天</span></div>
              <div class="dc-arrow" aria-hidden="true">⇒</div>
              <div class="dc-col new"><span class="dc-label">新日期</span>
                <b>${fmt(s, e)}</b><span class="muted small">共 ${days(s, e)} 天</span></div>
            </div>
            <div class="dc-change">${U.esc(what)}</div>
            ${warns.length ? `<ul class="dc-warn" role="alert">${warns.map((w) => `<li>⚠ ${U.esc(w)}</li>`).join('')}</ul>` : ''}
            <p class="muted small">按 Enter 確認，Esc 取消。</p>
          </div>`,
        footer: `<span class="spacer"></span>
          <button type="button" class="btn ghost" data-no>取消，彈回原位</button>
          <button type="button" class="btn primary" data-yes data-no-busy>確認變更</button>`
      });
      m.querySelector('[data-no]').onclick = () => { U.closeModal(); finish(false); };
      m.querySelector('[data-yes]').onclick = () => { U.closeModal(); finish(true); };
      m.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.target.matches('[data-no]')) { ev.preventDefault(); m.querySelector('[data-yes]').click(); }
      });
      setTimeout(() => m.querySelector('[data-yes]').focus(), 40);
    });
  }

  /** 寫入新的日期（樂觀鎖）；失敗時把長條移回原位 */
  async function saveDates(item, s, e, revert, { refocus = null } = {}) {
    const r = item.raw;
    const TABLE = {
      task: ['tasks', 'task_id', { planned_start: s, planned_end: e }],
      campaign: ['campaigns', 'campaign_id', { planned_start: s, planned_end: e }],
      milestone: ['milestones', 'milestone_id', { planned_end: e }]
    }[item.kind];
    if (!TABLE) return;
    const [table, pk, patch] = TABLE;
    try {
      const row = await API.updateWithVersion(table, pk, r[pk], r.version, patch);
      Object.assign(r, row);
      const txt = `已將「${item.title}」調整為 ${s === e ? e : s + ' ～ ' + e}`;
      U.toast(txt, 'ok');
      announce(txt);
      await App.renderPage();
      if (refocus) {
        const b = document.querySelector(`.g-bar[data-key="${refocus}"]`);
        if (b) b.focus();
      }
    } catch (err) {
      revert();
      U.toast(err.message, 'bad', 6000);
    }
  }

  function announce(text) {
    const live = document.getElementById('sched-live');
    if (live) live.textContent = text;
  }

  // ---------------------------------------------------------------------
  // 開啟明細
  // ---------------------------------------------------------------------
  const keyOf = (i) => `${i.kind}:${i.id}`;
  const findItem = (key) => itemsAll.find((i) => keyOf(i) === key);

  function openItem(item) {
    if (!item) return;
    if (item.kind === 'task') return Pages.openTaskModal(item.raw, Pages.canEditTask(item.raw, data.collab));
    if (item.kind === 'campaign') {
      if (isLeaderOrPM()) return Pages.openCampaignModal(item.raw);
      return campaignDrawer(item);
    }
    if (item.kind === 'milestone') return openMilestoneModal(item.raw);
    return alertDrawer(item);
  }

  function campaignDrawer(item) {
    const c = item.raw;
    const m = U.openDrawer({
      title: `${c.campaign_id}｜${c.name}`,
      dirtyCheck: false,
      body: `<dl class="kv">
        <dt>狀態</dt><dd>${U.chip(c.status)}</dd>
        <dt>期間</dt><dd>${U.date(c.planned_start)} ～ ${U.date(c.planned_end)}</dd>
        <dt>負責人</dt><dd>${U.esc(API.memberName(c.owner_id))}</dd>
        <dt>類型</dt><dd>${U.esc(c.campaign_type || '—')}</dd>
        <dt>目標</dt><dd>${U.esc(c.objective || '—')}</dd></dl>
        ${item.conflicts.length ? `<p class="conflict-note">⚠ ${U.esc(item.conflicts.join('；'))}</p>` : ''}`,
      footer: '<span class="spacer"></span><button type="button" class="btn ghost" data-cancel>關閉</button>'
    });
    return m;
  }

  function alertDrawer(item) {
    const a = item.raw;
    const m = U.openDrawer({
      title: `${a.alert_id}｜${a.alert_type || '預警'}`,
      dirtyCheck: false,
      body: `<dl class="kv">
        <dt>等級</dt><dd>${U.chip(a.alert_level)}</dd>
        <dt>處理期限</dt><dd>${U.date(a.suggested_due)}${item.overdue ? ' <span class="bad-text">（已逾期）</span>' : ''}</dd>
        <dt>處理狀態</dt><dd>${U.chip(a.handle_status)}</dd>
        <dt>處理負責人</dt><dd>${U.esc(API.memberName(a.handler_id))}</dd>
        <dt>觸發條件</dt><dd>${U.esc(a.trigger_condition || '—')}</dd>
        <dt>AI 摘要</dt><dd>${U.esc(a.ai_summary || '—')}</dd>
        <dt>AI 建議</dt><dd class="pre">${U.esc(a.ai_suggestion || '—')}</dd></dl>`,
      footer: `<span class="spacer"></span><button type="button" class="btn ghost" data-cancel>關閉</button>
        <button type="button" class="btn primary" id="go-alerts">前往 AI 預警處理</button>`
    });
    m.querySelector('#go-alerts').onclick = () => { U.closeModal(); location.hash = '#/alerts'; };
  }

  // ---------------------------------------------------------------------
  // 里程碑：新增／編輯／刪除（新增、編輯：組長與專案經理；刪除：專案經理）
  // ---------------------------------------------------------------------
  function openMilestoneModal(ms, presetDate = null) {
    const isNew = !ms;
    const can = isLeaderOrPM();
    const m0 = ms || { planned_end: presetDate || U.today(), acceptance_status: '未驗收', campaign_id: '' };
    const camps = (data?.camps || []);
    const dis = can ? '' : 'disabled title="只有組長或專案經理可以修改里程碑"';
    const body = `
      <form id="ms-form" class="form-grid" novalidate>
        <label class="span-2">里程碑名稱 <span class="req" aria-hidden="true">*</span>
          <input name="name" required maxlength="80" value="${U.esc(m0.name || '')}" ${dis}></label>
        <label>預計完成日 <span class="req" aria-hidden="true">*</span>
          <input type="date" name="planned_end" required value="${U.esc(m0.planned_end || '')}" ${dis}></label>
        <label>關聯活動
          <select name="campaign_id" ${dis}>${U.options(camps.map((c) => c.campaign_id), m0.campaign_id || '', { blank: true, labels: Object.fromEntries(camps.map((c) => [c.campaign_id, c.name])) })}</select></label>
        <label>驗收狀態
          <select name="acceptance_status" ${dis}>${U.options(API.opts('驗收狀態', ['未驗收', '驗收中', '通過', '未通過']), m0.acceptance_status || '未驗收')}</select></label>
        <label>實際完成日<input type="date" name="actual_end" value="${U.esc(m0.actual_end || '')}" ${dis}></label>
        <label class="span-2">驗收負責人<input name="acceptor_name" maxlength="40" value="${U.esc(m0.acceptor_name || '')}" ${dis}></label>
        <label class="span-2">完成標準<textarea name="acceptance_criteria" rows="2" maxlength="500" ${dis}>${U.esc(m0.acceptance_criteria || '')}</textarea></label>
        <label class="span-2">說明<textarea name="description" rows="2" maxlength="500" ${dis}>${U.esc(m0.description || '')}</textarea></label>
      </form>
      <div class="form-warn" id="ms-warn" role="status"></div>
      <div class="form-error" id="ms-error" role="alert"></div>`;
    const m = U.openModal({
      title: isNew ? '新增里程碑' : `${m0.milestone_id}｜${m0.name}`,
      body, wide: true, dirtyCheck: can, draftKey: can ? `milestone:${m0.milestone_id || 'new'}:${m0.version || 0}` : null,
      footer: `${!isNew && isPM() ? '<button type="button" class="btn danger ghost" id="ms-del">刪除</button>' : ''}<span class="spacer"></span>
        <button type="button" class="btn ghost" data-cancel>${can ? '取消' : '關閉'}</button>
        ${can ? `<button type="button" class="btn primary" id="ms-save">${isNew ? '建立' : '儲存'}</button>` : ''}`
    });
    const form = m.querySelector('#ms-form');
    const warn = m.querySelector('#ms-warn');
    const checkRange = () => {
      const f = U.formData(form);
      const c = camps.find((x) => x.campaign_id === f.campaign_id);
      warn.textContent = c && f.planned_end && ((c.planned_end && f.planned_end > c.planned_end) || (c.planned_start && f.planned_end < c.planned_start))
        ? `提醒：日期不在活動「${c.name}」期間（${U.date(c.planned_start)} ～ ${U.date(c.planned_end)}），仍可儲存。` : '';
    };
    form.addEventListener('change', checkRange);
    checkRange();

    const save = m.querySelector('#ms-save');
    if (save) save.onclick = async () => {
      const err = m.querySelector('#ms-error');
      err.textContent = '';
      const f = U.emptyToNull(U.formData(form));
      if (!f.name) { err.textContent = '請輸入里程碑名稱'; form.querySelector('[name=name]').focus(); return; }
      if (!f.planned_end) { err.textContent = '請選擇預計完成日'; form.querySelector('[name=planned_end]').focus(); return; }
      save.disabled = true;
      try {
        if (isNew) await API.insert('milestones', f, '新增里程碑');
        else await API.updateWithVersion('milestones', 'milestone_id', m0.milestone_id, m0.version, f);
        U.toast(isNew ? '里程碑已建立' : '里程碑已更新', 'ok');
        U.closeModal();
        App.renderPage();
      } catch (e) {
        err.textContent = e.message;
        save.disabled = false;
      }
    };
    const del = m.querySelector('#ms-del');
    if (del) del.onclick = async () => {
      if (!(await U.confirmBox(`確定要刪除里程碑「${m0.name}」嗎？\n刪除後 8 秒內可按「復原」。`, '刪除', true))) return;
      try {
        await API.softDelete('milestones', 'milestone_id', m0, '里程碑');
        U.closeModal();
        App.renderPage();
      } catch (e) { U.toast(e.message, 'bad', 6000); }
    };
  }

  // ---------------------------------------------------------------------
  // 匯出 .ics（全天事件），可匯入 Google 日曆／Outlook／Apple 行事曆
  // ---------------------------------------------------------------------
  function exportIcs(items) {
    const list = items.filter((i) => i.start && i.end);
    if (!list.length) { U.toast('目前沒有可匯出的事項', 'info'); return; }
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const ymd = (d) => d.replace(/-/g, '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const org = (Auth.current()?.org_name || 'org').replace(/\s+/g, '');
    // 每行最多 75 位元組（RFC 5545），中文以字元數保守估計折行
    const fold = (line) => {
      const out = [];
      let cur = '';
      let bytes = 0;
      for (const ch of line) {
        const b = new TextEncoder().encode(ch).length;
        if (bytes + b > 73) { out.push(cur); cur = ' ' + ch; bytes = 1 + b; } else { cur += ch; bytes += b; }
      }
      out.push(cur);
      return out.join('\r\n');
    };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AI Brand PM//Schedule//ZH-TW', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc((Auth.current()?.org_name || '') + ' 活動日程')}`];
    list.forEach((i) => {
      lines.push('BEGIN:VEVENT',
        `UID:${i.kind}-${i.id}@${encodeURIComponent(org)}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymd(i.start)}`,
        `DTEND;VALUE=DATE:${ymd(U.addDays(i.end, 1))}`,
        `SUMMARY:${esc(`[${KIND[i.kind].label}] ${i.title}`)}`,
        `DESCRIPTION:${esc(`狀態：${i.status}${i.owner ? '\n負責人：' + API.memberName(i.owner) : ''}${i.conflicts.length ? '\n⚠ ' + i.conflicts.join('；') : ''}`)}`,
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.map(fold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // 檔名用英數字：部分瀏覽器會把非 ASCII 的下載檔名換成「download」
    a.download = `schedule_${U.today()}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    U.toast(`已匯出 ${list.length} 個事項`, 'ok');
  }

  function emptyText() {
    return isLeaderOrPM()
      ? '這個專案還沒有排程資料。可以先到「行銷活動」或「任務」填入日期，或按右上角「＋ 新增里程碑」。'
      : '目前沒有排程資料。';
  }

  return { render, openMilestoneModal, _state: state };
})();
