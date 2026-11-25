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
    '完成': 'ok', '已完成': 'ok', '通過': 'ok', '已結案': 'ok', '已解決': 'ok', '已核准': 'ok', '成功': 'ok', '已發布': 'ok', '已啟用': 'ok', '已付款': 'ok',
    '待審核': 'warn', '已駁回': 'bad', '未付款': 'muted', '部分付款': 'info',
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
  /**
   * 輕提示
   * opts.action = { label: '復原', onClick }：附帶動作按鈕（例如刪除後可復原）
   * 滑鼠移上去時暫停倒數；錯誤與附動作的提示有關閉鈕
   */
  function toast(msg, type = 'info', ms = 3500, opts = {}) {
    const root = document.getElementById('toast-root');
    if (!root) return null;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.setAttribute('role', type === 'bad' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;
    t.appendChild(text);
    const life = opts.action ? Math.max(ms, 8000) : type === 'bad' ? Math.max(ms, 6000) : ms;
    let timer = null; let left = life; let started = 0;
    const remove = () => { clearTimeout(timer); t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
    const run = () => { started = Date.now(); timer = setTimeout(remove, left); };
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-action'; b.textContent = opts.action.label;
      b.dataset.noBusy = '1';
      b.onclick = async () => {
        b.disabled = true; clearTimeout(timer);
        try { await opts.action.onClick(); } finally { remove(); }
      };
      t.appendChild(b);
    }
    if (opts.action || type === 'bad') {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'toast-close'; x.setAttribute('aria-label', '關閉提示'); x.textContent = '✕';
      x.onclick = remove;
      t.appendChild(x);
    }
    t.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
    t.addEventListener('mouseleave', () => { left = Math.max(left, 1500); run(); });
    root.appendChild(t);
    while (root.children.length > 4) root.firstElementChild.remove();
    requestAnimationFrame(() => t.classList.add('show'));
    run();
    return t;
  }

  // ---------- 對話框／抽屜 ----------
  let modalOpen = false;
  let lastFocus = null;
  let modalSeq = 0;
  let keyHandler = null;
  let currentDirty = null;      // 目前對話框是否有未儲存修改（給「關閉分頁」警告用）
  let currentDraft = null;      // 目前對話框的草稿 key

  // ---------- 草稿自動暫存（localStorage，7 天） ----------
  const DRAFT_PREFIX = 'pm.draft.';
  const DRAFT_DAYS = 7;
  function draftStoreKey(key) {
    const who = (typeof Auth !== 'undefined' && Auth.current()?.member_id) || 'anon';
    return `${DRAFT_PREFIX}${who}.${key}`;
  }
  function formValues(root) {
    const out = {};
    root.querySelectorAll('input[name], select[name], textarea[name]').forEach((e) => {
      if (e.disabled || e.type === 'password' || e.type === 'file') return;
      out[e.name] = e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value;
    });
    return out;
  }
  function applyValues(root, vals) {
    Object.entries(vals).forEach(([name, v]) => {
      root.querySelectorAll(`[name="${CSS.escape(name)}"]`).forEach((e) => {
        if (e.disabled) return;
        if (e.type === 'checkbox' || e.type === 'radio') e.checked = !!v; else e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }
  function clearDraft(key) { try { localStorage.removeItem(draftStoreKey(key)); } catch (e) { /* ignore */ } }
  function pruneDrafts() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(DRAFT_PREFIX)).forEach((k) => {
        const d = JSON.parse(localStorage.getItem(k) || 'null');
        if (!d || Date.now() - d.ts > DRAFT_DAYS * 86400000) localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
  }
  function agoText(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return `${m} 分鐘前`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} 小時前` : `${Math.round(h / 24)} 天前`;
  }

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
  function openModal({ title, body, footer = '', wide = false, variant = 'modal', onClose, dirtyCheck = true, draftKey = null }) {
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

    currentDirty = dirtyCheck ? () => document.contains(modal) && formSnapshot(modal) !== initial : null;

    // 草稿：輸入時自動暫存；下次開啟同一筆時可還原
    currentDraft = draftKey;
    if (draftKey) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(draftStoreKey(draftKey)) || 'null'); } catch (e) { /* ignore */ }
      if (saved && Date.now() - saved.ts < DRAFT_DAYS * 86400000) {
        const cur = formValues(modal);
        const differs = Object.entries(saved.values).some(([k, v]) => k in cur && String(cur[k]) !== String(v));
        if (differs) {
          const bar2 = document.createElement('div');
          bar2.className = 'draft-bar';
          bar2.setAttribute('role', 'status');
          bar2.innerHTML = `<span>📝 有一份 ${agoText(saved.ts)} 未送出的草稿</span>
            <button type="button" class="btn small primary" data-draft-restore data-no-busy>還原草稿</button>
            <button type="button" class="btn small ghost" data-draft-drop data-no-busy>捨棄</button>`;
          modal.querySelector('.modal-body').prepend(bar2);
          bar2.querySelector('[data-draft-restore]').onclick = () => { applyValues(modal, saved.values); bar2.remove(); toast('已還原草稿，確認後記得儲存', 'ok'); };
          bar2.querySelector('[data-draft-drop]').onclick = () => { clearDraft(draftKey); bar2.remove(); };
        } else {
          clearDraft(draftKey);
        }
      }
      let t = null;
      modal.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          if (!document.contains(modal)) return;
          try {
            if (formSnapshot(modal) === initial) localStorage.removeItem(draftStoreKey(draftKey));
            else localStorage.setItem(draftStoreKey(draftKey), JSON.stringify({ ts: Date.now(), values: formValues(modal) }));
          } catch (e) { /* 空間不足等狀況略過 */ }
        }, 600);
      });
    }

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
    if (currentDraft) { clearDraft(currentDraft); currentDraft = null; }
    currentDirty = null;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function isModalOpen() { return modalOpen; }
  function isModalDirty() { return !!(modalOpen && currentDirty && currentDirty()); }

  function openDrawer(opts) {
    return openModal({ ...opts, variant: 'drawer', dirtyCheck: false });
  }

  /**
   * 自訂確認視窗（回傳 Promise<boolean>）
   * opts.typeText：不可逆的高風險操作，必須手動輸入這段文字才能按確認
   */
  function confirmBox(message, okText = '確定', danger = false, opts = {}) {
    const need = opts.typeText ? String(opts.typeText) : '';
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const m = openModal({
        title: opts.title || (danger ? '⚠ 請確認' : '請確認'),
        body: `<p class="confirm-text">${esc(message)}</p>
          ${need ? `<label class="type-confirm">請輸入「<b>${esc(need)}</b>」以確認
            <input type="text" autocomplete="off" spellcheck="false" data-type-confirm aria-describedby="tc-hint"></label>
            <span class="muted small" id="tc-hint">輸入完全相同的文字後，確認按鈕才會解鎖。</span>` : ''}`,
        footer: `<span class="spacer"></span><button class="btn ghost" data-no>取消</button>
                 <button class="btn ${danger ? 'danger' : 'primary'}" data-yes ${need ? 'disabled' : ''}>${esc(okText)}</button>`,
        onClose: () => finish(false),
        dirtyCheck: false
      });
      const yes = m.querySelector('[data-yes]');
      m.querySelector('[data-no]').onclick = () => { closeModal(); finish(false); };
      yes.onclick = () => { if (yes.disabled) return; closeModal(); finish(true); };
      const input = m.querySelector('[data-type-confirm]');
      if (input) {
        input.addEventListener('input', () => { yes.disabled = input.value.trim() !== need; });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !yes.disabled) { e.preventDefault(); yes.click(); } });
        setTimeout(() => input.focus(), 40);
      } else {
        setTimeout(() => m.querySelector('[data-no]').focus(), 40);
      }
    });
  }

  // ---------- KPI 數字自動縮小：金額太長時（例如手機上的 NT$12,345,678）不會撐破卡片 ----------
  // 長金額改用「萬／億」短格式：NT$123,456,789 → NT$1.23億
  function compactNumberText(text) {
    const m = String(text).trim().match(/^([^\d\-]*)(-?[\d,]+(?:\.\d+)?)(\D*)$/);
    if (!m) return null;
    const n = Number(m[2].replace(/,/g, ''));
    if (!isFinite(n) || Math.abs(n) < 10000) return null;
    const abs = Math.abs(n);
    const [div, unit] = abs >= 1e12 ? [1e12, '兆'] : abs >= 1e8 ? [1e8, '億'] : [1e4, '萬'];
    const v = n / div;
    const str = (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');
    return `${m[1]}${str}${unit}${m[3]}`;
  }

  function fitText(scope = document, selector = '.kpi-value', minPx = 16) {
    scope.querySelectorAll(selector).forEach((el) => {
      el.style.fontSize = '';
      if (el.dataset.fullText) { el.textContent = el.dataset.fullText; delete el.dataset.fullText; el.removeAttribute('title'); }
      if (!el.clientWidth) return;   // 尚未顯示（例如在收起的區塊內）
      let size = parseFloat(getComputedStyle(el).fontSize) || 32;
      let guard = 0;
      while (el.scrollWidth > el.clientWidth + 1 && size > minPx && guard++ < 40) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      // 仍放不下：純數字／金額改用萬、億短格式，完整數值保留在提示文字中
      if (el.scrollWidth > el.clientWidth + 1 && !el.children.length) {
        const full = el.textContent.trim();
        const short = compactNumberText(full);
        if (short) {
          el.dataset.fullText = full;
          el.textContent = short;
          el.title = full;
          size = parseFloat(getComputedStyle(el).fontSize) || size;
          const textW = () => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
          el.style.fontSize = '';
          const maxPx = parseFloat(getComputedStyle(el).fontSize) || 32;
          size = minPx; el.style.fontSize = `${size}px`;
          while (size < maxPx && guard++ < 80) { el.style.fontSize = `${size + 1}px`; if (textW() > el.clientWidth) { el.style.fontSize = `${size}px`; break; } size += 1; }
          while (el.scrollWidth > el.clientWidth + 1 && size > minPx) { size -= 1; el.style.fontSize = `${size}px`; }
        }
      }
      if (el.scrollWidth > el.clientWidth + 1 && !el.title) el.title = el.textContent.trim();
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

  /**
   * 下載 CSV（加 BOM 讓 Excel 正確顯示中文；以 ' 開頭擋掉 =、+、-、@ 開頭的試算表公式注入）
   * columns: [{ label, get: (row) => value }]
   */
  function downloadCsv(filename, columns, rows) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map((c) => cell(c.label)).join(',')]
      .concat(rows.map((r) => columns.map((c) => cell(c.get(r))).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return {
    downloadCsv,
    esc, num, pct, money, int, dec, date, dateTime, today, addDays, daysBetween,
    ROLE_COLOR, chip, light, progressBar, toast,
    openModal, openDrawer, closeModal, isModalOpen, isModalDirty, confirmBox, rowsA11y, clearDraft, pruneDrafts,
    chart, destroyCharts, PALETTE, groupCount, formData, emptyToNull, options, fitText
  };
})();
