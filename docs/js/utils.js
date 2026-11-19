/**
 * 共用工具：格式化、HTML 跳脫、提示訊息、對話框／抽屜、圖表管理、無障礙輔助
 */
const U = (() => {
  // ---------- HTML 跳脫（防止 XSS） ----------
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- 格式化 ----------
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function pct(v, digits = 0) {
    if (v === null || v === undefined || v === '') return '—';
    return (num(v) * 100).toFixed(digits) + '%';
  }

  function money(v) {
    if (v === null || v === undefined || v === '') return '—';
    return 'NT$' + Math.round(num(v)).toLocaleString('zh-TW');
  }

  function int(v) {
    if (v === null || v === undefined || v === '') return '—';
    return Math.round(num(v)).toLocaleString('zh-TW');
  }

  function dec(v, d = 2) {
    if (v === null || v === undefined || v === '') return '—';
    return num(v).toFixed(d);
  }

  function date(v) {
    if (!v) return '—';
    return String(v).slice(0, 10);
  }

  function dateTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return d.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
  }

  function addDays(ymd, n) {
    const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv-SE');
  }

  function daysBetween(a, b) {
    const d1 = new Date(String(a).slice(0, 10) + 'T00:00:00');
    const d2 = new Date(String(b).slice(0, 10) + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000);
  }

  // ---------- 顏色與標籤 ----------
  const ROLE_COLOR = { '專案經理': '#6d28d9', '組長': '#0369a1', '組員': '#047857' };

  const CHIP = {
    '完成': 'ok', '已完成': 'ok', '通過': 'ok', '已結案': 'ok', '已解決': 'ok', '已核准': 'ok', '成功': 'ok', '已發布': 'ok', '已啟用': 'ok',
    '進行中': 'info', '處理中': 'info', '驗收中': 'info', '邀請中': 'warn',
    '未開始': 'muted', '待處理': 'warn', '待發送': 'warn', '未驗收': 'muted', '暫停': 'muted', '取消': 'muted', '規劃中': 'muted',
    '阻塞': 'bad', '失敗': 'bad', '未通過': 'bad', '退回': 'bad', '已退回': 'bad', '已停用': 'bad',
    '高': 'bad', '中': 'warn', '低': 'ok',
    '紅': 'bad', '黃': 'warn', '綠': 'ok'
  };

  function chip(text) {
    if (!text) return '<span class="chip muted">—</span>';
    return `<span class="chip ${CHIP[text] || 'muted'}">${esc(text)}</span>`;
  }

  // 燈號：顏色＋文字，不只靠顏色傳達資訊（WCAG 1.4.1）
  function light(color, { compact = false } = {}) {
    const cls = { '紅': 'bad', '黃': 'warn', '綠': 'ok' }[color] || 'muted';
    const label = color || '未評估';
    return compact
      ? `<span class="dot ${cls}" role="img" aria-label="燈號：${esc(label)}" title="${esc(label)}"></span>`
      : `<span class="light ${cls}"><span class="dot ${cls}" aria-hidden="true"></span>${esc(label)}</span>`;
  }

  // 進度條：實際（實心）＋預計（標線）
  function progressBar(actual, planned) {
    const a = Math.max(0, Math.min(1, num(actual)));
    const p = planned === undefined || planned === null ? null : Math.max(0, Math.min(1, num(planned)));
    const behind = p !== null && a < p - 0.0001;
    const text = `實際 ${pct(a)}${p !== null ? '，預計 ' + pct(p) : ''}`;
    return `<div class="pbar ${behind ? 'behind' : ''}" role="img" aria-label="${text}" title="${text}">
      <div class="pbar-fill" style="width:${(a * 100).toFixed(1)}%"></div>
      ${p !== null ? `<div class="pbar-mark" style="left:${(p * 100).toFixed(1)}%"></div>` : ''}
      <span class="pbar-label" aria-hidden="true">${pct(a)}</span>
    </div>`;
  }

  // ---------- 提示訊息（螢幕閱讀器可讀） ----------
  function toast(msg, type = 'info', ms = 3500) {
    const root = document.getElementById('toast-root');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.setAttribute('role', type === 'bad' ? 'alert' : 'status');
    t.textContent = msg;
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'bad' ? Math.max(ms, 6000) : ms);
  }

  // ---------- 對話框／抽屜 ----------
  let modalOpen = false;
  let lastFocus = null;
  let modalSeq = 0;
  let keyHandler = null;

  function formSnapshot(root) {
    return [...root.querySelectorAll('input, select, textarea')]
      .map((e) => (e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value)).join('\u0001');
  }

  /**
   * 開啟對話框
   * - variant: 'modal'（置中）或 'drawer'（右側抽屜）
   * - 有修改過的表單，按背景、Esc、✕、取消時會先詢問是否放棄
   * - Tab 鍵焦點限制在對話框內，關閉後焦點回到原本的按鈕
   */
  function openModal({ title, body, footer = '', wide = false, variant = 'modal', onClose, dirtyCheck = true }) {
    const root = document.getElementById('modal-root');
    if (!modalOpen) lastFocus = document.activeElement;
    const id = `modal-title-${++modalSeq}`;
    root.innerHTML = `
      <div class="modal-backdrop ${variant === 'drawer' ? 'is-drawer' : ''}">
        <div class="modal ${wide ? 'wide' : ''} ${variant === 'drawer' ? 'drawer' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}">
          <div class="modal-head">
            <h3 id="${id}">${esc(title)}</h3>
            <button class="icon-btn" data-close aria-label="關閉">✕</button>
          </div>
          <div class="modal-body">${body}</div>
          <div class="discard-bar" hidden role="alert">
            <span>有尚未儲存的修改，確定要放棄嗎？</span>
            <button class="btn small ghost" data-keep>繼續編輯</button>
            <button class="btn small danger" data-discard>放棄修改</button>
          </div>
          ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>
      </div>`;
    modalOpen = true;
    const modal = root.querySelector('.modal');
    const initial = formSnapshot(modal);
    const bar = modal.querySelector('.discard-bar');

    const reallyClose = () => { closeModal(); if (onClose) onClose(); };
    const attemptClose = () => {
      if (dirtyCheck && formSnapshot(modal) !== initial) {
        bar.hidden = false;
        bar.querySelector('[data-keep]').focus();
        return;
      }
      reallyClose();
    };

    modal.querySelector('[data-close]').onclick = attemptClose;
    bar.querySelector('[data-keep]').onclick = () => {
      bar.hidden = true;
      const f = modal.querySelector('input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])');
      (f || modal.querySelector('[data-close]')).focus();
    };
    bar.querySelector('[data-discard]').onclick = reallyClose;
    root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-backdrop')) attemptClose();
    });
    // 「取消」按鈕也要經過放棄確認（捕獲階段先攔截）
    // 沒有修改時，「取消／關閉」（data-cancel）直接關閉，不需各頁面自行綁定
    modal.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cancel]');
      if (!c) return;
      e.stopImmediatePropagation(); e.preventDefault();
      if (dirtyCheck && formSnapshot(modal) !== initial) {
        bar.hidden = false;
        bar.querySelector('[data-keep]').focus();
        return;
      }
      reallyClose();
    }, true);
    // 鍵盤：Esc 關閉、Tab 循環（掛在 document，焦點意外離開對話框時仍有效）
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = (e) => {
      if (!document.contains(modal)) return;
      if (e.key === 'Escape') { e.preventDefault(); attemptClose(); return; }
      if (e.key !== 'Tab') return;
      const f = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyHandler);
    // 初始焦點：第一個可編輯欄位，否則關閉鈕
    setTimeout(() => {
      const first = modal.querySelector('input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])');
      (first || modal.querySelector('[data-close]')).focus();
    }, 30);
    return modal;
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    modalOpen = false;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function isModalOpen() { return modalOpen; }

  function openDrawer(opts) {
    return openModal({ ...opts, variant: 'drawer', dirtyCheck: false });
  }

  // 自訂確認視窗（回傳 Promise<boolean>）
  function confirmBox(message, okText = '確定', danger = false) {
    return new Promise((resolve) => {
      const m = openModal({
        title: '請確認',
        body: `<p class="confirm-text">${esc(message)}</p>`,
        footer: `<span class="spacer"></span><button class="btn ghost" data-no>取消</button>
                 <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button>`,
        onClose: () => resolve(false),
        dirtyCheck: false
      });
      m.querySelector('[data-no]').onclick = () => { closeModal(); resolve(false); };
      m.querySelector('[data-yes]').onclick = () => { closeModal(); resolve(true); };
      setTimeout(() => m.querySelector('[data-no]').focus(), 40);
    });
  }

  // ---------- 無障礙：可點擊的表格列支援鍵盤 ----------
  function rowsA11y(scope) {
    scope.querySelectorAll('tr.clickable, .clickable-card').forEach((el) => {
      if (el.dataset.a11y) return;
      el.dataset.a11y = '1';
      el.tabIndex = 0;
      el.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); el.click(); }
      });
    });
  }

  // ---------- 圖表 ----------
  const charts = {};

  function chart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const canvas = document.getElementById(id);
    if (!canvas || typeof Chart === 'undefined') return null;
    charts[id] = new Chart(canvas, config);
    return charts[id];
  }

  function destroyCharts() {
    Object.keys(charts).forEach((k) => { charts[k].destroy(); delete charts[k]; });
  }

  const PALETTE = ['#4f46e5', '#0284c7', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0d9488', '#ea580c'];

  // ---------- 其他 ----------
  function groupCount(rows, key) {
    const out = {};
    rows.forEach((r) => { const k = r[key] || '未設定'; out[k] = (out[k] || 0) + 1; });
    return out;
  }

  function formData(form) {
    const out = {};
    new FormData(form).forEach((v, k) => { out[k] = typeof v === 'string' ? v.trim() : v; });
    return out;
  }

  function emptyToNull(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => { out[k] = obj[k] === '' ? null : obj[k]; });
    return out;
  }

  function options(list, selected, { blank = false, labels = null } = {}) {
    const opts = blank ? ['<option value="">（未設定）</option>'] : [];
    list.forEach((v) => {
      const label = labels ? labels[v] || v : v;
      opts.push(`<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`);
    });
    return opts.join('');
  }

  return {
    esc, num, pct, money, int, dec, date, dateTime, today, addDays, daysBetween,
    ROLE_COLOR, chip, light, progressBar, toast,
    openModal, openDrawer, closeModal, isModalOpen, confirmBox, rowsA11y,
    chart, destroyCharts, PALETTE, groupCount, formData, emptyToNull, options
  };
})();
