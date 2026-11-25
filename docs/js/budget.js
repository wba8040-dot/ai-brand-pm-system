/**
 * 預算與支出：活動預算使用狀況、支出申請、專案經理核准／駁回、CSV 匯出
 * 權限：專案經理、組長可看與申請；只有專案經理可核准／駁回（資料庫 trigger 也會擋）
 */
const Budget = (() => {
  const me = () => Auth.current();
  const isPM = () => me()?.role === '專案經理';

  const CATEGORIES = ['廣告投放', 'KOL／網紅', '內容製作', '活動場地', '工具／軟體', '外包服務', '其他'];
  const PAY_STATUS = ['未付款', '部分付款', '已付款'];
  const filter = { campaign: '', review: '' };

  async function load() {
    const [exp, camps] = await Promise.all([
      API.sb.from('expenses').select('*').eq('is_deleted', false).order('apply_date', { ascending: false, nullsFirst: false }),
      API.q.campaigns()
    ]);
    const pid = API.currentProjectId();
    const campaigns = API.check(camps, '讀取活動').filter((c) => !pid || c.project_id === pid);
    const ids = new Set(campaigns.map((c) => c.campaign_id));
    const expenses = API.check(exp, '讀取支出').filter((e) => !e.campaign_id || ids.has(e.campaign_id));
    return { campaigns, expenses };
  }

  // 每個活動的預算使用：只把「已核准」的支出算入承諾，實際支出看 actual_amount
  function summarize(campaigns, expenses) {
    const warn = U.num(API.setting('預算使用警戒比例', 0.9));
    return campaigns.map((c) => {
      const mine = expenses.filter((e) => e.campaign_id === c.campaign_id && e.review_status !== '已駁回');
      const approved = mine.filter((e) => e.review_status === '已核准').reduce((s, e) => s + U.num(e.approved_amount), 0);
      const pending = mine.filter((e) => e.review_status !== '已核准').reduce((s, e) => s + U.num(e.requested_amount), 0);
      const actual = mine.reduce((s, e) => s + U.num(e.actual_amount), 0);
      const budget = U.num(c.approved_budget);
      const ratio = budget > 0 ? actual / budget : 0;
      const light = budget <= 0 ? '' : ratio > 1 ? '紅' : ratio >= warn ? '黃' : '綠';
      return { c, budget, approved, pending, actual, ratio, light };
    });
  }

  async function render(el) {
    if (!['專案經理', '組長'].includes(me()?.role)) {
      el.innerHTML = '<div class="empty">只有專案經理與組長可以查看預算與支出。</div>';
      return;
    }
    const { campaigns, expenses } = await load();
    const sums = summarize(campaigns, expenses);
    const totalBudget = sums.reduce((s, x) => s + x.budget, 0);
    const totalActual = sums.reduce((s, x) => s + x.actual, 0);
    const pendingList = expenses.filter((e) => e.review_status === '待審核');

    const list = expenses.filter((e) =>
      (!filter.campaign || e.campaign_id === filter.campaign) && (!filter.review || e.review_status === filter.review));
    const campIds = campaigns.map((c) => c.campaign_id);
    const campLabels = Object.fromEntries(campaigns.map((c) => [c.campaign_id, c.name]));

    el.innerHTML = `
      <div class="grid g-3">
        <div class="card"><div class="muted small">活動核定預算合計</div><div class="big">${U.money(totalBudget)}</div></div>
        <div class="card"><div class="muted small">實際支出合計</div><div class="big">${U.money(totalActual)}</div>
          <div class="muted small">使用率 ${totalBudget > 0 ? U.pct(totalActual / totalBudget) : '—'}</div></div>
        <div class="card"><div class="muted small">待審核支出</div><div class="big">${pendingList.length} 筆</div>
          <div class="muted small">${U.money(pendingList.reduce((s, e) => s + U.num(e.requested_amount), 0))}</div></div>
      </div>

      <div class="card no-pad">
        <div class="card-head"><h4>各活動預算使用</h4></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>活動</th><th>核定預算</th><th>已核准支出</th><th>待審核申請</th><th>實際支出</th><th>使用率</th><th>燈號</th></tr></thead>
          <tbody>${sums.map((x) => `<tr>
            <td><div class="cell-title">${U.esc(x.c.name)}</div><div class="muted small">${U.esc(x.c.campaign_id)}</div></td>
            <td>${U.money(x.budget)}</td><td>${U.money(x.approved)}</td><td>${U.money(x.pending)}</td><td>${U.money(x.actual)}</td>
            <td class="${x.ratio > 1 ? 'bad-text' : ''}">${x.budget > 0 ? U.pct(x.ratio) : '—'}</td>
            <td>${x.light ? U.light(x.light) : '—'}</td></tr>`).join('') || `<tr><td colspan="7"><div class="empty">這個專案還沒有活動</div></td></tr>`}</tbody>
        </table></div>
      </div>

      <div class="toolbar">
        <select id="f-camp" aria-label="依活動篩選"><option value="">全部活動</option>${U.options(campIds, filter.campaign, { labels: campLabels })}</select>
        <select id="f-review" aria-label="依審核狀態篩選"><option value="">全部審核狀態</option>${U.options(['待審核', '已核准', '已駁回'], filter.review)}</select>
        <span class="spacer"></span>
        <button class="btn outline" id="btn-export">⤓ 匯出 CSV</button>
        <button class="btn primary" id="btn-new" ${campaigns.length ? '' : 'disabled'}>＋ 申請支出</button>
      </div>

      <div class="card no-pad"><div class="table-wrap"><table class="table">
        <thead><tr><th>支出</th><th>活動</th><th>申請人</th><th>申請金額</th><th>核准金額</th><th>實際支出</th><th>審核</th><th>付款</th></tr></thead>
        <tbody>${list.map((e) => `<tr data-id="${U.esc(e.expense_id)}" class="clickable">
          <td><div class="cell-title">${U.esc(e.item)}</div><div class="muted small">${U.esc(e.expense_id)}・${U.esc(e.category || '—')}${e.vendor ? '・' + U.esc(e.vendor) : ''}</div></td>
          <td class="small">${U.esc(API.campaignName(e.campaign_id))}</td>
          <td>${U.esc(API.memberName(e.applicant_id))}<div class="muted small">${U.date(e.apply_date)}</div></td>
          <td>${U.money(e.requested_amount)}</td>
          <td>${e.review_status === '已核准' ? U.money(e.approved_amount) : '—'}</td>
          <td>${U.money(e.actual_amount)}</td>
          <td>${U.chip(e.review_status)}</td><td>${U.chip(e.payment_status)}</td></tr>`).join('')
          || `<tr><td colspan="8"><div class="empty">沒有符合條件的支出</div></td></tr>`}</tbody>
      </table></div></div>`;

    U.rowsA11y(el);
    el.querySelector('#f-camp').onchange = (e) => { filter.campaign = e.target.value; render(el); };
    el.querySelector('#f-review').onchange = (e) => { filter.review = e.target.value; render(el); };
    el.querySelector('#btn-new').onclick = () => openModal(null, campaigns);
    el.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.onclick = () => openModal(expenses.find((e) => e.expense_id === tr.dataset.id), campaigns);
    });
    el.querySelector('#btn-export').onclick = () => {
      U.downloadCsv(`支出_${U.today()}.csv`, [
        { label: '支出ID', get: (e) => e.expense_id }, { label: '項目', get: (e) => e.item },
        { label: '活動', get: (e) => API.campaignName(e.campaign_id) }, { label: '類別', get: (e) => e.category },
        { label: '供應商', get: (e) => e.vendor }, { label: '申請人', get: (e) => API.memberName(e.applicant_id) },
        { label: '申請日', get: (e) => U.date(e.apply_date) }, { label: '申請金額', get: (e) => e.requested_amount },
        { label: '核准金額', get: (e) => e.approved_amount }, { label: '實際支出', get: (e) => e.actual_amount },
        { label: '已付款', get: (e) => e.paid_amount }, { label: '審核狀態', get: (e) => e.review_status },
        { label: '付款狀態', get: (e) => e.payment_status }, { label: '備註', get: (e) => e.notes }
      ], list);
      U.toast(`已匯出 ${list.length} 筆支出`, 'ok');
    };
  }

  async function openModal(e, campaigns) {
    const isNew = !e;
    e = e || { review_status: '待審核', payment_status: '未付款', apply_date: U.today(), applicant_id: me().member_id, currency: 'TWD' };
    // 已核准的支出，組長只能改付款相關欄位（資料庫 trigger 也會擋）
    const locked = !isNew && e.review_status === '已核准' && !isPM();
    const campIds = campaigns.map((c) => c.campaign_id);
    const campLabels = Object.fromEntries(campaigns.map((c) => [c.campaign_id, c.name]));
    const dis = (cond) => (cond ? 'disabled' : '');

    let history = [];
    if (!isNew) {
      const r = await API.sb.from('approvals').select('*').eq('business_type', '支出').eq('business_id', e.expense_id).order('created_at');
      history = API.check(r, '讀取審核紀錄');
    }

    const body = `
      <form id="exp-form" class="form-grid">
        <label class="span-2">支出項目<input name="item" required maxlength="100" value="${U.esc(e.item || '')}" ${dis(locked)}></label>
        <label>所屬活動<select name="campaign_id" required ${dis(locked)}>${U.options(campIds, e.campaign_id, { blank: true, labels: campLabels })}</select></label>
        <label>類別<select name="category" ${dis(locked)}>${U.options(API.opts('支出類別', CATEGORIES), e.category, { blank: true })}</select></label>
        <label>供應商<input name="vendor" maxlength="100" value="${U.esc(e.vendor || '')}" ${dis(locked)}></label>
        <label>申請日期<input type="date" name="apply_date" value="${U.esc(e.apply_date || '')}" ${dis(locked)}></label>
        <label>申請金額（TWD）<input type="number" name="requested_amount" min="0" step="1" required value="${U.esc(e.requested_amount ?? 0)}" ${dis(locked)}></label>
        <label>實際支出<input type="number" name="actual_amount" min="0" step="1" value="${U.esc(e.actual_amount ?? 0)}"></label>
        <label>已付款金額<input type="number" name="paid_amount" min="0" step="1" value="${U.esc(e.paid_amount ?? 0)}"></label>
        <label>付款狀態<select name="payment_status">${U.options(API.opts('付款狀態', PAY_STATUS), e.payment_status)}</select></label>
        <label>預計付款日<input type="date" name="planned_pay_date" value="${U.esc(e.planned_pay_date || '')}"></label>
        <label>實際付款日<input type="date" name="actual_pay_date" value="${U.esc(e.actual_pay_date || '')}"></label>
        <label class="span-2">備註<textarea name="notes" rows="2">${U.esc(e.notes || '')}</textarea></label>
      </form>
      ${isNew ? '' : `
      <div class="card" style="margin-top:12px">
        <div class="card-head"><h4>審核：${U.chip(e.review_status)}</h4></div>
        ${history.length ? `<ul class="small">${history.map((h) => `<li>${U.date(h.reviewed_at || h.submitted_at)}｜${U.esc(API.memberName(h.reviewer_id))}：
          <b>${U.esc(h.result || '')}</b>${h.reject_reason ? '（' + U.esc(h.reject_reason) + '）' : ''}${h.comment ? '・' + U.esc(h.comment) : ''}</li>`).join('')}</ul>`
          : '<p class="muted small">尚無審核紀錄</p>'}
        ${isPM() && e.review_status === '待審核' ? `
          <div class="form-grid">
            <label>核准金額<input type="number" id="ap-amount" min="0" step="1" value="${U.esc(e.requested_amount ?? 0)}"></label>
            <label>審核意見／駁回原因<input id="ap-comment" maxlength="200"></label>
          </div>
          <div class="row-actions"><button class="btn primary" id="btn-approve">核准</button>
          <button class="btn danger ghost" id="btn-reject">駁回</button></div>` : ''}
      </div>`}
      <div class="form-error" id="exp-error"></div>`;

    const m = U.openModal({
      title: isNew ? '申請支出' : `${e.expense_id}｜${e.item}`, body, wide: true, draftKey: `expense:${e.expense_id || 'new'}:${e.version || 0}`,
      footer: `${!isNew && isPM() ? '<button class="btn danger ghost" id="btn-del">刪除</button>' : ''}<span class="spacer"></span>
        <button class="btn ghost" data-cancel>取消</button><button class="btn primary" id="btn-save">${isNew ? '送出申請' : '儲存'}</button>`
    });
    const fail = (err) => { m.querySelector('#exp-error').textContent = err.message; };
    m.querySelector('[data-cancel]').onclick = U.closeModal;

    m.querySelector('#btn-save').onclick = async (ev) => {
      const form = m.querySelector('#exp-form');
      if (!form.reportValidity()) return;
      const f = U.formData(form);
      // disabled 欄位不會出現在 formData，所以鎖定時只送可改的欄位
      const row = {
        actual_amount: U.num(f.actual_amount), paid_amount: U.num(f.paid_amount),
        payment_status: f.payment_status, planned_pay_date: f.planned_pay_date || null,
        actual_pay_date: f.actual_pay_date || null, notes: f.notes || null
      };
      if (!locked) {
        Object.assign(row, {
          item: f.item, campaign_id: f.campaign_id, category: f.category || null, vendor: f.vendor || null,
          apply_date: f.apply_date || null, requested_amount: U.num(f.requested_amount)
        });
      }
      ev.target.disabled = true;
      try {
        if (isNew) {
          const created = await API.insert('expenses', { ...row, applicant_id: me().member_id, review_status: '待審核', currency: 'TWD' }, '申請支出');
          await API.insert('approvals', {
            business_type: '支出', business_id: created.expense_id, stage: '預算核准',
            submitter_id: me().member_id, submitted_at: new Date().toISOString(), result: '待審核'
          }, '建立審核紀錄');
        } else {
          // 已被駁回的申請修改後重新送審
          if (e.review_status === '已駁回' && !isPM()) row.review_status = '待審核';
          await API.updateWithVersion('expenses', 'expense_id', e.expense_id, e.version, row);
        }
        U.toast(isNew ? '支出申請已送出' : '支出已更新', 'ok'); U.closeModal(); App.renderPage();
      } catch (err) { fail(err); ev.target.disabled = false; }
    };

    const decide = async (approved) => {
      const comment = m.querySelector('#ap-comment').value.trim();
      if (!approved && !comment) { fail(new Error('駁回時請填寫原因')); return; }
      const amount = U.num(m.querySelector('#ap-amount').value);
      m.querySelectorAll('#btn-approve, #btn-reject').forEach((b) => { b.disabled = true; });
      try {
        await API.updateWithVersion('expenses', 'expense_id', e.expense_id, e.version, {
          review_status: approved ? '已核准' : '已駁回', approved_amount: approved ? amount : 0,
          approver_id: me().member_id, approved_date: U.today()
        });
        await API.insert('approvals', {
          business_type: '支出', business_id: e.expense_id, stage: '預算核准',
          submitter_id: e.applicant_id, reviewer_id: me().member_id, submitted_at: e.created_at,
          reviewed_at: new Date().toISOString(), result: approved ? '已核准' : '已駁回',
          reject_reason: approved ? null : comment, comment: approved ? (comment || null) : null, review_version: e.version
        }, '寫入審核紀錄');
        U.toast(approved ? '已核准' : '已駁回', 'ok'); U.closeModal(); App.renderPage();
      } catch (err) { fail(err); m.querySelectorAll('#btn-approve, #btn-reject').forEach((b) => { b.disabled = false; }); }
    };
    const ap = m.querySelector('#btn-approve');
    if (ap) { ap.onclick = () => decide(true); m.querySelector('#btn-reject').onclick = () => decide(false); }

    const del = m.querySelector('#btn-del');
    if (del) del.onclick = async () => {
      if (!(await U.confirmBox(`確定刪除支出「${e.item}」？`, '刪除'))) return;
      try { U.closeModal(); await API.softDelete('expenses', 'expense_id', e, '支出'); App.renderPage(); } catch (err) { U.toast(err.message, 'bad', 6000); }
    };
  }

  return { render };
})();
