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

  // =====================================================================
  // 1. 專案儀表板
  // =====================================================================
  async function dashboard(el) {
    const [ov, tasks, camps, work, alerts, metrics] = await Promise.all([
      API.q.projectOverview(), API.q.tasks(), API.q.campaignSummary(),
      API.q.workload(), API.q.alerts(), API.q.metrics()
    ]).then((rs) => rs.map((r, i) => API.check(r, ['專案總覽', '任務', '活動', '負荷', '預警', '成效'][i])));

    const o = ov || {};
    const usedRate = U.num(o.used_budget) / (U.num(o.total_budget) || 1);
    const openAlerts = alerts.filter((a) => a.handle_status !== '已結案');
    const highAlerts = openAlerts.filter((a) => a.alert_level === '高');
    const myTasks = tasks.filter((t) => t.owner_id === me().member_id && !['完成', '取消'].includes(t.status));
    const myOverdue = myTasks.filter(isOverdue);
    const gap = U.num(o.progress_gap);
    const health = gap <= -0.2 || U.num(o.overdue_tasks) >= 5 ? '紅' : gap <= -0.1 || U.num(o.overdue_tasks) > 0 ? '黃' : '綠';

    const in7 = tasks.filter((t) => !['完成', '取消'].includes(t.status) && t.planned_end &&
      U.daysBetween(U.today(), t.planned_end) >= 0 && U.daysBetween(U.today(), t.planned_end) <= 7);

    el.innerHTML = `
      <div class="project-head">
        <div>
          <div class="muted small">${U.esc(o.project_id || '')}</div>
          <h3>${U.esc(o.name || '尚無專案資料')}</h3>
          <div class="muted small">${U.date(o.start_date)} → ${U.date(o.planned_end_date)}・負責人 ${U.esc(o.owner_name || '—')}</div>
        </div>
        <div class="health ${health === '紅' ? 'bad' : health === '黃' ? 'warn' : 'ok'}">
          <span>專案健康</span><b>${health}燈</b>
        </div>
      </div>

      <div class="kpis">
        <div class="kpi">
          <div class="kpi-label">整體實際進度</div>
          <div class="kpi-value">${U.pct(o.overall_actual_progress)}</div>
          <div class="kpi-sub ${gap < 0 ? 'bad-text' : 'ok-text'}">預計 ${U.pct(o.overall_planned_progress)}・落差 ${gap > 0 ? '+' : ''}${U.pct(gap)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">預算使用率</div>
          <div class="kpi-value ${usedRate > 0.9 ? 'bad-text' : ''}">${U.pct(usedRate)}</div>
          <div class="kpi-sub">${U.money(o.used_budget)} / ${U.money(o.total_budget)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">逾期任務</div>
          <div class="kpi-value ${U.num(o.overdue_tasks) ? 'bad-text' : ''}">${U.int(o.overdue_tasks)}</div>
          <div class="kpi-sub">未完成 ${U.int(o.open_tasks)} 項</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">待處理預警</div>
          <div class="kpi-value ${highAlerts.length ? 'bad-text' : ''}">${openAlerts.length}</div>
          <div class="kpi-sub">高等級 ${highAlerts.length} 則</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">高風險／未解決問題</div>
          <div class="kpi-value">${U.int(o.high_risks)}<span class="kpi-slash">/</span>${U.int(o.open_issues)}</div>
          <div class="kpi-sub">風險 / 問題</div>
        </div>
        <div class="kpi mine">
          <div class="kpi-label">我的進行中任務</div>
          <div class="kpi-value">${myTasks.length}</div>
          <div class="kpi-sub ${myOverdue.length ? 'bad-text' : ''}">其中逾期 ${myOverdue.length} 項</div>
        </div>
      </div>

      <div class="grid g-3">
        <div class="card"><div class="card-head"><h4>任務狀態分布</h4></div><div class="chart-box"><canvas id="c-status"></canvas></div></div>
        <div class="card span-2"><div class="card-head"><h4>各活動預算 vs 實際支出</h4></div><div class="chart-box"><canvas id="c-budget"></canvas></div></div>
        <div class="card span-2"><div class="card-head"><h4>每日營收與廣告花費</h4></div><div class="chart-box"><canvas id="c-trend"></canvas></div></div>
        <div class="card"><div class="card-head"><h4>各活動 ROAS</h4><span class="muted small">目標 ${cfg.ROAS_TARGET}</span></div><div class="chart-box"><canvas id="c-roas"></canvas></div></div>
        <div class="card"><div class="card-head"><h4>組員本週負荷</h4></div><div class="chart-box"><canvas id="c-work"></canvas></div></div>
        <div class="card">
          <div class="card-head"><h4>待處理 AI 預警</h4><a href="#/alerts" class="small">全部 →</a></div>
          <ul class="mini-list">
            ${openAlerts.slice(0, 5).map((a) => `
              <li><span class="chip ${a.alert_level === '高' ? 'bad' : a.alert_level === '中' ? 'warn' : 'ok'}">${U.esc(a.alert_level || '—')}</span>
                <div><b>${U.esc(a.alert_type || '預警')}</b><div class="muted small">${U.esc(a.task_id || a.campaign_id || '')}・${U.dateTime(a.alert_time)}</div></div></li>`).join('')
              || '<li class="muted">目前沒有待處理的預警 🎉</li>'}
          </ul>
        </div>
        <div class="card">
          <div class="card-head"><h4>7 天內到期任務</h4><a href="#/tasks" class="small">全部 →</a></div>
          <ul class="mini-list">
            ${in7.slice(0, 6).map((t) => `
              <li>${U.light(t.risk_light)}<div><b>${U.esc(t.name)}</b>
                <div class="muted small">${U.esc(API.memberName(t.owner_id))}・${U.date(t.planned_end)}（剩 ${U.daysBetween(U.today(), t.planned_end)} 天）</div></div>
                ${U.progressBar(t.actual_progress, t.planned_progress)}</li>`).join('')
              || '<li class="muted">7 天內沒有到期的任務</li>'}
          </ul>
        </div>
      </div>`;

    // 圖 1：任務狀態
    const sc = U.groupCount(tasks, 'status');
    const sKeys = Object.keys(sc);
    U.chart('c-status', {
      type: 'doughnut',
      data: { labels: sKeys, datasets: [{ data: sKeys.map((k) => sc[k]), backgroundColor: sKeys.map((k, i) => STATUS_COLOR[k] || U.PALETTE[i % 8]) }] },
      options: baseChartOpts({ cutout: '62%' })
    });

    // 圖 2：預算 vs 支出
    U.chart('c-budget', {
      type: 'bar',
      data: {
        labels: camps.map((c) => c.name),
        datasets: [
          { label: '核定預算', data: camps.map((c) => U.num(c.approved_budget)), backgroundColor: '#c7d2fe' },
          { label: '實際支出', data: camps.map((c) => U.num(c.actual_spend)),
            backgroundColor: camps.map((c) => U.num(c.budget_usage_rate) > 1 ? '#ef4444' : '#6366f1') }
        ]
      },
      options: baseChartOpts({ scales: { y: { ticks: { callback: (v) => (v / 1000) + 'k' } } } })
    });

    // 圖 3：每日營收／花費
    const byDate = {};
    metrics.forEach((m) => {
      const d = m.data_date;
      byDate[d] = byDate[d] || { rev: 0, spend: 0 };
      byDate[d].rev += U.num(m.revenue);
      byDate[d].spend += U.num(m.ad_spend);
    });
    const dates = Object.keys(byDate).sort();
    U.chart('c-trend', {
      type: 'line',
      data: {
        labels: dates.map((d) => d.slice(5)),
        datasets: [
          { label: '歸因營收', data: dates.map((d) => byDate[d].rev), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.12)', fill: true, tension: 0.3 },
          { label: '廣告花費', data: dates.map((d) => byDate[d].spend), borderColor: '#f59e0b', backgroundColor: 'transparent', tension: 0.3 }
        ]
      },
      options: baseChartOpts({ scales: { y: { ticks: { callback: (v) => (v / 1000) + 'k' } } } })
    });

    // 圖 4：ROAS（含目標線）
    const roasCamps = camps.filter((c) => c.roas !== null);
    U.chart('c-roas', {
      data: {
        labels: roasCamps.map((c) => c.name),
        datasets: [
          { type: 'bar', label: 'ROAS', data: roasCamps.map((c) => U.num(c.roas)),
            backgroundColor: roasCamps.map((c) => U.num(c.roas) < cfg.ROAS_TARGET ? '#f87171' : '#34d399') },
          { type: 'line', label: '目標', data: roasCamps.map(() => cfg.ROAS_TARGET), borderColor: '#475569', borderDash: [6, 4], pointRadius: 0 }
        ]
      },
      options: baseChartOpts({ plugins: { legend: { display: false } } })
    });

    // 圖 5：組員負荷
    drawWorkloadChart('c-work', work);
  }

  function drawWorkloadChart(id, work) {
    const yellow = U.num(API.cache.settings?.['工作負荷黃色門檻'] || 0.8);
    const red = U.num(API.cache.settings?.['工作負荷紅色門檻'] || 1);
    const rows = work.filter((w) => w.status !== '已離開');
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
  const taskFilter = { text: '', status: '', campaign: '', owner: '', mine: false, overdue: false };

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
        ${statuses.map((s) => `<button class="strip-item ${taskFilter.status === s ? 'active' : ''}" data-status="${U.esc(s)}">
          <span class="strip-dot" style="background:${STATUS_COLOR[s] || '#94a3b8'}"></span>${U.esc(s)}<b>${counts[s] || 0}</b></button>`).join('')}
        <button class="strip-item ${taskFilter.overdue ? 'active' : ''}" data-overdue><span class="strip-dot" style="background:#dc2626"></span>逾期<b>${overdueCount}</b></button>
      </div>

      <div class="toolbar">
        <input type="search" id="f-text" placeholder="搜尋任務名稱或 ID" value="${U.esc(taskFilter.text)}">
        <select id="f-campaign"><option value="">全部活動</option>${U.options((API.cache.campaigns || []).map((c) => c.campaign_id), taskFilter.campaign, { labels: Object.fromEntries((API.cache.campaigns || []).map((c) => [c.campaign_id, c.name])) })}</select>
        <select id="f-owner"><option value="">全部負責人</option>${U.options((API.cache.members || []).map((m) => m.member_id), taskFilter.owner, { labels: Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, m.name])) })}</select>
        <label class="check"><input type="checkbox" id="f-mine" ${taskFilter.mine ? 'checked' : ''}> 只看我的</label>
        <span class="spacer"></span>
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
      body.innerHTML = list.map((t) => {
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
    if (newBtn) newBtn.onclick = () => openTaskModal(null, true, rows.map((r) => r.task_id));
  }

  async function openTaskModal(task, editable, existingIds = []) {
    const isNew = !task;
    const t = task || {
      task_id: U.nextId(existingIds, 'T-MKT-'), name: '', status: '未開始', priority: '中',
      planned_progress: 0, actual_progress: 0, owner_id: me().member_id,
      planned_start: U.today(), planned_end: '', version: 0
    };
    const lead = isLeaderOrPM();
    const dis = (cond) => (cond ? '' : 'disabled');
    const memberIds = (API.cache.members || []).filter((m) => m.status !== '已離開').map((m) => m.member_id);
    const memberLabels = Object.fromEntries((API.cache.members || []).map((m) => [m.member_id, `${m.name}（${m.member_id}）`]));
    const campIds = (API.cache.campaigns || []).map((c) => c.campaign_id);
    const campLabels = Object.fromEntries((API.cache.campaigns || []).map((c) => [c.campaign_id, c.name]));

    const body = `
      <form id="task-form" class="form-grid">
        <div class="form-section span-2">基本資料 ${lead ? '' : '<span class="muted small">（負責人、日期、權重由組長或專案經理設定）</span>'}</div>
        <label>任務ID<input name="task_id" value="${U.esc(t.task_id)}" ${isNew ? 'required' : 'disabled'}></label>
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

    const m = U.openModal({ title: isNew ? '新增任務' : `${t.task_id}｜${t.name}`, body, footer, wide: true });
    const form = m.querySelector('#task-form');
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
      if (!(await U.confirmBox(`確定要刪除任務「${t.name}」嗎？（軟刪除，資料仍保留於異動紀錄）`, '刪除', true))) return;
      try {
        await API.updateWithVersion('tasks', 'task_id', t.task_id, t.version, { is_deleted: true });
        U.toast('任務已刪除', 'ok');
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
          const res = await API.sb.from('tasks').insert({ task_id: f.task_id, ...patch, progress_source: '系統建立' }).select();
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
            <select id="a-status">${U.options(['未結案', '全部', '待處理', '處理中', '已結案'], alertFilter.status)}</select>
            <select id="a-level"><option value="">全部等級</option>${U.options(['高', '中', '低'], alertFilter.level)}</select>
          </div>
          <div id="alert-list" class="alert-list"></div>
        </div>
        <div class="card">
          <div class="card-head"><h4>未結案預警類型</h4></div>
          <div class="chart-box tall"><canvas id="c-alert-type"></canvas></div>
        </div>
      </div>`;

    U.chart('c-alert-type', {
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
          <div class="card-head"><h4>風險清單</h4><span class="muted small">${isLeaderOrPM() ? '點選列可編輯' : ''}</span></div>
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
        <div class="card-head"><h4>問題追蹤（未解決 ${openIssues.length} 項）</h4></div>
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

    if (isLeaderOrPM()) {
      el.querySelectorAll('[data-risk]').forEach((tr) => {
        tr.onclick = () => openRiskModal(rk.find((r) => r.risk_id === tr.dataset.risk), midMin, highMin);
      });
      el.querySelectorAll('[data-issue]').forEach((tr) => {
        tr.onclick = () => openIssueModal(is.find((x) => x.issue_id === tr.dataset.issue));
      });
    }
  }

  function openRiskModal(r, midMin, highMin) {
    const body = `
      <form id="risk-form" class="form-grid">
        <label>發生機率（1–5）<input type="number" name="probability" min="1" max="5" value="${U.esc(r.probability ?? 3)}" required></label>
        <label>影響程度（1–5）<input type="number" name="impact" min="1" max="5" value="${U.esc(r.impact ?? 3)}" required></label>
        <label>風險狀態<select name="status">${U.options(API.opts('風險狀態', ['待處理', '處理中', '已結案']), r.status)}</select></label>
        <label>應對期限<input type="date" name="response_due" value="${U.esc(r.response_due || '')}"></label>
        <label class="span-2">應對措施<textarea name="response_plan" rows="3">${U.esc(r.response_plan || '')}</textarea></label>
        <p class="muted small span-2">風險等級會依分數自動判定：≥${highMin} 高、≥${midMin} 中、其餘低。</p>
      </form><div class="form-error" id="risk-error"></div>`;
    const m = U.openModal({ title: `${r.risk_id}｜${r.name}`, body,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">儲存</button>' });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async () => {
      const form = m.querySelector('#risk-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      const score = U.num(f.probability) * U.num(f.impact);
      try {
        await API.updateWithVersion('risks', 'risk_id', r.risk_id, r.version, {
          probability: U.num(f.probability), impact: U.num(f.impact),
          risk_level: score >= highMin ? '高' : score >= midMin ? '中' : '低',
          status: f.status, response_due: f.response_due || null, response_plan: f.response_plan || null,
          last_assessed: U.today()
        });
        U.toast('風險已更新', 'ok'); U.closeModal(); App.renderPage();
      } catch (e) { m.querySelector('#risk-error').textContent = e.message; }
    };
  }

  function openIssueModal(i) {
    const body = `
      <form id="issue-form" class="form-grid">
        <label>問題狀態<select name="status">${U.options(API.opts('問題狀態', ['待處理', '處理中', '已解決']), i.status)}</select></label>
        <label>實際解決日<input type="date" name="resolved_date" value="${U.esc(i.resolved_date || '')}"></label>
        <label>預計解決日<input type="date" name="due_date" value="${U.esc(i.due_date || '')}"></label>
        <label class="check"><input type="checkbox" name="escalated" ${i.escalated ? 'checked' : ''}> 升級處理</label>
        <label class="span-2">解決方案<textarea name="solution" rows="3">${U.esc(i.solution || '')}</textarea></label>
      </form><div class="form-error" id="issue-error"></div>`;
    const m = U.openModal({ title: `${i.issue_id}｜${i.name}`, body,
      footer: '<span class="spacer"></span><button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">儲存</button>' });
    m.querySelector('[data-cancel]').onclick = U.closeModal;
    m.querySelector('#btn-save').onclick = async () => {
      const form = m.querySelector('#issue-form');
      const f = U.formData(form);
      const resolved = f.status === '已解決' ? (f.resolved_date || U.today()) : (f.resolved_date || null);
      try {
        await API.updateWithVersion('issues', 'issue_id', i.issue_id, i.version, {
          status: f.status, resolved_date: resolved, due_date: f.due_date || null,
          escalated: form.escalated.checked, solution: f.solution || null
        });
        U.toast('問題已更新', 'ok'); U.closeModal(); App.renderPage();
      } catch (e) { m.querySelector('#issue-error').textContent = e.message; }
    };
  }

  // =====================================================================
  // 5. 行銷活動成效
  // =====================================================================
  async function campaigns(el) {
    const [camps, metrics] = await Promise.all([API.q.campaignSummary(), API.q.metrics()])
      .then(([a, b]) => [API.check(a, '讀取活動'), API.check(b, '讀取成效')]);
    const warnRate = U.num(API.cache.settings?.['預算使用警戒比例'] || 0.9);

    const totals = camps.reduce((s, c) => ({
      budget: s.budget + U.num(c.approved_budget), spend: s.spend + U.num(c.actual_spend),
      rev: s.rev + U.num(c.revenue), ad: s.ad + U.num(c.ad_spend), conv: s.conv + U.num(c.conversions)
    }), { budget: 0, spend: 0, rev: 0, ad: 0, conv: 0 });

    el.innerHTML = `
      <div class="kpis small-kpis">
        <div class="kpi"><div class="kpi-label">活動數</div><div class="kpi-value">${camps.length}</div></div>
        <div class="kpi"><div class="kpi-label">核定預算</div><div class="kpi-value">${U.money(totals.budget)}</div></div>
        <div class="kpi"><div class="kpi-label">實際支出</div><div class="kpi-value">${U.money(totals.spend)}</div><div class="kpi-sub">${U.pct(totals.spend / (totals.budget || 1))}</div></div>
        <div class="kpi"><div class="kpi-label">整體 ROAS</div><div class="kpi-value ${totals.rev / (totals.ad || 1) < cfg.ROAS_TARGET ? 'bad-text' : 'ok-text'}">${U.dec(totals.rev / (totals.ad || 1))}</div></div>
        <div class="kpi"><div class="kpi-label">總轉換數</div><div class="kpi-value">${U.int(totals.conv)}</div></div>
      </div>

      <div class="camp-grid">
        ${camps.map((c) => {
          const rate = U.num(c.budget_usage_rate);
          const roasBad = c.roas !== null && U.num(c.roas) < cfg.ROAS_TARGET;
          return `<div class="card camp">
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

    U.chart('c-conv', {
      type: 'bar',
      data: { labels: camps.map((c) => c.name), datasets: [{ label: '轉換數', data: camps.map((c) => U.num(c.conversions)), backgroundColor: U.PALETTE }] },
      options: baseChartOpts({ plugins: { legend: { display: false } } })
    });
    U.chart('c-ctr', {
      type: 'bar',
      data: { labels: camps.map((c) => c.name), datasets: [{ label: 'CTR', data: camps.map((c) => +(U.num(c.ctr) * 100).toFixed(2)), backgroundColor: '#0ea5e9' }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => ` ${x.raw}%` } } }, scales: { y: { ticks: { callback: (v) => v + '%' } } } })
    });
    void metrics; // 每日趨勢已顯示於儀表板
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

  return { dashboard, tasks, alerts, risks, campaigns, members };
})();
