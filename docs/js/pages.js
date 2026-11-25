/**
 * 各頁面：儀表板、任務管理、AI 預警、風險與問題、行銷活動成效、組員負荷
 */
const Pages = (() => {
  const cfg = window.APP_CONFIG;

  // ---------- 角色判斷（實際權限由資料庫 RLS 把關，這裡只負責介面顯示） ----------
  const me = () => Auth.current();
  const isPM = () => me()?.role === '專案經理';
  const isLeaderOrPM = () => ['專案經理', '組長'].includes(me()?.role);

  function canEditTask(t, myCollabTaskIds = new Set()) {
    if (isPM()) return true;
    if (t.owner_id === me().member_id) return true;
    if (myCollabTaskIds.has(t.task_id)) return true;
    if (me().role === '組長') {
      const owner = (API.cache.members || []).find((m) => m.member_id === t.owner_id);
      return owner && owner.leader_id === me().member_id;
    }
    return false;
  }

  const STATUS_COLOR = {
    '未開始': '#94a3b8', '進行中': '#3b82f6', '阻塞': '#ef4444', '完成': '#10b981', '取消': '#cbd5e1'
  };

  const baseChartOpts = (extra = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
    ...extra
  });

  function isOverdue(t) {
    return t.planned_end && !['完成', '取消'].includes(t.status) && t.planned_end < U.today();
  }

  function emptyState(text) {
    return `<div class="empty">${U.esc(text)}</div>`;
  }

  // 圖表沒有資料時，改顯示提示文字
  function noData(id, text = '尚無資料') {
    const c = document.getElementById(id);
    if (c && c.parentElement) c.parentElement.innerHTML = `<div class="chart-empty">${U.esc(text)}</div>`;
  }
  const kTick = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString('zh-TW') + 'k' : v);

  // =====================================================================
  // 1. 首頁改由 dashboards.js 依角色顯示；這裡保留共用的組員負荷圖
  // =====================================================================
  function drawWorkloadChart(id, work) {
    const yellow = U.num(API.cache.settings?.['工作負荷黃色門檻'] || 0.8);
    const red = U.num(API.cache.settings?.['工作負荷紅色門檻'] || 1);
    const rows = work.filter((w) => w.status !== '已離開');
    if (!rows.length) return noData(id, '尚無組員資料');
    U.chart(id, {
      type: 'bar',
      data: {
        labels: rows.map((w) => w.name),
        datasets: [{
          label: '負荷率',
          data: rows.map((w) => Math.round(U.num(w.workload_rate) * 100)),
          backgroundColor: rows.map((w) => U.num(w.workload_rate) >= red ? '#ef4444' : U.num(w.workload_rate) >= yellow ? '#f59e0b' : '#10b981')
        }]
      },
      options: baseChartOpts({
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw}%` } } },
        scales: { x: { suggestedMax: 120, ticks: { callback: (v) => v + '%' } } }
      })
    });
  }

  // =====================================================================
  // 2. 任務管理
  // =====================================================================
  const taskFilter = { text: '', status: '', campaign: '', owner: '', mine: false, overdue: false, limit: 100 };

  async function tasks(el) {
    const [rows, collabRes] = await Promise.all([
      API.q.tasks().then((r) => API.check(r, '讀取任務')),
      API.sb.from('task_collaborators').select('task_id').eq('member_id', me().member_id).eq('is_deleted', false)
    ]);
    const myCollab = new Set((collabRes.data || []).map((c) => c.task_id));
    const statuses = API.opts('任務狀態', ['未開始', '進行中', '阻塞', '完成', '取消']);
    const counts = U.groupCount(rows, 'status');
    const overdueCount = rows.filter(isOverdue).length;

    el.innerHTML = `
      <div class="status-strip">
        ${statuses.map((s) => `<button class="strip-item ${taskFilter.status === s ? 'active' : ''}" aria-pressed="${taskFilter.status === s}" data-status="${U.esc(s)}">
          <span class="strip-dot" style="background:${STATUS_COLOR[s] || '#94a3b8'}"></span>${U.esc(s)}<b>${counts[s] || 0}</b></button>`).join('')}
        <button class="strip-item ${taskFilter.overdue ? 'active' : ''}" aria-pressed="${taskFilter.overdue}" data-overdue><span class="strip-dot" style="background:#dc2626"></span>逾期<b>${overdueCount}</b></button>
      </div>

      <div class="toolbar">
        <input type="search" id="f-text" aria-label="搜尋任務名稱或 ID" placeholder="搜尋任務名稱或 ID" value="${U.esc(taskFilter.text)}">
        <select id="f-campaign" aria-label="依活動篩選"><option value="">全部活動</option>${U.options((API.cache.campaigns || []).map((c) => c.campaign_id), taskFilter.campaign, { labels: Object.fromEntries((API.cache.campaigns || []).map((c) => [c.campaign_id, c.name])) })}</select>
        <select id="f-owner" aria-label="依負責人篩選"><option value="">全部負責人</option>${U.options((API.cache.members || []).map((m) => m.member_id), taskFilter.owner, { labels: Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, m.name])) })}</select>
        <label class="check"><input type="checkbox" id="f-mine" ${taskFilter.mine ? 'checked' : ''}> 只看我的</label>
        <span class="spacer"></span>
        <button class="btn outline" id="btn-export-tasks" title="匯出目前篩選結果為 CSV">⤓ 匯出 CSV</button>
        ${isLeaderOrPM() ? '<button class="btn primary" id="btn-new-task">＋ 新增任務</button>' : ''}
      </div>

      <div class="card no-pad">
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>燈號</th><th>任務</th><th>負責人</th><th>活動</th><th>截止日</th>
              <th style="min-width:160px">進度（實際／預計）</th><th>落差</th><th>狀態</th><th>優先</th><th></th>
            </tr></thead>
            <tbody id="task-body"></tbody>
          </table>
        </div>
      </div>`;

    const body = el.querySelector('#task-body');
    let filtered = rows;

    el.querySelector('#btn-export-tasks').onclick = () => {
      U.downloadCsv(`任務_${U.today()}.csv`, [
        { label: '任務ID', get: (t) => t.task_id }, { label: '任務名稱', get: (t) => t.name },
        { label: '負責人', get: (t) => API.memberName(t.owner_id) }, { label: '活動', get: (t) => API.campaignName(t.campaign_id) },
        { label: '預計開始', get: (t) => U.date(t.planned_start) }, { label: '預計完成', get: (t) => U.date(t.planned_end) },
        { label: '實際進度', get: (t) => U.pct(t.actual_progress) }, { label: '預計進度', get: (t) => U.pct(t.planned_progress) },
        { label: '狀態', get: (t) => t.status }, { label: '優先級', get: (t) => t.priority },
        { label: '燈號', get: (t) => t.risk_light }, { label: '預估工時', get: (t) => t.estimated_hours },
        { label: '實際工時', get: (t) => t.actual_hours }, { label: '阻塞原因', get: (t) => t.blocked_reason }
      ], filtered);
      U.toast(`已匯出 ${filtered.length} 筆任務`, 'ok');
    };

    function draw() {
      const list = rows.filter((t) => {
        if (taskFilter.status && t.status !== taskFilter.status) return false;
        if (taskFilter.overdue && !isOverdue(t)) return false;
        if (taskFilter.campaign && t.campaign_id !== taskFilter.campaign) return false;
        if (taskFilter.owner && t.owner_id !== taskFilter.owner) return false;
        if (taskFilter.mine && t.owner_id !== me().member_id && !myCollab.has(t.task_id)) return false;
        if (taskFilter.text) {
          const s = taskFilter.text.toLowerCase();
          if (!(`${t.task_id} ${t.name}`.toLowerCase().includes(s))) return false;
        }
        return true;
      });
      const total = list.length;
      filtered = list;
      body.innerHTML = list.slice(0, taskFilter.limit).map((t) => {
        const over = isOverdue(t);
        const gap = U.num(t.progress_gap);
        const editable = canEditTask(t, myCollab);
        return `<tr data-id="${U.esc(t.task_id)}" class="clickable ${over ? 'row-overdue' : ''}">
          <td>${U.light(t.risk_light)}</td>
          <td><div class="cell-title">${U.esc(t.name)}</div><div class="muted small">${U.esc(t.task_id)}${t.blocked_reason ? '・<span class="bad-text">阻塞：' + U.esc(t.blocked_reason) + '</span>' : ''}</div></td>
          <td>${U.esc(API.memberName(t.owner_id))}${myCollab.has(t.task_id) ? ' <span class="chip info">協作</span>' : ''}</td>
          <td class="small">${U.esc(API.campaignName(t.campaign_id))}</td>
          <td class="${over ? 'bad-text' : ''}">${U.date(t.planned_end)}${over ? `<div class="small">逾期 ${U.daysBetween(t.planned_end, U.today())} 天</div>` : ''}</td>
          <td>${U.progressBar(t.actual_progress, t.planned_progress)}</td>
          <td class="${gap < -0.0001 ? 'bad-text' : 'ok-text'}">${gap > 0 ? '+' : ''}${U.pct(gap)}</td>
          <td>${U.chip(t.status)}</td>
          <td>${U.chip(t.priority)}</td>
          <td><button class="btn small ${editable ? 'outline' : 'ghost'}">${editable ? '編輯' : '檢視'}</button></td>
        </tr>`;
      }).join('') || `<tr><td colspan="10">${emptyState('沒有符合條件的任務')}</td></tr>`;
      // 大量資料分批顯示，避免一次畫出過多列造成卡頓
      if (total > taskFilter.limit) {
        body.insertAdjacentHTML('beforeend', `<tr><td colspan="10" class="more-row"><button class="btn outline" id="btn-more">顯示更多（還有 ${total - taskFilter.limit} 筆）</button></td></tr>`);
        body.querySelector('#btn-more').onclick = () => { taskFilter.limit += 100; draw(); };
      }

      U.rowsA11y(body);
      body.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.onclick = () => {
          const t = rows.find((x) => x.task_id === tr.dataset.id);
          openTaskModal(t, canEditTask(t, myCollab));
        };
      });
    }
    draw();

    el.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = () => { taskFilter.status = taskFilter.status === b.dataset.status ? '' : b.dataset.status; taskFilter.overdue = false; tasks(el); };
    });
    el.querySelector('[data-overdue]').onclick = () => { taskFilter.overdue = !taskFilter.overdue; taskFilter.status = ''; tasks(el); };
    el.querySelector('#f-text').oninput = (e) => { taskFilter.text = e.target.value; draw(); };
    el.querySelector('#f-campaign').onchange = (e) => { taskFilter.campaign = e.target.value; draw(); };
    el.querySelector('#f-owner').onchange = (e) => { taskFilter.owner = e.target.value; draw(); };
    el.querySelector('#f-mine').onchange = (e) => { taskFilter.mine = e.target.checked; draw(); };
    const newBtn = el.querySelector('#btn-new-task');
    if (newBtn) newBtn.onclick = () => openTaskModal(null, true);
  }

  async function openTaskModal(task, editable) {
    const isNew = !task;
    const t = task || {
      task_id: '', name: '', status: '未開始', priority: '中',
      planned_progress: 0, actual_progress: 0, owner_id: me().member_id,
      planned_start: U.today(), planned_end: '', version: 0
    };
    const lead = isLeaderOrPM();
    const dis = (cond) => (cond ? '' : `disabled title="${editable ? '只有組長或專案經理可以修改此欄位' : '你沒有修改這個任務的權限'}"`);
    const memberIds = (API.cache.members || []).filter((m) => m.status !== '已離開').map((m) => m.member_id);
    const memberLabels = Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, `${m.name}（${m.member_id}）`]));
    const campIds = (API.cache.campaigns || []).map((c) => c.campaign_id);
    const campLabels = Object.fromEntries((API.cache.campaigns || []).map((c) => [c.campaign_id, c.name]));

    const body = `
      <form id="task-form" class="form-grid">
        <div class="form-section span-2">基本資料 ${lead ? '' : '<span class="muted small">（負責人、日期、權重由組長或專案經理設定）</span>'}</div>
        <label>任務ID<input value="${isNew ? '（儲存後自動產生）' : U.esc(t.task_id)}" disabled></label>
        <label>任務名稱<input name="name" value="${U.esc(t.name)}" required ${dis(editable && lead)}></label>
        <label>負責人<select name="owner_id" ${dis(editable && lead)}>${U.options(memberIds, t.owner_id, { blank: true, labels: memberLabels })}</select></label>
        <label>關聯活動<select name="campaign_id" ${dis(editable && lead)}>${U.options(campIds, t.campaign_id, { blank: true, labels: campLabels })}</select></label>
        <label>優先級<select name="priority" ${dis(editable && lead)}>${U.options(API.opts('優先級', ['高', '中', '低']), t.priority)}</select></label>
        <label>前置任務ID<input name="predecessor_ids" value="${U.esc(t.predecessor_ids || '')}" ${dis(editable && lead)} placeholder="可留空"></label>
        <label>預計開始<input type="date" name="planned_start" value="${U.esc(t.planned_start || '')}" ${dis(editable && lead)}></label>
        <label>預計完成<input type="date" name="planned_end" value="${U.esc(t.planned_end || '')}" ${dis(editable && lead)}></label>
        <label>預計進度（%）<input type="number" name="planned_progress" min="0" max="100" step="1" value="${Math.round(U.num(t.planned_progress) * 100)}" ${dis(editable && lead)}></label>
        <label>預估工時<input type="number" name="estimated_hours" min="0" step="0.5" value="${U.esc(t.estimated_hours ?? '')}" ${dis(editable && lead)}></label>
        <label class="span-2">任務說明<textarea name="description" rows="2" ${dis(editable && lead)}>${U.esc(t.description || '')}</textarea></label>

        <div class="form-section span-2">執行狀況</div>
        <label>任務狀態<select name="status" ${dis(editable)}>${U.options(API.opts('任務狀態', ['未開始', '進行中', '阻塞', '完成', '取消']), t.status)}</select></label>
        <label>風險燈號<select name="risk_light" ${dis(editable)}>${U.options(['綠', '黃', '紅'], t.risk_light, { blank: true })}</select></label>
        <label class="span-2">實際進度：<b id="prog-label">${Math.round(U.num(t.actual_progress) * 100)}%</b>
          <input type="range" name="actual_progress" min="0" max="100" step="5" value="${Math.round(U.num(t.actual_progress) * 100)}" ${dis(editable)}>
        </label>
        <label>實際工時<input type="number" name="actual_hours" min="0" step="0.5" value="${U.esc(t.actual_hours ?? '')}" ${dis(editable)}></label>
        <label>剩餘工時<input type="number" name="remaining_hours" min="0" step="0.5" value="${U.esc(t.remaining_hours ?? '')}" ${dis(editable)}></label>
        <label>實際完成日<input type="date" name="actual_end" value="${U.esc(t.actual_end || '')}" ${dis(editable)}></label>
        <label>阻塞原因<input name="blocked_reason" value="${U.esc(t.blocked_reason || '')}" ${dis(editable)}></label>
        <label class="span-2">備註<textarea name="notes" rows="2" ${dis(editable)}>${U.esc(t.notes || '')}</textarea></label>

        ${!isNew && editable ? `
        <div class="form-section span-2">本次進度回報 <span class="muted small">（進度有變動或有填寫時，會自動新增一筆進度紀錄）</span></div>
        <label class="span-2">本次完成事項<textarea name="done_items" rows="2"></textarea></label>
        <label>下一步工作<textarea name="next_steps" rows="2"></textarea></label>
        <label>遭遇困難<textarea name="difficulties" rows="2"></textarea></label>` : ''}
      </form>
      ${!isNew ? `<div class="modal-extra" id="task-extra"><div class="muted small">載入子任務與進度紀錄…</div></div>` : ''}
      <div class="form-error" id="task-error"></div>`;

    const footer = `
      ${!isNew && isPM() ? '<button class="btn danger ghost" id="btn-del">刪除</button>' : ''}
      <span class="spacer"></span>
      ${!isNew ? `<span class="muted small">版本 v${t.version}・最後更新 ${U.dateTime(t.updated_at)}</span>` : ''}
      <button class="btn ghost" data-cancel>${editable ? '取消' : '關閉'}</button>
      ${editable ? `<button class="btn primary" id="btn-save">${isNew ? '建立任務' : '儲存'}</button>` : ''}`;

    const m = U.openModal({ title: isNew ? '新增任務' : `${t.task_id}｜${t.name}`, body, footer, wide: true,
      draftKey: editable ? `task:${t.task_id || 'new'}:${t.version}` : null });
    const form = m.querySelector('#task-form');

    // 組員：不顯示不能修改的基本資料欄位，改為一張摘要卡，減少干擾、聚焦在進度回報
    if (!lead && !isNew) {
      let section = 0;
      [...form.children].forEach((k) => {
        if (k.classList.contains('form-section')) section += 1;
        if (section === 1) k.hidden = true;
      });
      form.insertAdjacentHTML('afterbegin', `<div class="task-summary span-2" aria-label="任務摘要">
        <div><span>負責人</span><b>${U.esc(API.memberName(t.owner_id))}</b></div>
        <div><span>活動</span><b>${U.esc(API.campaignName(t.campaign_id))}</b></div>
        <div><span>期間</span><b>${U.date(t.planned_start)} → ${U.date(t.planned_end)}</b></div>
        <div><span>預計進度</span><b>${U.pct(t.planned_progress)}</b></div>
        <div><span>優先級</span><b>${U.esc(t.priority || '—')}</b></div>
        ${t.description ? `<p class="span-all">${U.esc(t.description)}</p>` : ''}
      </div>`);
    }
    const range = form.querySelector('[name=actual_progress]');
    range.oninput = () => { m.querySelector('#prog-label').textContent = range.value + '%'; };
    form.querySelector('[name=status]').onchange = (e) => {
      if (e.target.value === '完成') {
        range.value = 100; m.querySelector('#prog-label').textContent = '100%';
        if (!form.actual_end.value) form.actual_end.value = U.today();
      }
    };
    m.querySelector('[data-cancel]').onclick = U.closeModal;

    // 子任務與進度紀錄
    if (!isNew) {
      Promise.all([API.q.subtasksOf(t.task_id), API.q.progressOf(t.task_id)]).then(([s, p]) => {
        const subs = s.data || [];
        const logs = p.data || [];
        const box = m.querySelector('#task-extra');
        if (!box) return;
        box.innerHTML = `
          <div class="grid g-2">
            <div><h5>子任務（${subs.length}）</h5>
              <ul class="mini-list">${subs.map((x) => `<li>${U.chip(x.status)}<div><b>${U.esc(x.name)}</b>
                <div class="muted small">${U.esc(API.memberName(x.owner_id))}・截止 ${U.date(x.due_date)}</div></div>${U.progressBar(x.actual_progress)}</li>`).join('') || '<li class="muted">沒有子任務</li>'}</ul>
            </div>
            <div><h5>最近進度回報</h5>
              <ul class="timeline">${logs.map((x) => `<li><div class="small muted">${U.dateTime(x.updated_time)}・${U.esc(API.memberName(x.updater_id))}</div>
                <div><b>${U.pct(x.progress_before)} → ${U.pct(x.progress_after)}</b> ${U.esc(x.done_items || '')}</div>
                ${x.difficulties ? `<div class="small bad-text">困難：${U.esc(x.difficulties)}</div>` : ''}</li>`).join('') || '<li class="muted">尚無進度紀錄</li>'}</ul>
            </div>
          </div>`;
      });
    }

    // 刪除（軟刪除）
    const delBtn = m.querySelector('#btn-del');
    if (delBtn) delBtn.onclick = async () => {
      if (!(await U.confirmBox(`確定要刪除任務「${t.name}」嗎？\n刪除後 8 秒內可按「復原」，之後可由專案經理在「公司設定 → 最近刪除」還原。`, '刪除', true))) return;
      try {
        await API.softDelete('tasks', 'task_id', t, '任務');
        App.renderPage();
      } catch (e) { U.toast(e.message, 'bad', 6000); }
    };

    // 儲存
    const saveBtn = m.querySelector('#btn-save');
    if (!saveBtn) return;
    saveBtn.onclick = async () => {
      const errBox = m.querySelector('#task-error');
      errBox.textContent = '';
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      const prog = U.num(f.actual_progress) / 100;

      const patch = {
        status: f.status,
        risk_light: f.risk_light || null,
        actual_progress: prog,
        actual_hours: f.actual_hours === '' ? null : U.num(f.actual_hours),
        remaining_hours: f.remaining_hours === '' ? null : U.num(f.remaining_hours),
        actual_end: f.actual_end || null,
        blocked_reason: f.blocked_reason || null,
        notes: f.notes || null
      };
      if (lead) Object.assign(patch, {
        name: f.name,
        owner_id: f.owner_id || null,
        campaign_id: f.campaign_id || null,
        priority: f.priority,
        predecessor_ids: f.predecessor_ids || null,
        planned_start: f.planned_start || null,
        planned_end: f.planned_end || null,
        planned_progress: U.num(f.planned_progress) / 100,
        estimated_hours: f.estimated_hours === '' ? null : U.num(f.estimated_hours),
        description: f.description || null
      });
      if (patch.planned_start && patch.planned_end && patch.planned_end < patch.planned_start) {
        errBox.textContent = '預計完成日不可早於預計開始日';
        return;
      }

      const oldProg = U.num(t.actual_progress);
      saveBtn.disabled = true; saveBtn.textContent = '儲存中…';
      try {
        if (isNew) {
          const res = await API.sb.from('tasks').insert({ ...patch, progress_source: '系統建立' }).select();
          API.check(res, '建立任務');
          U.toast('任務已建立', 'ok');
        } else {
          await API.updateWithVersion('tasks', 'task_id', t.task_id, t.version, patch);
          const progressChanged = Math.abs(prog - oldProg) > 0.0001;
          if (progressChanged || f.done_items || f.next_steps || f.difficulties) {
            const res = await API.sb.from('progress_updates').insert({
              task_id: t.task_id,
              progress_before: oldProg,
              progress_after: prog,
              done_items: f.done_items || null,
              next_steps: f.next_steps || null,
              difficulties: f.difficulties || null,
              remaining_hours: patch.remaining_hours,
              updater_id: me().member_id,
              source: 'APP'
            });
            if (res.error) U.toast('任務已儲存，但進度紀錄寫入失敗：' + API.translateError(res.error), 'warn', 6000);
          }
          U.toast('已儲存', 'ok');
        }
        U.closeModal();
        App.renderPage();
      } catch (e) {
        errBox.textContent = e.message;
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = isNew ? '建立任務' : '儲存';
      }
    };
  }

  // =====================================================================
  // 3. AI 預警
  // =====================================================================
  const alertFilter = { status: '未結案', level: '' };

  async function alerts(el) {
    const rows = API.check(await API.q.alerts(), '讀取預警');
    const open = rows.filter((a) => a.handle_status !== '已結案');
    const lv = U.groupCount(open, 'alert_level');
    const types = U.groupCount(open, 'alert_type');
    const typeKeys = Object.keys(types).sort((a, b) => types[b] - types[a]);

    el.innerHTML = `
      <div class="kpis small-kpis">
        <div class="kpi"><div class="kpi-label">未結案預警</div><div class="kpi-value">${open.length}</div></div>
        <div class="kpi"><div class="kpi-label">高</div><div class="kpi-value bad-text">${lv['高'] || 0}</div></div>
        <div class="kpi"><div class="kpi-label">中</div><div class="kpi-value warn-text">${lv['中'] || 0}</div></div>
        <div class="kpi"><div class="kpi-label">低</div><div class="kpi-value ok-text">${lv['低'] || 0}</div></div>
        <div class="kpi"><div class="kpi-label">指派給我</div><div class="kpi-value">${open.filter((a) => a.handler_id === me().member_id).length}</div></div>
      </div>

      <div class="grid g-3">
        <div class="card span-2">
          <div class="toolbar inner">
            <select id="a-status" aria-label="依處理狀態篩選">${U.options(['未結案', '全部', '待處理', '處理中', '已結案'], alertFilter.status)}</select>
            <select id="a-level" aria-label="依預警等級篩選"><option value="">全部等級</option>${U.options(['高', '中', '低'], alertFilter.level)}</select>
          </div>
          <div id="alert-list" class="alert-list"></div>
        </div>
        <div class="card">
          <div class="card-head"><h4>未結案預警類型</h4></div>
          <div class="chart-box tall"><canvas id="c-alert-type"></canvas></div>
        </div>
      </div>`;
    AIActions.mountAlertToolbar(el, isLeaderOrPM());

    if (!typeKeys.length) noData('c-alert-type', '目前沒有未結案預警'); else U.chart('c-alert-type', {
      type: 'bar',
      data: { labels: typeKeys, datasets: [{ data: typeKeys.map((k) => types[k]), backgroundColor: '#f59e0b' }] },
      options: baseChartOpts({ indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { precision: 0 } } } })
    });

    const list = el.querySelector('#alert-list');
    function draw() {
      const shown = rows.filter((a) => {
        if (alertFilter.status === '未結案' && a.handle_status === '已結案') return false;
        if (!['未結案', '全部'].includes(alertFilter.status) && a.handle_status !== alertFilter.status) return false;
        if (alertFilter.level && a.alert_level !== alertFilter.level) return false;
        return true;
      });
      list.innerHTML = shown.map((a) => {
        const canHandle = isLeaderOrPM() || a.handler_id === me().member_id;
        const lvCls = a.alert_level === '高' ? 'bad' : a.alert_level === '中' ? 'warn' : 'ok';
        return `<article class="alert-card ${lvCls}" data-id="${U.esc(a.alert_id)}">
          <header>
            <span class="chip ${lvCls}">${U.esc(a.alert_level || '—')}</span>
            <b>${U.esc(a.alert_type || '預警')}</b>
            <span class="muted small">${U.esc(a.alert_id)}・${U.dateTime(a.alert_time)}</span>
            <span class="spacer"></span>${U.chip(a.handle_status)}
          </header>
          <div class="alert-meta small">
            <span>任務 <b>${U.esc(a.task_id || '—')}</b></span>
            <span>活動 <b>${U.esc(API.campaignName(a.campaign_id))}</b></span>
            <span>觸發條件 <b>${U.esc(a.trigger_condition || '—')}</b></span>
            <span>處理人 <b>${U.esc(API.memberName(a.handler_id))}</b></span>
            <span>建議期限 <b>${U.date(a.suggested_due)}</b></span>
          </div>
          ${a.ai_summary ? `<div class="ai-box"><div class="ai-tag">AI 分析</div>${U.esc(a.ai_summary)}</div>` : ''}
          ${a.ai_suggestion ? `<div class="ai-box suggest"><div class="ai-tag">建議措施</div><div class="pre">${U.esc(a.ai_suggestion)}</div></div>` : ''}
          ${a.handle_result ? `<div class="small"><b>處理結果：</b>${U.esc(a.handle_result)}</div>` : ''}
          ${canHandle ? `<footer><button class="btn small outline" data-handle>更新處理狀態</button></footer>` : ''}
        </article>`;
      }).join('') || emptyState('沒有符合條件的預警');

      list.querySelectorAll('[data-handle]').forEach((b) => {
        b.onclick = () => openAlertModal(rows.find((x) => x.alert_id === b.closest('.alert-card').dataset.id));
      });
    }
    draw();
    el.querySelector('#a-status').onchange = (e) => { alertFilter.status = e.target.value; draw(); };
    el.querySelector('#a-level').onchange = (e) => { alertFilter.level = e.target.value; draw(); };
  }

  function openAlertModal(a) {
    const lead = isLeaderOrPM();
    const body = `
      <form id="alert-form" class="form-grid">
        <label>處理狀態<select name="handle_status">${U.options(API.opts('預警處理狀態', ['待處理', '處理中', '已結案']), a.handle_status)}</select></label>
        <label>處理負責人<select name="handler_id" ${lead ? '' : 'disabled'}>${U.options((API.cache.members || []).map((m) => m.member_id), a.handler_id, { blank: true, labels: Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, m.name])) })}</select></label>
        <label class="span-2">處理結果<textarea name="handle_result" rows="3">${U.esc(a.handle_result || '')}</textarea></label>
        ${lead ? `
        <div class="form-section span-2">AI 建議審核</div>
        <label>審核結果<select name="review_result">${U.options(['採納', '部分採納', '不採納'], a.review_result, { blank: true })}</select></label>
        <label>審核意見<input name="review_comment" value="${U.esc(a.review_comment || '')}"></label>` : ''}
      </form>
      <div class="form-error" id="alert-error"></div>`;
    const m = U.openModal({
      title: `${a.alert_id}｜${a.alert_type || '預警'}`, body,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">儲存</button>'
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    AIActions.mountAlertDecision(m, a, lead);
    m.querySelector('#btn-save').onclick = async (ev) => {
      const f = U.formData(m.querySelector('#alert-form'));
      const patch = { handle_status: f.handle_status, handle_result: f.handle_result || null };
      if (f.handle_status === '已結案' && a.handle_status !== '已結案') patch.closed_at = new Date().toISOString();
      if (f.handle_status !== '已結案') patch.closed_at = null;
      if (lead) {
        patch.handler_id = f.handler_id || null;
        if ((f.review_result || '') !== (a.review_result || '') || (f.review_comment || '') !== (a.review_comment || '')) {
          Object.assign(patch, {
            review_result: f.review_result || null, review_comment: f.review_comment || null,
            reviewer_id: me().member_id, reviewed_at: new Date().toISOString()
          });
        }
      }
      ev.target.disabled = true;
      try {
        await API.updateWithVersion('ai_alerts', 'alert_id', a.alert_id, a.version, patch);
        U.toast('已更新預警', 'ok');
        U.closeModal();
        App.renderPage();
      } catch (e) {
        m.querySelector('#alert-error').textContent = e.message;
        ev.target.disabled = false;
      }
    };
  }

  // =====================================================================
  // 4. 風險與問題
  // =====================================================================
  async function risks(el) {
    const [rk, is] = await Promise.all([API.q.risks(), API.q.issues()]).then(([a, b]) => [API.check(a, '讀取風險'), API.check(b, '讀取問題')]);
    const openRisks = rk.filter((r) => r.status !== '已結案');
    const openIssues = is.filter((i) => i.status !== '已解決');
    const midMin = U.num(API.cache.settings?.['風險中級最低分'] || 6);
    const highMin = U.num(API.cache.settings?.['風險高級最低分'] || 15);

    // 5×5 風險矩陣
    const cell = {};
    openRisks.forEach((r) => { const k = `${r.probability}-${r.impact}`; (cell[k] = cell[k] || []).push(r); });
    let matrix = '<div class="matrix"><div class="m-ylabel">發生機率</div><div class="m-grid">';
    for (let p = 5; p >= 1; p--) {
      matrix += `<div class="m-axis">${p}</div>`;
      for (let i = 1; i <= 5; i++) {
        const score = p * i;
        const cls = score >= highMin ? 'bad' : score >= midMin ? 'warn' : 'ok';
        const items = cell[`${p}-${i}`] || [];
        matrix += `<div class="m-cell ${cls} ${items.length ? 'has' : ''}" title="${items.map((x) => x.name).join('\n')}">
          ${items.length ? `<b>${items.length}</b>` : ''}</div>`;
      }
    }
    matrix += '<div></div>' + [1, 2, 3, 4, 5].map((i) => `<div class="m-axis">${i}</div>`).join('');
    matrix += '</div><div class="m-xlabel">影響程度</div></div>';

    el.innerHTML = `
      <div class="grid g-3">
        <div class="card">
          <div class="card-head"><h4>風險矩陣（未結案 ${openRisks.length} 項）</h4></div>
          ${matrix}
          <div class="legend small"><span class="dot bad"></span>高（≥${highMin}） <span class="dot warn"></span>中（≥${midMin}） <span class="dot ok"></span>低</div>
        </div>
        <div class="card span-2">
          <div class="card-head"><h4>風險清單</h4>${isLeaderOrPM() ? '<button class="btn small primary" id="btn-new-risk">＋ 新增風險</button>' : ''}</div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>風險</th><th>類型</th><th>分數</th><th>等級</th><th>負責人</th><th>應對期限</th><th>狀態</th></tr></thead>
            <tbody>${rk.map((r) => `<tr data-risk="${U.esc(r.risk_id)}" class="${isLeaderOrPM() ? 'clickable' : ''}">
              <td><div class="cell-title">${U.esc(r.name)}</div><div class="muted small">${U.esc(r.risk_id)}${r.task_id ? '・' + U.esc(r.task_id) : ''}</div></td>
              <td>${U.esc(r.risk_type || '—')}</td>
              <td><b>${U.esc(r.risk_score ?? '—')}</b><span class="muted small"> (${U.esc(r.probability)}×${U.esc(r.impact)})</span></td>
              <td>${U.chip(r.risk_level)}</td>
              <td>${U.esc(API.memberName(r.owner_id))}</td>
              <td class="${r.response_due && r.response_due < U.today() && r.status !== '已結案' ? 'bad-text' : ''}">${U.date(r.response_due)}</td>
              <td>${U.chip(r.status)}</td></tr>`).join('') || `<tr><td colspan="7">${emptyState('沒有風險資料')}</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h4>問題追蹤（未解決 ${openIssues.length} 項）</h4>${isLeaderOrPM() ? '<button class="btn small primary" id="btn-new-issue">＋ 新增問題</button>' : ''}</div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>問題</th><th>嚴重程度</th><th>負責人</th><th>發現日</th><th>預計解決</th><th>逾期</th><th>升級</th><th>狀態</th></tr></thead>
          <tbody>${is.map((i) => `<tr data-issue="${U.esc(i.issue_id)}" class="${isLeaderOrPM() || i.owner_id === me().member_id ? 'clickable' : ''}">
            <td><div class="cell-title">${U.esc(i.name)}</div><div class="muted small">${U.esc(i.issue_id)}${i.task_id ? '・' + U.esc(i.task_id) : ''}</div></td>
            <td>${U.chip(i.severity)}</td>
            <td>${U.esc(API.memberName(i.owner_id))}</td>
            <td>${U.date(i.found_date)}</td>
            <td>${U.date(i.due_date)}</td>
            <td class="${i.overdue_days > 0 ? 'bad-text' : ''}">${i.overdue_days > 0 ? i.overdue_days + ' 天' : '—'}</td>
            <td>${i.escalated ? '<span class="chip bad">已升級</span>' : '—'}</td>
            <td>${U.chip(i.status)}</td></tr>`).join('') || `<tr><td colspan="8">${emptyState('沒有問題資料')}</td></tr>`}</tbody>
        </table></div>
      </div>`;

    U.rowsA11y(el);
    if (isLeaderOrPM()) {
      el.querySelectorAll('[data-risk]').forEach((tr) => {
        tr.onclick = () => openRiskModal(rk.find((r) => r.risk_id === tr.dataset.risk), midMin, highMin);
      });
      el.querySelectorAll('[data-issue]').forEach((tr) => {
        tr.onclick = () => openIssueModal(is.find((x) => x.issue_id === tr.dataset.issue));
      });
      el.querySelector('#btn-new-risk').onclick = () => openRiskModal(null, midMin, highMin);
      el.querySelector('#btn-new-issue').onclick = () => openIssueModal(null);
    }
  }

  // 風險：新增或編輯（r 為 null 代表新增）
  function openRiskModal(r, midMin, highMin) {
    const isNew = !r;
    r = r || { probability: 3, impact: 3, status: '待處理', owner_id: me().member_id };
    const memberIds = (API.cache.members || []).map((m) => m.member_id);
    const memberLabels = Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, m.name]));
    const campIds = (API.cache.campaigns || []).map((c) => c.campaign_id);
    const campLabels = Object.fromEntries((API.cache.campaigns || []).map((c) => [c.campaign_id, c.name]));
    const body = `
      <form id="risk-form" class="form-grid">
        <label class="span-2">風險名稱<input name="name" required maxlength="100" value="${U.esc(r.name || '')}"></label>
        <label>風險類型<select name="risk_type">${U.options(API.opts('風險類型', ['進度', '成本', '人力', '技術', '品質', '外部']), r.risk_type, { blank: true })}</select></label>
        <label>風險負責人<select name="owner_id">${U.options(memberIds, r.owner_id, { blank: true, labels: memberLabels })}</select></label>
        <label>關聯活動<select name="campaign_id">${U.options(campIds, r.campaign_id, { blank: true, labels: campLabels })}</select></label>
        <label>關聯任務ID<input name="task_id" value="${U.esc(r.task_id || '')}" placeholder="例如 T-003，可留空"></label>
        <label>發生機率（1–5）<input type="number" name="probability" min="1" max="5" value="${U.esc(r.probability ?? 3)}" required></label>
        <label>影響程度（1–5）<input type="number" name="impact" min="1" max="5" value="${U.esc(r.impact ?? 3)}" required></label>
        <label>風險狀態<select name="status">${U.options(API.opts('風險狀態', ['待處理', '處理中', '已結案']), r.status)}</select></label>
        <label>應對期限<input type="date" name="response_due" value="${U.esc(r.response_due || '')}"></label>
        <label class="span-2">風險描述<textarea name="description" rows="2">${U.esc(r.description || '')}</textarea></label>
        <label class="span-2">應對措施<textarea name="response_plan" rows="3">${U.esc(r.response_plan || '')}</textarea></label>
        <p class="muted small span-2">風險等級依分數（機率×影響）自動判定：≥${highMin} 高、≥${midMin} 中、其餘低。</p>
      </form><div class="form-error" id="risk-error"></div>`;
    const m = U.openModal({
      title: isNew ? '新增風險' : `${r.risk_id}｜${r.name}`, body, wide: true, draftKey: `risk:${r.risk_id || 'new'}:${r.version || 0}`,
      footer: `<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">${isNew ? '建立' : '儲存'}</button>`
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#risk-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      const score = U.num(f.probability) * U.num(f.impact);
      const row = {
        name: f.name, risk_type: f.risk_type || null, owner_id: f.owner_id || null,
        campaign_id: f.campaign_id || null, task_id: f.task_id ? f.task_id.toUpperCase() : null,
        probability: U.num(f.probability), impact: U.num(f.impact),
        risk_level: score >= highMin ? '高' : score >= midMin ? '中' : '低',
        status: f.status, response_due: f.response_due || null,
        description: f.description || null, response_plan: f.response_plan || null,
        last_assessed: U.today()
      };
      ev.target.disabled = true;
      try {
        if (isNew) await API.insert('risks', row, '新增風險');
        else await API.updateWithVersion('risks', 'risk_id', r.risk_id, r.version, row);
        U.toast(isNew ? '風險已建立' : '風險已更新', 'ok'); U.closeModal(); App.renderPage();
      } catch (e) { m.querySelector('#risk-error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  // 問題：新增或編輯（i 為 null 代表新增）
  function openIssueModal(i) {
    const isNew = !i;
    i = i || { status: '待處理', severity: '中', found_date: U.today(), owner_id: me().member_id };
    const memberIds = (API.cache.members || []).map((m) => m.member_id);
    const memberLabels = Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, m.name]));
    const body = `
      <form id="issue-form" class="form-grid">
        <label class="span-2">問題名稱<input name="name" required maxlength="100" value="${U.esc(i.name || '')}"></label>
        <label>嚴重程度<select name="severity">${U.options(API.opts('問題嚴重程度', ['高', '中', '低']), i.severity)}</select></label>
        <label>問題負責人<select name="owner_id">${U.options(memberIds, i.owner_id, { blank: true, labels: memberLabels })}</select></label>
        <label>關聯任務ID<input name="task_id" value="${U.esc(i.task_id || '')}" placeholder="例如 T-003，可留空"></label>
        <label>發現日期<input type="date" name="found_date" value="${U.esc(i.found_date || '')}"></label>
        <label>問題狀態<select name="status">${U.options(API.opts('問題狀態', ['待處理', '處理中', '已解決']), i.status)}</select></label>
        <label>預計解決日<input type="date" name="due_date" value="${U.esc(i.due_date || '')}"></label>
        <label>實際解決日<input type="date" name="resolved_date" value="${U.esc(i.resolved_date || '')}"></label>
        <label class="check"><input type="checkbox" name="escalated" ${i.escalated ? 'checked' : ''}> 升級處理</label>
        <label class="span-2">問題描述<textarea name="description" rows="2">${U.esc(i.description || '')}</textarea></label>
        <label class="span-2">解決方案<textarea name="solution" rows="3">${U.esc(i.solution || '')}</textarea></label>
      </form><div class="form-error" id="issue-error"></div>`;
    const m = U.openModal({
      title: isNew ? '新增問題' : `${i.issue_id}｜${i.name}`, body, wide: true, draftKey: `issue:${i.issue_id || 'new'}:${i.version || 0}`,
      footer: `<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">${isNew ? '建立' : '儲存'}</button>`
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#issue-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      const row = {
        name: f.name, severity: f.severity, owner_id: f.owner_id || null,
        task_id: f.task_id ? f.task_id.toUpperCase() : null, found_date: f.found_date || null,
        status: f.status, due_date: f.due_date || null,
        resolved_date: f.status === '已解決' ? (f.resolved_date || U.today()) : (f.resolved_date || null),
        escalated: form.escalated.checked, description: f.description || null, solution: f.solution || null
      };
      ev.target.disabled = true;
      try {
        if (isNew) await API.insert('issues', row, '新增問題');
        else await API.updateWithVersion('issues', 'issue_id', i.issue_id, i.version, row);
        U.toast(isNew ? '問題已建立' : '問題已更新', 'ok'); U.closeModal(); App.renderPage();
      } catch (e) { m.querySelector('#issue-error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  // =====================================================================
  // 5. 行銷活動成效
  // =====================================================================
  async function campaigns(el) {
    const [campsAll, metrics] = await Promise.all([API.q.campaignSummary(), API.q.metrics()])
      .then(([a, b]) => [API.check(a, '讀取活動'), API.check(b, '讀取成效')]);
    const pid = API.currentProjectId();
    const camps = campsAll.filter((c) => !pid || c.project_id === pid);
    const warnRate = U.num(API.cache.settings?.['預算使用警戒比例'] || 0.9);

    const totals = camps.reduce((s, c) => ({
      budget: s.budget + U.num(c.approved_budget), spend: s.spend + U.num(c.actual_spend),
      rev: s.rev + U.num(c.revenue), ad: s.ad + U.num(c.ad_spend), conv: s.conv + U.num(c.conversions)
    }), { budget: 0, spend: 0, rev: 0, ad: 0, conv: 0 });

    el.innerHTML = `
      ${isLeaderOrPM() ? '<div class="section-head"><span class="muted small">點選活動卡片可編輯</span><button class="btn primary" id="btn-new-camp">＋ 新增活動</button></div>' : ''}
      <div class="kpis small-kpis">
        <div class="kpi"><div class="kpi-label">活動數</div><div class="kpi-value">${camps.length}</div></div>
        <div class="kpi"><div class="kpi-label">核定預算</div><div class="kpi-value">${U.money(totals.budget)}</div></div>
        <div class="kpi"><div class="kpi-label">實際支出</div><div class="kpi-value">${U.money(totals.spend)}</div><div class="kpi-sub">${U.pct(totals.spend / (totals.budget || 1))}</div></div>
        <div class="kpi"><div class="kpi-label">整體 ROAS</div><div class="kpi-value ${totals.rev / (totals.ad || 1) < API.roasTarget() ? 'bad-text' : 'ok-text'}">${U.dec(totals.rev / (totals.ad || 1))}</div></div>
        <div class="kpi"><div class="kpi-label">總轉換數</div><div class="kpi-value">${U.int(totals.conv)}</div></div>
      </div>

      <div class="camp-grid">
        ${camps.map((c) => {
          const rate = U.num(c.budget_usage_rate);
          const roasBad = c.roas !== null && U.num(c.roas) < API.roasTarget();
          return `<div class="card camp ${isLeaderOrPM() ? 'clickable-card' : ''}" data-camp-card="${U.esc(c.campaign_id)}">
            <div class="camp-head"><div><b>${U.esc(c.name)}</b><div class="muted small">${U.esc(c.campaign_id)}・${U.date(c.planned_start)} → ${U.date(c.planned_end)}</div></div>${U.chip(c.status)}</div>
            <div class="small">預算使用 ${U.money(c.actual_spend)} / ${U.money(c.approved_budget)}</div>
            <div class="pbar ${rate > 1 ? 'over' : rate >= warnRate ? 'behind' : ''}"><div class="pbar-fill" style="width:${Math.min(100, rate * 100).toFixed(1)}%"></div><span class="pbar-label">${U.pct(rate)}</span></div>
            <div class="camp-stats">
              <div><span>ROAS</span><b class="${roasBad ? 'bad-text' : 'ok-text'}">${c.roas === null ? '—' : U.dec(c.roas)}</b></div>
              <div><span>CTR</span><b>${c.ctr === null ? '—' : U.pct(c.ctr, 2)}</b></div>
              <div><span>轉換</span><b>${U.int(c.conversions)}</b></div>
              <div><span>營收</span><b>${U.money(c.revenue)}</b></div>
              <div><span>任務</span><b>${U.int(c.task_count)}</b></div>
              <div><span>逾期</span><b class="${U.num(c.overdue_tasks) ? 'bad-text' : ''}">${U.int(c.overdue_tasks)}</b></div>
            </div>
          </div>`;
        }).join('') || emptyState('尚無行銷活動資料')}
      </div>

      <div class="grid g-2">
        <div class="card"><div class="card-head"><h4>各活動轉換數</h4></div><div class="chart-box"><canvas id="c-conv"></canvas></div></div>
        <div class="card"><div class="card-head"><h4>各活動點擊率（CTR）</h4></div><div class="chart-box"><canvas id="c-ctr"></canvas></div></div>
      </div>`;

    if (!camps.length) noData('c-conv', '尚無行銷活動'); else U.chart('c-conv', {
      type: 'bar',
      data: { labels: camps.map((c) => c.name), datasets: [{ label: '轉換數', data: camps.map((c) => U.num(c.conversions)), backgroundColor: U.PALETTE }] },
      options: baseChartOpts({ plugins: { legend: { display: false } } })
    });
    if (!camps.length) noData('c-ctr', '尚無行銷活動'); else U.chart('c-ctr', {
      type: 'bar',
      data: { labels: camps.map((c) => c.name), datasets: [{ label: 'CTR', data: camps.map((c) => +(U.num(c.ctr) * 100).toFixed(2)), backgroundColor: '#0ea5e9' }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => ` ${x.raw}%` } } }, scales: { y: { ticks: { callback: (v) => v + '%' } } } })
    });
    void metrics; // 每日趨勢已顯示於首頁

    // 組長、專案經理可以直接在這裡新增或編輯活動（不必再切到其他頁面）
    if (isLeaderOrPM()) {
      el.querySelector('#btn-new-camp').onclick = () => openCampaignModal(null);
      U.rowsA11y(el);
      el.querySelectorAll('[data-camp-card]').forEach((card) => {
        card.onclick = async () => {
          try {
            const row = API.check(await API.sb.from('campaigns').select('*').eq('campaign_id', card.dataset.campCard).single(), '讀取活動');
            openCampaignModal(row);
          } catch (e) { U.toast(e.message, 'bad'); }
        };
      });
    }
  }

  // =====================================================================
  // 6. 組員負荷（專案經理、組長）
  // =====================================================================
  async function members(el) {
    const [work, dq] = await Promise.all([API.q.workload(), isPM() ? API.q.dataQuality() : Promise.resolve({ data: [] })])
      .then(([a, b]) => [API.check(a, '讀取負荷'), API.check(b, '讀取品質檢核')]);

    el.innerHTML = `
      <div class="grid g-3">
        <div class="card span-2"><div class="card-head"><h4>本週工作負荷率</h4></div><div class="chart-box tall"><canvas id="c-work2"></canvas></div></div>
        ${isPM() ? `<div class="card"><div class="card-head"><h4>資料品質檢核</h4></div>
          <ul class="mini-list">${dq.map((d) => `<li><span class="dot ${U.num(d.problem_count) ? 'bad' : 'ok'}"></span>
            <div>${U.esc(d.check_item)}</div><b class="${U.num(d.problem_count) ? 'bad-text' : 'ok-text'}">${U.int(d.problem_count)}</b></li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="card no-pad"><div class="table-wrap"><table class="table">
        <thead><tr><th>組員</th><th>角色</th><th>可投入／已分配</th><th>負荷率</th><th>任務</th><th>進行中</th><th>已完成</th><th>逾期</th><th>最後回報</th></tr></thead>
        <tbody>${work.map((w) => `<tr>
          <td><div class="cell-title">${U.light(w.workload_light)} ${U.esc(w.name)}</div><div class="muted small">${U.esc(w.member_id)}・${U.esc(w.department || '')}</div></td>
          <td><span class="role-pill" style="--role:${U.ROLE_COLOR[w.project_role] || '#475569'}">${U.esc(w.project_role)}</span></td>
          <td>${U.dec(w.weekly_hours, 1)} / ${U.dec(w.allocated_hours_this_week, 1)} h</td>
          <td>${U.progressBar(Math.min(1, U.num(w.workload_rate)))}<div class="small muted">${U.pct(w.workload_rate)}</div></td>
          <td>${U.int(w.task_count)}</td><td>${U.int(w.in_progress_count)}</td><td>${U.int(w.done_count)}</td>
          <td class="${U.num(w.overdue_count) ? 'bad-text' : ''}">${U.int(w.overdue_count)}</td>
          <td class="small">${U.dateTime(w.last_report_at)}</td></tr>`).join('')}</tbody>
      </table></div></div>`;

    drawWorkloadChart('c-work2', work);
  }

  // =====================================================================
  // 7. 專案與活動設定（專案經理、組長）
  // =====================================================================
  async function projects(el) {
    const [ov, camps] = await Promise.all([API.q.projectOverview(), API.q.campaigns()])
      .then(([a, b]) => [API.check(a, '讀取專案'), API.check(b, '讀取活動')]);
    const pid = API.currentProjectId();
    const shownCamps = camps.filter((c) => !pid || c.project_id === pid || !c.project_id);

    el.innerHTML = `
      <div class="section-head">
        <h3>專案（${ov.length}）</h3>
        <div class="row-actions">
          <button class="btn outline" id="btn-import" title="從 Excel、CSV、Google 試算表或 MS Project 匯入">⤒ 匯入專案檔案</button>
          <button class="btn primary" id="btn-new-project">＋ 新增專案</button>
        </div>
      </div>
      <div class="camp-grid">
        ${ov.map((p) => `
          <div class="card camp ${p.project_id === pid ? 'selected' : ''}">
            <div class="camp-head"><div><b>${U.esc(p.name)}</b>
              <div class="muted small">${U.esc(p.project_id)}・${U.date(p.start_date)} → ${U.date(p.planned_end_date)}</div></div>${U.chip(p.status)}</div>
            ${U.progressBar(p.overall_actual_progress, p.overall_planned_progress)}
            <div class="camp-stats">
              <div><span>活動</span><b>${U.int(p.campaign_count)}</b></div>
              <div><span>未完成任務</span><b>${U.int(p.open_tasks)}</b></div>
              <div><span>總預算</span><b>${U.money(p.total_budget)}</b></div>
            </div>
            <div class="row-actions">
              ${p.project_id === pid ? '<span class="chip info">目前專案</span>' : `<button class="btn small ghost" data-use="${U.esc(p.project_id)}">切換到此專案</button>`}
              <span class="spacer"></span>
              <button class="btn small outline" data-edit-project="${U.esc(p.project_id)}">編輯</button>
            </div>
          </div>`).join('') || emptyState('還沒有專案，按「新增專案」開始')}
      </div>

      <div class="section-head">
        <h3>行銷活動（${U.esc(API.projectName(pid))}）</h3>
        <button class="btn primary" id="btn-new-campaign" ${ov.length ? '' : 'disabled'}>＋ 新增活動</button>
      </div>
      <div class="card no-pad"><div class="table-wrap"><table class="table">
        <thead><tr><th>活動</th><th>類型</th><th>負責人</th><th>期間</th><th>核定預算</th><th>狀態</th></tr></thead>
        <tbody>${shownCamps.map((c) => `<tr class="clickable" data-camp="${U.esc(c.campaign_id)}">
          <td><div class="cell-title">${U.esc(c.name)}</div><div class="muted small">${U.esc(c.campaign_id)}</div></td>
          <td>${U.esc(c.campaign_type || '—')}</td>
          <td>${U.esc(API.memberName(c.owner_id))}</td>
          <td class="small">${U.date(c.planned_start)} → ${U.date(c.planned_end)}</td>
          <td>${U.money(c.approved_budget)}</td>
          <td>${U.chip(c.status)}</td></tr>`).join('') || `<tr><td colspan="6">${emptyState('這個專案還沒有行銷活動')}</td></tr>`}</tbody>
      </table></div></div>`;

    el.querySelector('#btn-new-project').onclick = () => openProjectModal(null);
    el.querySelector('#btn-import').onclick = () => Importer.open();
    el.querySelector('#btn-new-campaign').onclick = () => openCampaignModal(null);
    el.querySelectorAll('[data-edit-project]').forEach((b) => {
      b.onclick = async () => {
        const row = API.check(await API.sb.from('projects').select('*').eq('project_id', b.dataset.editProject).single(), '讀取專案');
        openProjectModal(row);
      };
    });
    el.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => { API.setProject(b.dataset.use); App.refreshAll(); }; });
    U.rowsA11y(el);
    el.querySelectorAll('[data-camp]').forEach((tr) => {
      tr.onclick = () => openCampaignModal(camps.find((c) => c.campaign_id === tr.dataset.camp));
    });
  }

  function openProjectModal(p) {
    const isNew = !p;
    p = p || { status: '進行中', start_date: U.today(), owner_name: me().name };
    const body = `
      <form id="proj-form" class="form-grid">
        <label class="span-2">專案名稱<input name="name" required maxlength="80" value="${U.esc(p.name || '')}"></label>
        <label>專案負責人<input name="owner_name" maxlength="40" value="${U.esc(p.owner_name || '')}"></label>
        <label>專案狀態<select name="status">${U.options(API.opts('專案狀態', ['未開始', '進行中', '暫停', '完成']), p.status)}</select></label>
        <label>開始日期<input type="date" name="start_date" value="${U.esc(p.start_date || '')}"></label>
        <label>預計結束日期<input type="date" name="planned_end_date" value="${U.esc(p.planned_end_date || '')}"></label>
        <label>專案總預算<input type="number" name="total_budget" min="0" step="1000" value="${U.esc(p.total_budget ?? '')}"></label>
        <label>預測完成日期<input type="date" name="forecast_end_date" value="${U.esc(p.forecast_end_date || '')}"></label>
        <label class="span-2">專案目標<textarea name="objective" rows="3">${U.esc(p.objective || '')}</textarea></label>
      </form><div class="form-error" id="proj-error"></div>`;
    const m = U.openModal({
      title: isNew ? '新增專案' : `編輯專案｜${p.name}`, body, wide: true, draftKey: `project:${p.project_id || 'new'}:${p.version || 0}`,
      footer: `${!isNew && isPM() ? '<button class="btn danger ghost" id="btn-del">刪除</button>' : ''}<span class="spacer"></span>
        <button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">${isNew ? '建立' : '儲存'}</button>`
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#proj-form');
      if (!form.reportValidity()) return;
      const f = U.emptyToNull(U.formData(form));
      if (f.start_date && f.planned_end_date && f.planned_end_date < f.start_date) {
        m.querySelector('#proj-error').textContent = '結束日期不可早於開始日期'; return;
      }
      f.total_budget = f.total_budget === null ? 0 : U.num(f.total_budget);
      ev.target.disabled = true;
      try {
        if (isNew) {
          const row = await API.insert('projects', f, '新增專案');
          API.setProject(row.project_id);
        } else {
          await API.updateWithVersion('projects', 'project_id', p.project_id, p.version, f);
        }
        U.toast('專案已儲存', 'ok'); U.closeModal(); App.refreshAll();
      } catch (e) { m.querySelector('#proj-error').textContent = e.message; ev.target.disabled = false; }
    };
    const del = m.querySelector('#btn-del');
    if (del) del.onclick = async () => {
      if (!(await U.confirmBox(`刪除專案「${p.name}」後，所有成員都看不到這個專案，專案邀請碼也會失效。\n（活動與任務資料會保留，可在「公司設定 → 最近刪除」還原）`, '刪除專案', true, { typeText: p.name }))) return;
      try {
        await API.softDelete('projects', 'project_id', p, '專案');
        await API.loadLookups(true).catch(() => {}); App.refreshAll();
      } catch (e) { U.toast(e.message, 'bad', 6000); }
    };
  }

  function openCampaignModal(c) {
    const isNew = !c;
    c = c || { project_id: API.currentProjectId(), status: '規劃中', owner_id: me().member_id, planned_start: U.today() };
    const projIds = (API.cache.projects || []).map((p) => p.project_id);
    const projLabels = Object.fromEntries((API.cache.projects || []).map((p) => [p.project_id, p.name]));
    const memberIds = (API.cache.members || []).map((x) => x.member_id);
    const memberLabels = Object.fromEntries((API.cache.members || []).map((x) => [x.member_id, x.name]));
    const body = `
      <form id="camp-form" class="form-grid">
        <label class="span-2">活動名稱<input name="name" required maxlength="80" value="${U.esc(c.name || '')}"></label>
        <label>所屬專案<select name="project_id" required>${U.options(projIds, c.project_id, { labels: projLabels })}</select></label>
        <label>活動類型<select name="campaign_type">${U.options(API.opts('活動類型', ['品牌曝光', '會員招募', '轉換促購', '口碑行銷', '再行銷', '其他']), c.campaign_type, { blank: true })}</select></label>
        <label>活動負責人<select name="owner_id">${U.options(memberIds, c.owner_id, { blank: true, labels: memberLabels })}</select></label>
        <label>活動狀態<select name="status">${U.options(API.opts('活動狀態', ['規劃中', '待審核', '進行中', '已完成', '已取消']), c.status)}</select></label>
        <label>計畫開始<input type="date" name="planned_start" value="${U.esc(c.planned_start || '')}"></label>
        <label>計畫結束<input type="date" name="planned_end" value="${U.esc(c.planned_end || '')}"></label>
        <label>核定預算<input type="number" name="approved_budget" min="0" step="1000" value="${U.esc(c.approved_budget ?? '')}"></label>
        <label>目標受眾<input name="target_audience" maxlength="100" value="${U.esc(c.target_audience || '')}"></label>
        <label class="span-2">活動目標<textarea name="objective" rows="2">${U.esc(c.objective || '')}</textarea></label>
        <label class="span-2">備註<textarea name="notes" rows="2">${U.esc(c.notes || '')}</textarea></label>
      </form><div class="form-error" id="camp-error"></div>`;
    const m = U.openModal({
      title: isNew ? '新增行銷活動' : `${c.campaign_id}｜${c.name}`, body, wide: true, draftKey: `campaign:${c.campaign_id || 'new'}:${c.version || 0}`,
      footer: `${!isNew && isPM() ? '<button class="btn danger ghost" id="btn-del">刪除</button>' : ''}<span class="spacer"></span>
        <button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">${isNew ? '建立' : '儲存'}</button>`
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#camp-form');
      if (!form.reportValidity()) return;
      const f = U.emptyToNull(U.formData(form));
      if (f.planned_start && f.planned_end && f.planned_end < f.planned_start) {
        m.querySelector('#camp-error').textContent = '結束日期不可早於開始日期'; return;
      }
      f.approved_budget = f.approved_budget === null ? 0 : U.num(f.approved_budget);
      ev.target.disabled = true;
      try {
        if (isNew) await API.insert('campaigns', { ...f, applicant_id: me().member_id }, '新增活動');
        else await API.updateWithVersion('campaigns', 'campaign_id', c.campaign_id, c.version, f);
        U.toast('活動已儲存', 'ok'); U.closeModal(); App.refreshAll();
      } catch (e) { m.querySelector('#camp-error').textContent = e.message; ev.target.disabled = false; }
    };
    const del = m.querySelector('#btn-del');
    if (del) del.onclick = async () => {
      if (!(await U.confirmBox(`確定要刪除活動「${c.name}」嗎？\n刪除後 8 秒內可按「復原」。`, '刪除', true))) return;
      try {
        await API.softDelete('campaigns', 'campaign_id', c, '活動');
        App.refreshAll();
      } catch (e) { U.toast(e.message, 'bad', 6000); }
    };
  }

  // =====================================================================
  // 8. 成員與帳號（專案經理）
  // =====================================================================
  const siteBase = () => location.origin + location.pathname;
  const joinLink = (code) => `${siteBase()}?join=${encodeURIComponent(code)}`;
  const fmtCode = (c) => String(c || '').replace(/^(.{4})(.{4})$/, '$1 $2');

  // 舊版資料庫沒有新函式時不讓整頁壞掉
  async function softRpc(name, args) {
    const { data, error } = await API.sb.rpc(name, args);
    if (error) { console.warn(name, error); return null; }
    return data || [];
  }

  async function accounts(el) {
    const [[members, profiles, invites], requests, projInvites, projMembersRes] = await Promise.all([
      Promise.all([
        API.sb.from('members').select('*').eq('is_deleted', false).order('member_id'),
        API.q.profiles(), API.q.invitations()
      ]).then(([a, b, c]) => [API.check(a, '讀取成員'), API.check(b, '讀取帳號'), API.check(c, '讀取邀請')]),
      softRpc('list_join_requests'),
      softRpc('list_project_invites'),
      API.sb.from('project_members').select('project_id,member_id')
    ]);
    const projMembers = projMembersRes.error ? [] : (projMembersRes.data || []);
    const reqs = requests || [];
    const codesReady = projInvites !== null;

    const profOf = (id) => profiles.find((p) => p.member_id === id);
    const inviteOf = (id) => invites.find((i) => i.member_id === id && i.status === '待接受');
    const projName = (pid) => (API.cache.projects || []).find((x) => x.project_id === pid)?.name
      || (projInvites || []).find((x) => x.project_id === pid)?.project_name || pid;

    const rows = members.map((mb) => {
      const p = profOf(mb.member_id);
      const inv = inviteOf(mb.member_id);
      let state, cls;
      if (p) { state = p.auth_status === '已授權' ? '已啟用' : '已停用'; cls = p.auth_status === '已授權' ? 'ok' : 'bad'; }
      else if (inv) { state = '邀請中'; cls = 'warn'; }
      else { state = '未邀請'; cls = 'muted'; }
      const projs = projMembers.filter((x) => x.member_id === mb.member_id).map((x) => projName(x.project_id));
      return { mb, p, inv, state, cls, projs };
    });
    const count = (s) => rows.filter((r) => r.state === s).length;

    const reqHtml = reqs.length ? `
      <div class="section-head"><h3>待審核的加入申請 <span class="chip warn">${reqs.length}</span></h3>
        ${reqs.length > 1 ? '<button class="btn small outline" id="btn-approve-all">全部核准</button>' : ''}</div>
      <div class="req-list">${reqs.map((r) => `
        <div class="card req-card" data-req="${U.esc(r.request_id)}">
          <div class="req-main">
            <div class="cell-title">${U.esc(r.name)}${r.department ? ` <span class="muted small">・${U.esc(r.department)}</span>` : ''}</div>
            <div class="muted small">${U.esc(r.email)}</div>
            <div class="small">申請加入：<b>${U.esc(r.project_name || r.project_id)}</b>　<span class="muted">${U.dateTime(r.created_at)}</span></div>
          </div>
          <div class="req-actions">
            <button class="btn small primary" data-approve="${U.esc(r.request_id)}">核准（組員）</button>
            <button class="btn small ghost" data-reject="${U.esc(r.request_id)}">拒絕</button>
          </div>
        </div>`).join('')}</div>` : '';

    const codesHtml = !codesReady
      ? `<div class="card notice">專案邀請碼尚未啟用（資料庫需要套用 <code>project_invite_codes</code> 更新）。目前仍可使用下方「個別邀請」。</div>`
      : !projInvites.length
        ? `<div class="card empty">尚未建立專案。到「專案管理」新增專案後，就會自動產生邀請碼。</div>`
        : `<div class="code-grid">${projInvites.map((c) => `
        <div class="card code-card ${c.is_enabled ? '' : 'off'}">
          <div class="code-head">
            <div class="cell-title" title="${U.esc(c.project_name)}">${U.esc(c.project_name)}</div>
            <span class="chip ${c.is_enabled ? 'ok' : 'muted'}">${c.is_enabled ? '開放加入' : '已停用'}</span>
          </div>
          <div class="code-value mono" aria-label="邀請碼 ${U.esc(c.invite_code.split('').join(' '))}">${U.esc(fmtCode(c.invite_code))}</div>
          <div class="muted small">已用此碼加入 ${c.member_count} 人${c.pending_count ? `・<b class="warn-text">待審核 ${c.pending_count}</b>` : ''}${c.rotated_at ? `・${U.date(c.rotated_at)} 換過碼` : ''}</div>
          <div class="code-actions">
            <button class="btn small primary" data-share="${U.esc(c.project_id)}" ${c.is_enabled ? '' : 'disabled'}>${navigator.share ? '分享邀請' : '複製邀請連結'}</button>
            <button class="btn small outline" data-copy-text="${U.esc(c.project_id)}" ${c.is_enabled ? '' : 'disabled'}>複製說明</button>
            <button class="btn small ghost" data-rotate="${U.esc(c.project_id)}">換新碼</button>
            <button class="btn small ghost" data-enable="${U.esc(c.project_id)}" data-on="${c.is_enabled ? '0' : '1'}">${c.is_enabled ? '停用' : '啟用'}</button>
          </div>
        </div>`).join('')}</div>`;

    el.innerHTML = `
      <div class="kpis small-kpis">
        <div class="kpi"><div class="kpi-label">成員</div><div class="kpi-value">${rows.length}</div></div>
        <div class="kpi"><div class="kpi-label">已啟用</div><div class="kpi-value ok-text">${count('已啟用')}</div></div>
        <div class="kpi"><div class="kpi-label">待審核申請</div><div class="kpi-value warn-text">${reqs.length}</div></div>
        <div class="kpi"><div class="kpi-label">個別邀請中</div><div class="kpi-value">${count('邀請中')}</div></div>
        <div class="kpi"><div class="kpi-label">已停用</div><div class="kpi-value bad-text">${count('已停用')}</div></div>
      </div>

      ${reqHtml}

      <div class="section-head"><h3>專案邀請碼</h3><span class="muted small">一個專案一組碼，傳給整個團隊即可</span></div>
      ${codesHtml}

      <div class="card howto">
        <b>員工加入步驟：</b>
        ① 按「${navigator.share ? '分享邀請' : '複製邀請連結'}」傳到 LINE 群組 → ② 員工點連結、用自己的 Email 註冊並登入
        → ③ 邀請碼會自動帶入，填姓名後送出申請 → ④ 你在這頁按「核准」，對方就能使用（預設為「組員」，可再調整角色）。
        <div class="muted small" style="margin-top:6px">邀請碼不會過期；外流時按「換新碼」舊碼立即失效，或按「停用」暫停加入。需要直接指定「組長／專案經理」時，用下方「個別邀請」。</div>
      </div>

      <div class="section-head">
        <h3>成員清單</h3>
        <button class="btn outline" id="btn-invite">＋ 個別邀請（可指定角色）</button>
      </div>
      <div class="card no-pad"><div class="table-wrap"><table class="table">
        <thead><tr><th>成員</th><th>部門</th><th>角色</th><th>直屬組長</th><th>帳號狀態</th><th>最後登入</th><th style="min-width:220px">操作</th></tr></thead>
        <tbody>${rows.map(({ mb, p, inv, state, cls, projs }) => `<tr>
          <td><div class="cell-title">${U.esc(mb.name)}${mb.member_id === me().member_id ? ' <span class="chip info">你</span>' : ''}</div>
            <div class="muted small">${U.esc(mb.member_id)}・${U.esc(mb.email || '未填 Email')}</div>
            ${projs.length ? `<div class="proj-chips">${projs.map((n) => `<span class="chip">${U.esc(n)}</span>`).join('')}</div>` : ''}</td>
          <td>${U.esc(mb.department || '—')}</td>
          <td><span class="role-pill" style="--role:${U.ROLE_COLOR[p?.role || mb.project_role] || '#475569'}">${U.esc(p?.role || mb.project_role)}</span>${p?.is_test_account ? ' <span class="chip warn">測試</span>' : ''}</td>
          <td>${U.esc(mb.leader_id ? API.memberName(mb.leader_id) : '—')}</td>
          <td><span class="chip ${cls}">${state}</span>${inv ? `<div class="small mono">碼：<b>${U.esc(inv.invite_code)}</b></div>` : ''}</td>
          <td class="small">${U.dateTime(p?.last_login_at)}</td>
          <td class="row-actions">
            <button class="btn small outline" data-edit="${U.esc(mb.member_id)}">編輯</button>
            ${p && mb.member_id !== me().member_id ? `<button class="btn small ghost" data-toggle="${U.esc(mb.member_id)}">${p.auth_status === '已授權' ? '停用' : '啟用'}</button>` : ''}
            ${inv ? `<button class="btn small ghost" data-copy="${U.esc(inv.invite_code)}">複製邀請</button>
                     <button class="btn small ghost" data-cancel-inv="${U.esc(inv.invitation_id)}">取消邀請</button>` : ''}
            ${!p && !inv && mb.email ? `<button class="btn small ghost" data-reinvite="${U.esc(mb.member_id)}">寄出邀請</button>` : ''}
          </td></tr>`).join('')}</tbody>
      </table></div></div>`;

    const after = async (msg) => { if (msg) U.toast(msg, 'ok'); await API.loadLookups(true).catch(() => {}); App.updateJoinBadge(); App.renderPage(); };

    // --- 加入申請 ---
    el.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        const r = reqs.find((x) => x.request_id === b.dataset.approve);
        b.disabled = true;
        try {
          API.check(await API.sb.rpc('decide_join_request', { p_request_id: r.request_id, p_approve: true, p_note: null }), '核准');
          await after(`已核准「${r.name}」加入 ${r.project_name || ''}`);
        } catch (e) { U.toast(e.message, 'bad', 6000); b.disabled = false; App.renderPage(); }
      };
    });
    el.querySelectorAll('[data-reject]').forEach((b) => {
      b.onclick = () => openRejectModal(reqs.find((x) => x.request_id === b.dataset.reject), after);
    });
    const allBtn = el.querySelector('#btn-approve-all');
    if (allBtn) allBtn.onclick = async () => {
      if (!(await U.confirmBox(`確定要核准全部 ${reqs.length} 件申請嗎？所有人都會以「組員」加入。`, '全部核准'))) return;
      allBtn.disabled = true;
      let ok = 0; const fails = [];
      for (const r of reqs) {
        const { error } = await API.sb.rpc('decide_join_request', { p_request_id: r.request_id, p_approve: true, p_note: null });
        if (error) fails.push(`${r.name}：${error.message}`); else ok += 1;
      }
      if (fails.length) U.toast(`已核准 ${ok} 件；${fails.length} 件失敗：${fails.join('；')}`, 'warn', 8000);
      await after(fails.length ? '' : `已核准 ${ok} 件申請`);
    };

    // --- 專案邀請碼 ---
    const codeOf = (pid) => (projInvites || []).find((x) => x.project_id === pid);
    el.querySelectorAll('[data-share]').forEach((b) => {
      b.onclick = async () => {
        const c = codeOf(b.dataset.share);
        const text = projectInviteText(c);
        if (navigator.share) {
          try { await navigator.share({ title: `加入「${c.project_name}」`, text, url: joinLink(c.invite_code) }); return; }
          catch (e) { if (e.name === 'AbortError') return; }
        }
        copyText(joinLink(c.invite_code), '邀請連結已複製，貼到 LINE 群組即可');
      };
    });
    el.querySelectorAll('[data-copy-text]').forEach((b) => {
      b.onclick = () => copyText(projectInviteText(codeOf(b.dataset.copyText)), '邀請說明已複製（含連結與邀請碼）');
    });
    el.querySelectorAll('[data-rotate]').forEach((b) => {
      b.onclick = async () => {
        const c = codeOf(b.dataset.rotate);
        if (!(await U.confirmBox(`確定要更換「${c.project_name}」的邀請碼嗎？\n舊的邀請碼與連結會立即失效，已送出的申請不受影響。`, '換新碼', true))) return;
        try {
          const code = API.check(await API.sb.rpc('rotate_project_invite', { p_project_id: c.project_id }), '更換邀請碼');
          await after(`新邀請碼：${fmtCode(code)}`);
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });
    el.querySelectorAll('[data-enable]').forEach((b) => {
      b.onclick = async () => {
        const c = codeOf(b.dataset.enable);
        const on = b.dataset.on === '1';
        if (!on && !(await U.confirmBox(`停用後，沒有人能再用「${c.project_name}」的邀請碼申請加入（可隨時重新啟用）。`, '停用', true))) return;
        try {
          API.check(await API.sb.rpc('set_project_invite_enabled', { p_project_id: c.project_id, p_enabled: on }), '設定邀請碼');
          await after(on ? '邀請碼已啟用' : '邀請碼已停用');
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });

    // --- 成員清單 ---
    el.querySelector('#btn-invite').onclick = () => openInviteModal();
    el.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => { const r = rows.find((x) => x.mb.member_id === b.dataset.edit); openMemberModal(r.mb, r.p); };
    });
    el.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const r = rows.find((x) => x.mb.member_id === b.dataset.toggle);
        const disable = r.p.auth_status === '已授權';
        if (!(await U.confirmBox(`確定要${disable ? '停用' : '重新啟用'}「${r.mb.name}」的帳號嗎？`, disable ? '停用' : '啟用', disable))) return;
        try {
          await API.updateWithVersion('profiles', 'member_id', r.mb.member_id, r.p.version, { auth_status: disable ? '已停用' : '已授權' });
          U.toast('已更新帳號狀態', 'ok'); App.renderPage();
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });
    el.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => copyInvite(b.dataset.copy, siteBase());
    });
    el.querySelectorAll('[data-cancel-inv]').forEach((b) => {
      b.onclick = async () => {
        if (!(await U.confirmBox('確定要取消這張邀請嗎？取消後邀請碼會失效。', '取消邀請', true))) return;
        try {
          API.check(await API.sb.from('invitations').update({ status: '已取消' }).eq('invitation_id', b.dataset.cancelInv), '取消邀請');
          U.toast('邀請已取消', 'ok'); App.renderPage();
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });
    el.querySelectorAll('[data-reinvite]').forEach((b) => {
      b.onclick = async () => {
        const mb = members.find((x) => x.member_id === b.dataset.reinvite);
        try {
          const res = API.check(await API.sb.rpc('invite_member', {
            p_name: mb.name, p_email: mb.email, p_role: mb.project_role || '組員',
            p_department: mb.department, p_leader_id: mb.leader_id, p_weekly_hours: mb.weekly_hours
          }), '邀請');
          showInviteResult(mb.name, mb.email, res[0].invite_code, siteBase());
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });
  }

  function projectInviteText(c) {
    return `邀請你加入「${me().org_name}」的專案「${c.project_name}」：\n` +
      `1. 點這個連結：${joinLink(c.invite_code)}\n` +
      `2. 用你的 Email 註冊（已有帳號直接登入）\n` +
      `3. 確認邀請碼 ${c.invite_code}、填姓名後送出，等專案經理核准即可使用`;
  }

  function copyText(text, okMsg) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => U.toast(okMsg, 'ok'))
      .catch(() => {
        const m = U.openModal({
          title: '請手動複製',
          body: `<textarea rows="5" readonly class="mono" style="width:100%">${U.esc(text)}</textarea>`,
          footer: '<span class="spacer"></span><button class="btn primary" data-done>完成</button>'
        });
        const ta = m.querySelector('textarea'); ta.focus(); ta.select();
        m.querySelector('[data-done]').onclick = U.closeModal;
      });
  }

  function openRejectModal(r, after) {
    const m = U.openModal({
      title: `拒絕「${r.name}」的申請`,
      body: `<p class="muted small">${U.esc(r.email)}・申請加入 ${U.esc(r.project_name || r.project_id)}</p>
        <label>原因（選填，對方會看到）<input name="note" maxlength="100" placeholder="例如：請改用公司信箱註冊"></label>
        <div class="form-error" id="rej-error"></div>`,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn danger" id="btn-rej">拒絕申請</button>'
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('input').focus();
    m.querySelector('#btn-rej').onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        API.check(await API.sb.rpc('decide_join_request', { p_request_id: r.request_id, p_approve: false, p_note: m.querySelector('input').value.trim() || null }), '拒絕');
        U.closeModal();
        await after(`已拒絕「${r.name}」的申請`);
      } catch (e) { m.querySelector('#rej-error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  function leaderOptions(selected) {
    const leaders = (API.cache.members || []).filter((x) => ['專案經理', '組長'].includes(x.project_role));
    return U.options(leaders.map((x) => x.member_id), selected, { blank: true, labels: Object.fromEntries(leaders.map((x) => [x.member_id, x.name])) });
  }

  function openInviteModal() {
    const body = `
      <form id="inv-form" class="form-grid">
        <label>姓名<input name="name" required maxlength="40"></label>
        <label>Email<input type="email" name="email" required placeholder="員工註冊時要用這個 Email"></label>
        <label>角色<select name="role">${U.options(['組員', '組長', '專案經理'], '組員')}</select></label>
        <label>部門<input name="department" maxlength="40"></label>
        <label>直屬組長<select name="leader_id">${leaderOptions('')}</select></label>
        <label>每週可投入工時<input type="number" name="weekly_hours" min="0" max="80" step="1" value="40"></label>
      </form><div class="form-error" id="inv-error"></div>`;
    const m = U.openModal({
      title: '邀請成員', body, wide: true,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">產生邀請碼</button>'
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#inv-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      ev.target.disabled = true;
      try {
        const res = API.check(await API.sb.rpc('invite_member', {
          p_name: f.name, p_email: f.email, p_role: f.role, p_department: f.department || null,
          p_leader_id: f.leader_id || null, p_weekly_hours: U.num(f.weekly_hours) || 40
        }), '邀請成員');
        await API.loadLookups(true);
        showInviteResult(f.name, f.email, res[0].invite_code, location.origin + location.pathname);
      } catch (e) { m.querySelector('#inv-error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  function inviteText(code, siteUrl, email = '') {
    return `你被邀請加入「${me().org_name}」的專案管理平台。\n` +
      `1. 打開 ${siteUrl}\n2. 點「註冊新帳號」，Email 請用 ${email || '被邀請的 Email'}\n` +
      `3. 登入後選「我有邀請碼」，輸入：${code}`;
  }

  function copyInvite(code, siteUrl, email) {
    const text = inviteText(code, siteUrl, email);
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => U.toast('邀請說明已複製，可以直接貼到 LINE 或 Email', 'ok'))
      .catch(() => U.toast('無法自動複製，請手動複製邀請碼：' + code, 'warn', 6000));
  }

  function showInviteResult(name, email, code, siteUrl) {
    const m = U.openModal({
      title: `已邀請 ${name}`,
      body: `<div class="invite-code">${U.esc(code)}</div>
        <p class="muted small">請把以下說明傳給 ${U.esc(name)}（邀請碼 30 天內有效）：</p>
        <textarea rows="5" readonly class="mono">${U.esc(inviteText(code, siteUrl, email))}</textarea>`,
      footer: '<span class="spacer"></span><button class="btn outline" id="btn-copy">複製說明</button><button class="btn primary" data-done>完成</button>',
      onClose: () => App.renderPage()
    });
    m.querySelector('#btn-copy').onclick = () => copyInvite(code, siteUrl, email);
    m.querySelector('[data-done]').onclick = () => { U.closeModal(); App.renderPage(); };
  }

  function openMemberModal(mb, p) {
    const isMe = mb.member_id === me().member_id;
    const body = `
      <form id="mb-form" class="form-grid">
        <label>姓名<input name="name" required maxlength="40" value="${U.esc(mb.name)}"></label>
        <label>Email<input value="${U.esc(mb.email || '')}" disabled></label>
        <label>部門<input name="department" maxlength="40" value="${U.esc(mb.department || '')}"></label>
        <label>人員狀態<select name="status">${U.options(API.opts('人員狀態', ['在職', '暫停參與', '已離開']), mb.status)}</select></label>
        <label>直屬組長<select name="leader_id">${leaderOptions(mb.leader_id)}</select></label>
        <label>每週可投入工時<input type="number" name="weekly_hours" min="0" max="80" value="${U.esc(mb.weekly_hours ?? 40)}"></label>
        <label>專業技能<input name="skills" maxlength="100" value="${U.esc(mb.skills || '')}"></label>
        <label>系統角色<select name="role" ${p ? '' : 'disabled'}>${U.options(['專案經理', '組長', '組員'], p?.role || mb.project_role)}</select></label>
        ${p ? (p.is_test_account ? '<p class="muted small span-2">🧪 這是系統測試帳號（由系統管理者設定，網站上無法更改）。</p>' : '')
            : '<p class="muted small span-2">此成員尚未加入系統，角色會在接受邀請時套用。</p>'}
        ${isMe ? '<p class="muted small span-2">提醒：公司至少要保留一位專案經理，系統不允許把最後一位專案經理降級。</p>' : ''}
      </form><div class="form-error" id="mb-error"></div>`;
    const m = U.openModal({
      title: `編輯成員｜${mb.name}`, body, wide: true,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">儲存</button>'
    });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#mb-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      if (f.leader_id === mb.member_id) { m.querySelector('#mb-error').textContent = '直屬組長不能是自己'; return; }
      ev.target.disabled = true;
      try {
        await API.updateWithVersion('members', 'member_id', mb.member_id, mb.version, {
          name: f.name, department: f.department || null, status: f.status, leader_id: f.leader_id || null,
          weekly_hours: U.num(f.weekly_hours), skills: f.skills || null,
          ...(p ? {} : { project_role: f.role || mb.project_role })
        });
        if (p && f.role && f.role !== p.role) {
          await API.updateWithVersion('profiles', 'member_id', mb.member_id, p.version, { role: f.role });
        }
        U.toast('成員資料已更新', 'ok'); U.closeModal();
        await API.loadLookups(true);
        if (isMe) await App.start(); else App.renderPage();
      } catch (e) { m.querySelector('#mb-error').textContent = e.message; ev.target.disabled = false; }
    };
  }

  // =====================================================================
  // 9. 公司設定（專案經理）
  // =====================================================================
  // 公司設定 → 最近刪除（軟刪除的資料可還原）
  const TRASH = [
    { table: 'projects', pk: 'project_id', label: '專案' },
    { table: 'campaigns', pk: 'campaign_id', label: '活動' },
    { table: 'tasks', pk: 'task_id', label: '任務' },
    { table: 'milestones', pk: 'milestone_id', label: '里程碑' }
  ];
  async function loadTrash(box) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const res = await Promise.all(TRASH.map((t) => API.sb.from(t.table)
      .select(`${t.pk},name,deleted_at,deleted_by,version`).eq('is_deleted', true)
      .gte('deleted_at', since).order('deleted_at', { ascending: false }).limit(50)));
    const items = [];
    res.forEach((r, i) => (r.data || []).forEach((row) => items.push({ ...TRASH[i], row })));
    items.sort((a, b) => String(b.row.deleted_at).localeCompare(String(a.row.deleted_at)));
    if (!items.length) { box.innerHTML = '<div class="empty small">最近 30 天沒有刪除任何資料</div>'; return; }
    box.innerHTML = `<div class="table-wrap"><table class="table compact">
      <thead><tr><th>類型</th><th>名稱</th><th>刪除時間</th><th>刪除者</th><th></th></tr></thead>
      <tbody>${items.map((it, i) => `<tr>
        <td><span class="chip">${it.label}</span></td>
        <td><div class="cell-title">${U.esc(it.row.name)}</div><div class="muted small">${U.esc(it.row[it.pk])}</div></td>
        <td class="small">${U.dateTime(it.row.deleted_at)}</td>
        <td class="small">${U.esc(API.memberName(it.row.deleted_by))}</td>
        <td><button class="btn small outline" data-restore="${i}">還原</button></td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-restore]').forEach((b) => {
      b.onclick = async () => {
        const it = items[Number(b.dataset.restore)];
        try {
          await API.restore(it.table, it.pk, it.row[it.pk], it.row.version);
          U.toast(`已還原${it.label}「${it.row.name}」`, 'ok');
          await API.loadLookups(true).catch(() => {});
          App.refreshAll();
        } catch (e) { U.toast(e.message, 'bad', 6000); }
      };
    });
  }

  async function settings(el) {
    const org = API.check(await API.q.organization(), '讀取公司');
    await API.loadLookups(true);
    const rows = API.cache.settingRows || [];
    const all = API.cache.allOptions || [];
    const cats = [...new Set(all.map((o) => o.category))];

    el.innerHTML = `
      <div class="grid g-2">
        <div class="card">
          <div class="card-head"><h4>公司資料與品牌</h4></div>
          <form id="org-form" class="form-grid">
            <label class="span-2">公司名稱<input name="name" required maxlength="80" value="${U.esc(org.name)}"></label>
            <label>品牌主色<input type="color" name="primary_color" value="${U.esc(org.primary_color || '#4f46e5')}"></label>
            <label>幣別<select name="currency">${U.options(['TWD', 'USD', 'JPY', 'HKD', 'CNY', 'EUR'], org.currency)}</select></label>
            <label class="span-2">Logo 圖片網址（https）<input name="logo_url" type="url" value="${U.esc(org.logo_url || '')}" placeholder="https://..."></label>
            <div class="span-2 row-actions"><span class="muted small">建立於 ${U.dateTime(org.created_at)}・方案 ${U.esc(org.plan)}</span><span class="spacer"></span>
              <button class="btn primary" type="submit">儲存公司資料</button></div>
          </form>
          <div class="form-error" id="org-error"></div>
        </div>

        <div class="card">
          <div class="card-head"><h4>預警門檻與參數</h4></div>
          <form id="set-form">
            <table class="table compact"><tbody>
              ${rows.map((r) => `<tr><td><b>${U.esc(r.key)}</b><div class="muted small">${U.esc(r.description || '')}</div></td>
                <td style="width:120px"><input name="${U.esc(r.key)}" value="${U.esc(r.value)}" data-old="${U.esc(r.value)}"></td></tr>`).join('')}
            </tbody></table>
            <div class="row-actions"><span class="spacer"></span><button class="btn primary" type="submit">儲存參數</button></div>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h4>下拉選單選項</h4><span class="muted small">點 × 停用選項；停用後既有資料不受影響</span></div>
        <div class="opt-grid">
          ${cats.map((cat) => `<div class="opt-box">
            <div class="opt-title">${U.esc(cat)}</div>
            <div class="opt-chips">${all.filter((o) => o.category === cat).map((o) => `
              <span class="opt-chip ${o.is_active ? '' : 'off'}">${U.esc(o.value)}
                <button title="${o.is_active ? '停用' : '啟用'}" data-cat="${U.esc(cat)}" data-val="${U.esc(o.value)}" data-on="${o.is_active ? 1 : 0}">${o.is_active ? '×' : '↺'}</button></span>`).join('')}</div>
            <form class="opt-add" data-cat="${U.esc(cat)}"><input name="v" maxlength="20" placeholder="新增選項"><button class="btn small outline">新增</button></form>
          </div>`).join('')}
        </div>
      </div>

      <div class="card" id="trash-card">
        <div class="card-head"><h4>🗑 最近刪除</h4><span class="muted small">30 天內刪除的專案、活動、任務、里程碑，可在這裡還原</span></div>
        <div id="trash-body">${UX.skeleton('table')}</div>
      </div>`;
    loadTrash(el.querySelector('#trash-body'));

    el.querySelector('#org-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = U.formData(e.target);
      if (f.logo_url && !/^https:\/\//.test(f.logo_url)) { el.querySelector('#org-error').textContent = 'Logo 網址必須是 https 開頭'; return; }
      try {
        API.check(await API.sb.from('organizations').update({
          name: f.name, primary_color: f.primary_color, currency: f.currency, logo_url: f.logo_url || null
        }).eq('org_id', org.org_id).select(), '儲存公司資料');
        U.toast('公司資料已更新', 'ok');
        await App.start();
      } catch (err) { el.querySelector('#org-error').textContent = err.message; }
    };

    el.querySelector('#set-form').onsubmit = async (e) => {
      e.preventDefault();
      const changed = [...e.target.querySelectorAll('input')].filter((i) => i.value.trim() !== i.dataset.old);
      if (!changed.length) return U.toast('沒有變更', 'info');
      const bad = changed.find((i) => i.value.trim() === '');
      if (bad) return U.toast(`「${bad.name}」不可空白`, 'bad');
      try {
        for (const i of changed) {
          API.check(await API.sb.from('system_settings').update({ value: i.value.trim(), updated_by: me().member_id })
            .eq('key', i.name).select(), '儲存參數');
        }
        U.toast(`已更新 ${changed.length} 項參數`, 'ok');
        App.renderPage();
      } catch (err) { U.toast(err.message, 'bad', 6000); }
    };

    el.querySelectorAll('.opt-chip button').forEach((b) => {
      b.onclick = async () => {
        try {
          API.check(await API.sb.from('option_lists').update({ is_active: b.dataset.on !== '1' })
            .eq('category', b.dataset.cat).eq('value', b.dataset.val).select(), '更新選項');
          App.renderPage();
        } catch (err) { U.toast(err.message, 'bad', 6000); }
      };
    });
    el.querySelectorAll('.opt-add').forEach((form) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const v = form.v.value.trim();
        if (!v) return;
        const cat = form.dataset.cat;
        const exist = all.find((o) => o.category === cat && o.value === v);
        try {
          if (exist) {
            API.check(await API.sb.from('option_lists').update({ is_active: true }).eq('category', cat).eq('value', v).select(), '新增選項');
          } else {
            const max = Math.max(0, ...all.filter((o) => o.category === cat).map((o) => o.sort_order || 0));
            API.check(await API.sb.from('option_lists').insert({ category: cat, value: v, sort_order: max + 1 }).select(), '新增選項');
          }
          App.renderPage();
        } catch (err) { U.toast(err.message, 'bad', 6000); }
      };
    });
  }

  return {
    dashboard: (el) => Dash.render(el),
    tasks, alerts, risks, campaigns, members, projects, accounts, settings,
    // 供 dashboards.js、schedule.js、profile.js 共用
    openTaskModal, openCampaignModal, drawWorkloadChart,
    canEditTask: (t, collab) => canEditTask(t, collab || new Set())
  };
})();
