/**
 * AI 預警與 LINE 綁定的前端按鈕（呼叫 Supabase Edge Functions）
 *
 * 依賴：api.js 的 API.sb（Supabase client）、utils.js 的 U.toast、app.js 的 App.renderPage
 *
 * 使用方式（各加一行，見 SETUP_AI_LINE.md）：
 *   pages.js  → alerts(el) 裡 el.innerHTML = `...` 之後：AIActions.mountAlertToolbar(el, isLeaderOrPM());
 *   profile.js → render(el) 畫完畫面之後：AIActions.mountLineBind(el);
 *   pages.js  → openAlertModal(a) 開啟視窗之後：AIActions.mountAlertDecision(m, a, lead);
 */
const AIActions = (() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const toast = (msg, type = 'info', ms) =>
    (typeof U !== 'undefined' && typeof U.toast === 'function') ? U.toast(msg, type, ms) : alert(msg);

  /** 呼叫 Edge Function，並把錯誤轉成中文訊息 */
  async function invoke(name, body = {}) {
    const { data, error } = await API.sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message || '呼叫失敗';
      try {
        const detail = await error.context?.json?.();
        if (detail?.error) msg = detail.error;
      } catch (e) { /* 忽略 */ }
      throw new Error(msg);
    }
    return data;
  }

  async function myProfile() {
    const { data, error } = await API.sb.rpc('get_my_profile');
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  // ---------------- AI 規則檢查按鈕（風險預警頁） ----------------
  function mountAlertToolbar(el, canRun) {
    if (!el || el.querySelector('#ai-check-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'ai-check-bar';
    bar.className = 'card';
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;';
    bar.innerHTML = `
      <div style="flex:1;min-width:220px;">
        <strong>AI 預警檢查</strong>
        <div style="font-size:13px;opacity:.75;margin-top:4px;">
          系統每天 08:30 自動檢查落後／逾期任務，並由 Gemini 分析原因與建議；21:00 用 LINE 傳摘要給專案經理。
        </div>
      </div>
      ${canRun
        ? '<button type="button" class="btn primary" id="ai-check-btn">立即執行規則檢查</button>'
        : '<span style="font-size:13px;opacity:.7;">只有專案經理或組長可以手動執行</span>'}
      <div id="ai-check-result" role="status" aria-live="polite" style="flex-basis:100%;font-size:13px;"></div>`;
    el.prepend(bar);

    const btn = bar.querySelector('#ai-check-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const out = bar.querySelector('#ai-check-result');
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'AI 分析中，約需 10～60 秒…';
      out.textContent = '';
      try {
        const r = await invoke('run-alert-check', {});
        const n = (r.created || []).length;
        const failedAi = (r.created || []).filter((c) => !c.ai_ok).length;
        const parts = [
          `檢查 ${r.checked} 筆任務`,
          `符合條件 ${r.matched} 筆`,
          r.skipped_existing ? `已有未結案預警而略過 ${r.skipped_existing} 筆` : '',
          `新增預警 ${n} 筆`,
          failedAi ? `其中 ${failedAi} 筆 AI 分析失敗，請人工判斷` : '',
        ].filter(Boolean);
        out.textContent = parts.join('，') + '。';
        if (r.errors?.length) {
          console.warn('run-alert-check errors', r.errors);
          toast(`部分資料寫入失敗（${r.errors.length} 筆），詳細內容請看瀏覽器主控台`, 'bad', 6000);
        } else {
          toast(n ? `已新增 ${n} 筆 AI 預警` : '沒有新的落後任務', 'ok');
        }
        if (n && typeof App !== 'undefined' && typeof App.renderPage === 'function') {
          setTimeout(() => App.renderPage(), 1200);
        }
      } catch (e) {
        out.textContent = `執行失敗：${e.message}`;
        toast(`執行失敗：${e.message}`, 'bad', 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  // ---------------- LINE 綁定卡片（個人資料頁） ----------------
  async function mountLineBind(el) {
    if (!el || el.querySelector('#line-bind-card')) return;
    const card = document.createElement('section');
    card.id = 'line-bind-card';
    card.className = 'card';
    card.style.marginTop = '16px';
    card.setAttribute('aria-label', 'LINE 通知綁定');
    card.innerHTML = '<div class="card-head"><h4>LINE 通知綁定</h4></div><div class="lb-body">讀取中…</div>';
    el.appendChild(card);
    await renderLineBind(card);
  }

  async function renderLineBind(card) {
    const body = card.querySelector('.lb-body');
    let prof;
    let bound = false;
    try {
      prof = await myProfile();
      if (prof?.member_id) {
        // 編號是每家公司各自編，要同時用公司與編號查
        let q = API.sb.from('members').select('line_user_id').eq('member_id', prof.member_id);
        if (prof.org_id) q = q.eq('org_id', prof.org_id);
        const { data } = await q.maybeSingle();
        bound = !!data?.line_user_id;
      }
    } catch (e) {
      body.textContent = `讀取失敗：${e.message}`;
      return;
    }
    const isPM = prof?.role === '專案經理';

    body.innerHTML = bound
      ? `
        <p>✅ 已綁定 LINE 官方帳號「專案預警小幫手」。${isPM ? '每天 21:00 會收到專案預警摘要。' : ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${isPM ? '<button type="button" class="btn outline" data-act="test">傳送測試摘要給我</button>' : ''}
          <button type="button" class="btn danger ghost" data-act="unbind">解除綁定</button>
        </div>`
      : `
        <ol style="padding-left:20px;line-height:1.8;margin:0 0 12px;">
          <li>用 LINE 加入官方帳號「專案預警小幫手」為好友</li>
          <li>按下方按鈕產生 6 位數綁定碼（10 分鐘內有效）</li>
          <li>在 LINE 傳送「綁定 綁定碼」給官方帳號，例如：綁定 123456</li>
        </ol>
        <button type="button" class="btn primary" data-act="code">產生 LINE 綁定碼</button>
        <div class="lb-code" role="status" aria-live="polite" style="margin-top:12px;"></div>`;

    body.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', async () => {
        const act = b.dataset.act;
        b.disabled = true;
        try {
          if (act === 'code') {
            const { data, error } = await API.sb.rpc('create_line_bind_code');
            if (error) throw error;
            const row = Array.isArray(data) ? data[0] : data;
            const until = new Date(row.expire_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
            body.querySelector('.lb-code').innerHTML = `
              <div style="font-size:32px;font-weight:700;letter-spacing:6px;">${esc(row.bind_code)}</div>
              <div style="font-size:13px;opacity:.75;">請在 ${esc(until)} 前，在 LINE 傳送「綁定 ${esc(row.bind_code)}」。完成後按「重新檢查」。</div>
              <button type="button" class="btn small outline" data-act="recheck" style="margin-top:8px;">重新檢查</button>`;
            body.querySelector('[data-act="recheck"]').addEventListener('click', () => renderLineBind(card));
          } else if (act === 'unbind') {
            if (!confirm('確定要解除 LINE 綁定嗎？解除後不會再收到 LINE 通知。')) return;
            const { error } = await API.sb.rpc('unbind_my_line');
            if (error) throw error;
            toast('已解除 LINE 綁定', 'ok');
            await renderLineBind(card);
          } else if (act === 'test') {
            const r = await invoke('send-line-summary', { test: true });
            if (r.recipients && r.ok) toast('已送出，請到 LINE 查看', 'ok');
            else toast(r.note || r.results?.[0]?.error || '送出失敗', 'bad', 6000);
          }
        } catch (e) {
          toast(`操作失敗：${e.message}`, 'bad', 6000);
        } finally {
          b.disabled = false;
        }
      });
    });
  }

  // ---------------- 主管核准／退回（預警視窗） ----------------
  /**
   * 核准 = 同意 AI 建議，交給任務負責人處理（處理狀態 → 處理中）
   * 退回 = 不採用這筆預警，必須填原因（處理狀態 → 已結案）
   * 實際寫入由資料庫函式 decide_alert 完成（同時寫 approvals 審核紀錄、notifications 通知負責人）
   */
  function mountAlertDecision(modal, alert, canDecide) {
    if (!modal || !alert || modal.querySelector('#ai-decision')) return;
    const form = modal.querySelector('#alert-form');
    if (!form) return;

    const box = document.createElement('section');
    box.id = 'ai-decision';
    box.className = 'card';
    box.style.cssText = 'margin-bottom:16px;padding:16px;';
    box.setAttribute('aria-label', 'AI 分析與主管審核');

    const reviewed = alert.review_result === '核准' || alert.review_result === '退回';
    const closed = alert.handle_status === '已結案';
    const owner = (typeof API !== 'undefined' && typeof API.memberName === 'function') ? API.memberName(alert.handler_id || alert.notify_member_id) : (alert.handler_id || alert.notify_member_id || '');

    box.innerHTML = `
      <div style="font-size:13px;opacity:.7;margin-bottom:6px;">AI 分析（Gemini）</div>
      <div style="margin-bottom:6px;"><strong>原因：</strong>${esc(alert.ai_summary || '—')}</div>
      <div style="margin-bottom:12px;"><strong>建議：</strong>${esc(alert.ai_suggestion || '—')}</div>
      ${reviewed
        ? `<div style="font-size:14px;">已由主管<strong>${esc(alert.review_result)}</strong>${alert.review_comment ? `：${esc(alert.review_comment)}` : ''}</div>`
        : closed
          ? '<div style="font-size:14px;opacity:.7;">這筆預警已結案。</div>'
          : canDecide
            ? `
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn primary" data-decide="核准">核准：同意 AI 建議，交給負責人處理</button>
                <button type="button" class="btn danger ghost" data-decide="退回">退回</button>
              </div>
              <div style="font-size:12px;opacity:.7;margin-top:6px;">核准後會指派給 ${esc(owner || '任務負責人')}，處理狀態改為「處理中」，並通知負責人。</div>
              <div class="dec-reason" hidden style="margin-top:12px;">
                <label style="display:block;">退回原因（必填）
                  <textarea rows="2" style="width:100%;margin-top:4px;" placeholder="例如：進度已追上、資料有誤、不需要處理"></textarea>
                </label>
                <button type="button" class="btn danger" data-confirm-reject style="margin-top:8px;">確定退回</button>
              </div>`
            : '<div style="font-size:14px;opacity:.7;">等待專案經理或組長審核。</div>'}`;
    form.before(box);

    const send = async (decision, comment, btn) => {
      btn.disabled = true;
      try {
        const { error } = await API.sb.rpc('decide_alert', {
          p_alert_id: alert.alert_id, p_decision: decision, p_comment: comment || null,
        });
        if (error) throw error;
        toast(decision === '核准' ? '已核准，已交給負責人處理' : '已退回這筆預警', 'ok');
        if (typeof U !== 'undefined' && typeof U.closeModal === 'function') U.closeModal();
        if (typeof App !== 'undefined' && typeof App.renderPage === 'function') App.renderPage();
      } catch (e) {
        toast(`操作失敗：${e.message}`, 'bad', 6000);
        btn.disabled = false;
      }
    };

    const approveBtn = box.querySelector('[data-decide="核准"]');
    if (approveBtn) approveBtn.addEventListener('click', () => send('核准', null, approveBtn));

    const rejectBtn = box.querySelector('[data-decide="退回"]');
    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => {
        const r = box.querySelector('.dec-reason');
        r.hidden = false;
        r.querySelector('textarea').focus();
      });
      box.querySelector('[data-confirm-reject]').addEventListener('click', (ev) => {
        const reason = box.querySelector('.dec-reason textarea').value.trim();
        if (!reason) { toast('請填寫退回原因', 'bad'); return; }
        send('退回', reason, ev.currentTarget);
      });
    }
  }

  return { mountAlertToolbar, mountLineBind, mountAlertDecision, invoke };
})();
