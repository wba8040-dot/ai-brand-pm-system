/**
 * 共用工具：格式化、HTML 跳脫、提示訊息、對話框、圖表管理
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

  function daysBetween(a, b) {
    const d1 = new Date(String(a).slice(0, 10) + 'T00:00:00');
    const d2 = new Date(String(b).slice(0, 10) + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000);
  }

  // ---------- 顏色與標籤 ----------
  const ROLE_COLOR = { '專案經理': '#6d28d9', '組長': '#0369a1', '組員': '#047857' };

  const CHIP = {
    // 狀態類
    '完成': 'ok', '已完成': 'ok', '通過': 'ok', '已結案': 'ok', '已解決': 'ok', '已核准': 'ok', '成功': 'ok', '已發布': 'ok',
    '進行中': 'info', '處理中': 'info', '驗收中': 'info',
    '未開始': 'muted', '待處理': 'warn', '待發送': 'warn', '未驗收': 'muted', '暫停': 'muted', '取消': 'muted',
    '阻塞': 'bad', '失敗': 'bad', '未通過': 'bad',
    // 等級與燈號
    '高': 'bad', '中': 'warn', '低': 'ok',
    '紅': 'bad', '黃': 'warn', '綠': 'ok'
  };

  function chip(text) {
    if (!text) return '<span class="chip muted">—</span>';
    return `<span class="chip ${CHIP[text] || 'muted'}">${esc(text)}</span>`;
  }

  function light(color) {
    const cls = { '紅': 'bad', '黃': 'warn', '綠': 'ok' }[color] || 'muted';
    return `<span class="dot ${cls}" title="${esc(color || '未評估')}"></span>`;
  }

  // 進度條：實際（實心）＋預計（標線）
  function progressBar(actual, planned) {
    const a = Math.max(0, Math.min(1, num(actual)));
    const p = planned === undefined || planned === null ? null : Math.max(0, Math.min(1, num(planned)));
    const behind = p !== null && a < p - 0.0001;
    return `<div class="pbar ${behind ? 'behind' : ''}" title="實際 ${pct(a)}${p !== null ? '／預計 ' + pct(p) : ''}">
      <div class="pbar-fill" style="width:${(a * 100).toFixed(1)}%"></div>
      ${p !== null ? `<div class="pbar-mark" style="left:${(p * 100).toFixed(1)}%"></div>` : ''}
      <span class="pbar-label">${pct(a)}</span>
    </div>`;
  }

  // ---------- 提示訊息 ----------
  function toast(msg, type = 'info', ms = 3500) {
    const root = document.getElementById('toast-root');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  }

  // ---------- 對話框 ----------
  let modalOpen = false;

  function openModal({ title, body, footer = '', wide = false, onClose }) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            <button class="icon-btn" data-close aria-label="關閉">✕</button>
          </div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>
      </div>`;
    modalOpen = true;
    const close = () => { closeModal(); if (onClose) onClose(); };
    root.querySelector('[data-close]').onclick = close;
    root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-backdrop')) close();
    });
    return root.querySelector('.modal');
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    modalOpen = false;
  }

  function isModalOpen() { return modalOpen; }

  // 自訂確認視窗（回傳 Promise<boolean>）
  function confirmBox(message, okText = '確定', danger = false) {
    return new Promise((resolve) => {
      const m = openModal({
        title: '請確認',
        body: `<p class="confirm-text">${esc(message)}</p>`,
        footer: `<button class="btn ghost" data-no>取消</button>
                 <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button>`,
        onClose: () => resolve(false)
      });
      m.querySelector('[data-no]').onclick = () => { closeModal(); resolve(false); };
      m.querySelector('[data-yes]').onclick = () => { closeModal(); resolve(true); };
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

  const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316'];

  // ---------- 其他 ----------
  function groupCount(rows, key) {
    const out = {};
    rows.forEach((r) => { const k = r[key] || '未設定'; out[k] = (out[k] || 0) + 1; });
    return out;
  }

  // 依既有 ID 產生下一個流水號，例如 T-MKT-017 → T-MKT-018
  function nextId(existingIds, fallbackPrefix) {
    let best = null;
    existingIds.forEach((id) => {
      const m = String(id).match(/^(.*?)(\d+)$/);
      if (!m) return;
      const n = parseInt(m[2], 10);
      if (!best || n > best.n) best = { prefix: m[1], n, width: m[2].length };
    });
    if (!best) return `${fallbackPrefix}001`;
    return best.prefix + String(best.n + 1).padStart(best.width, '0');
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
    esc, num, pct, money, int, dec, date, dateTime, today, daysBetween,
    ROLE_COLOR, chip, light, progressBar, toast,
    openModal, closeModal, isModalOpen, confirmBox,
    chart, destroyCharts, PALETTE, groupCount, nextId, formData, emptyToNull, options
  };
})();
