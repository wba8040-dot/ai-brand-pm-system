/**
 * 全站回饋與防呆機制（自動套用到所有頁面，不需各頁個別呼叫）
 *
 * 【回饋】
 *  - 頁面頂部載入進度條：只要有任何資料請求就顯示
 *  - 骨架屏：換頁時先顯示版面輪廓（UX.skeleton）
 *  - 按鈕處理中：主要按鈕按下後若有送資料，自動顯示轉圈並鎖住，資料回來才解除
 *  - 狀態橫幅：離線、閒置即將登出（UX.banner）
 *  - 表單即時驗證：離開欄位時顯示 ✓ 或錯誤原因；字數計數器；密碼強度條；必填標記
 *
 * 【防呆】
 *  - 防連點：同一顆按鈕 0.6 秒內的第二次點擊會被忽略
 *  - 必填未完成：送出鈕呈現停用樣式並提示還差幾欄，點了會直接跳到第一個問題欄位
 *  - 防誤關：對話框有未儲存修改（或個人資料頁未儲存）時，關分頁／重新整理會跳瀏覽器警告；
 *            切換選單頁面時先詢問
 *  - 輸入約束：Email 自動去空白轉小寫、數字欄擋掉 e / + / -、全形數字自動轉半形
 *  - 閒置逾時：30 分鐘沒有操作先倒數提醒 2 分鐘，再自動登出（草稿已自動保存）
 */
const UX = (() => {
  const cfg = window.APP_CONFIG || {};

  // =====================================================================
  // 1. 追蹤所有資料請求（必須在建立 Supabase 用戶端之前載入）
  // =====================================================================
  let inflight = 0;
  let reqSeq = 0;
  const idleWaiters = [];
  const nativeFetch = window.fetch.bind(window);

  window.fetch = function trackedFetch(...args) {
    inflight += 1; reqSeq += 1;
    progress.start();
    let p;
    try { p = nativeFetch(...args); } catch (e) { p = Promise.reject(e); }
    return p.finally(() => {
      inflight = Math.max(0, inflight - 1);
      if (!inflight) {
        progress.done();
        idleWaiters.splice(0).forEach((fn) => setTimeout(fn, 0));
      }
    });
  };
  const whenIdle = (fn) => (inflight ? idleWaiters.push(fn) : setTimeout(fn, 0));

  // =====================================================================
  // 2. 頁面頂部載入進度條
  // =====================================================================
  const progress = (() => {
    let el = null; let showTimer = null; let trickle = null; let width = 0; let visible = false;
    const ensure = () => {
      if (el || !document.body) return el;
      el = document.createElement('div');
      el.id = 'top-progress';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<div class="bar"></div>';
      document.body.appendChild(el);
      return el;
    };
    const set = (w) => { width = w; if (el) el.firstChild.style.transform = `scaleX(${w / 100})`; };
    return {
      start() {
        if (visible || showTimer) return;
        // 150ms 內就完成的請求不顯示，避免畫面一直閃
        showTimer = setTimeout(() => {
          showTimer = null;
          if (!inflight || !ensure()) return;
          visible = true;
          el.classList.remove('done'); el.classList.add('active');
          set(12);
          trickle = setInterval(() => set(width + (90 - width) * 0.08), 200);
        }, 150);
      },
      done() {
        clearTimeout(showTimer); showTimer = null;
        if (!visible) return;
        clearInterval(trickle);
        set(100);
        el.classList.add('done');
        setTimeout(() => { if (!inflight) { el.classList.remove('active', 'done'); set(0); visible = false; } }, 350);
      }
    };
  })();

  // =====================================================================
  // 3. 骨架屏
  // =====================================================================
  function skeleton(kind = 'page') {
    const line = (w, h = 12) => `<span class="sk" style="width:${w};height:${h}px"></span>`;
    const card = (lines) => `<div class="card sk-card">${lines.join('')}</div>`;
    if (kind === 'table') {
      return `<div class="card sk-card">${Array.from({ length: 6 }, () =>
        `<div class="sk-row">${line('22%')}${line('30%')}${line('14%')}${line('18%')}</div>`).join('')}</div>`;
    }
    return `<div class="skeleton" role="status" aria-live="polite">
      <span class="sr-only">資料載入中…</span>
      <div class="sk-kpis">${Array.from({ length: 4 }, () => card([line('40%', 10), line('60%', 26)])).join('')}</div>
      <div class="sk-grid">
        ${card([line('35%', 14), line('100%'), line('92%'), line('80%'), line('86%'), line('60%')])}
        ${card([line('45%', 14), line('100%', 120)])}
      </div>
      ${skeleton('table')}
    </div>`;
  }

  // =====================================================================
  // 4. 按鈕：防連點＋自動顯示處理中
  // =====================================================================
  const BUSY_SEL = 'button[type=submit], .btn.primary, .btn.danger:not(.ghost), [data-approve], [data-busy]';

  function markBusy(btn) {
    if (btn.dataset.uxBusy) return;
    btn.dataset.uxBusy = '1';
    btn.__uxWasDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    const started = Date.now();
    whenIdle(function release() {
      if (inflight) return whenIdle(release);
      // 至少顯示 300ms，避免閃一下就不見
      setTimeout(() => {
        if (!btn.dataset.uxBusy) return;
        delete btn.dataset.uxBusy;
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        if (document.contains(btn)) btn.disabled = !!btn.__uxWasDisabled;
      }, Math.max(0, 300 - (Date.now() - started)));
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    // 處理中：完全不接受點擊
    if (btn.getAttribute('aria-busy') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // 必填未完成：跳到第一個問題欄位
    if (btn.getAttribute('aria-disabled') === 'true' && btn.dataset.uxGate) {
      const form = gateFormOf(btn);
      if (form && !form.checkValidity()) {
        e.preventDefault(); e.stopImmediatePropagation();
        revealErrors(form);
        return;
      }
    }
    if (!btn.matches(BUSY_SEL) || btn.matches('[data-no-busy]')) return;
    // 防連點
    // 真正的連點（0.3 秒內）一律擋；上一次有送出資料的話，0.6 秒內都擋
    const now = Date.now();
    if (btn.__uxLast && now - btn.__uxLast < (btn.__uxSent ? 600 : 300)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    btn.__uxLast = now; btn.__uxSent = false;
    const seq0 = reqSeq;
    setTimeout(() => {
      if (reqSeq > seq0) btn.__uxSent = true;
      if (reqSeq > seq0 && inflight && document.contains(btn)) markBusy(btn);
    }, 40);
  }, true);

  // =====================================================================
  // 5. 狀態橫幅（離線、閒置逾時…）
  // =====================================================================
  function banner(id, { text, type = 'info', actions = [] } = {}) {
    let root = document.getElementById('banner-root');
    if (!root) { root = document.createElement('div'); root.id = 'banner-root'; document.body.prepend(root); }
    let b = document.getElementById(`banner-${id}`);
    if (!text) { if (b) b.remove(); return null; }
    if (!b) {
      b = document.createElement('div');
      b.id = `banner-${id}`;
      b.className = 'banner';
      b.setAttribute('role', type === 'bad' || type === 'warn' ? 'alert' : 'status');
      root.appendChild(b);
    }
    b.className = `banner ${type}`;
    // 只有文字變動（例如倒數秒數）時不重建按鈕，避免使用者正在按的按鈕被換掉
    const sig = actions.map((a) => a.label).join('|');
    if (b.dataset.sig === sig && b.querySelector('.banner-text')) {
      b.querySelector('.banner-text').textContent = text;
      b.__actions = actions;
      return b;
    }
    b.dataset.sig = sig;
    b.__actions = actions;
    b.innerHTML = `<span class="banner-text">${U.esc(text)}</span>${actions.map((a, i) =>
      `<button class="btn small ${i === 0 ? 'primary' : 'ghost'}" data-act="${i}" data-no-busy>${U.esc(a.label)}</button>`).join('')}`;
    b.querySelectorAll('[data-act]').forEach((x) => { x.onclick = () => b.__actions[Number(x.dataset.act)].onClick(); });
    return b;
  }

  function watchOnline() {
    const update = () => {
      if (navigator.onLine) {
        if (document.getElementById('banner-offline')) { banner('offline'); U.toast('網路已恢復連線', 'ok'); }
      } else {
        banner('offline', { type: 'bad', text: '⚠ 目前沒有網路連線，修改將無法儲存。恢復連線後請再按一次儲存。' });
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    if (!navigator.onLine) update();
  }

  // =====================================================================
  // 6. 表單：必填標記、即時驗證、字數計數、密碼強度、輸入約束
  // =====================================================================
  const FIELD_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), select, textarea';

  function messageFor(el) {
    const v = el.validity;
    if (v.valid) return '';
    if (v.valueMissing) return el.tagName === 'SELECT' ? '請選擇一個項目' : '此欄位必填';
    if (v.typeMismatch && el.type === 'email') return 'Email 格式不正確，例如 name@company.com';
    if (v.typeMismatch) return '格式不正確';
    if (v.badInput) return el.type === 'number' ? '請輸入數字' : '格式不正確';
    if (v.tooLong) return `最多 ${el.maxLength} 個字`;
    if (v.tooShort) return `至少 ${el.minLength} 個字`;
    if (v.rangeUnderflow) return `不可小於 ${el.min}`;
    if (v.rangeOverflow) return `不可大於 ${el.max}`;
    if (v.patternMismatch) return el.title || '格式不正確';
    if (v.customError) return el.validationMessage;
    return el.validationMessage || '請檢查此欄位';
  }

  function msgBox(el) {
    let box = el.__uxMsg;
    if (box && document.contains(box)) return box;
    box = document.createElement('span');
    box.className = 'field-msg';
    box.id = `fm-${Math.random().toString(36).slice(2, 9)}`;
    box.setAttribute('aria-live', 'polite');
    const anchor = el.closest('.pw-field') || el;
    anchor.insertAdjacentElement('afterend', box);
    el.__uxMsg = box;
    el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), box.id].filter(Boolean).join(' '));
    return box;
  }

  function validateField(el, { quietOk = false } = {}) {
    if (el.disabled || el.readOnly || el.closest('[hidden]')) return true;
    const msg = messageFor(el);
    const box = msgBox(el);
    const meaningful = el.required || el.type === 'email' || el.type === 'number' || el.maxLength > 0;
    if (msg) {
      box.textContent = msg; box.className = 'field-msg bad';
      el.setAttribute('aria-invalid', 'true');
      el.classList.add('is-invalid'); el.classList.remove('is-valid');
      return false;
    }
    el.removeAttribute('aria-invalid');
    el.classList.remove('is-invalid');
    const showOk = !quietOk && meaningful && String(el.value || '').trim() !== '';
    // ✓ 顯示在欄位內（背景圖示），不額外佔一行，避免版面跳動
    el.classList.toggle('is-valid', showOk);
    box.textContent = ''; box.className = 'field-msg';
    return true;
  }

  // 滑鼠／手指按著的時候先不改版面，等這次點擊完成再顯示訊息（否則按鈕被擠開，點擊會落空）
  let pointerDown = false;
  const afterUp = [];
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  const release = () => { pointerDown = false; setTimeout(() => afterUp.splice(0).forEach((fn) => fn()), 0); };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  function afterPointer(fn) { if (pointerDown) afterUp.push(fn); else fn(); }

  function revealErrors(form) {
    const bad = [...form.querySelectorAll(FIELD_SEL)].filter((el) => !el.disabled && !el.closest('[hidden]') && !el.checkValidity());
    bad.forEach((el) => { el.dataset.uxTouched = '1'; validateField(el); });
    if (bad[0]) { bad[0].focus(); bad[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  function passwordScore(pw) {
    if (!pw) return 0;
    let s = 0;
    if (pw.length >= (cfg.MIN_PASSWORD || 8)) s += 1;
    if (pw.length >= 12) s += 1;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s += 1;
    if (/\d/.test(pw) && /[A-Za-z]/.test(pw)) s += 1;
    if (/[^A-Za-z0-9]/.test(pw)) s += 1;
    if (/^(.)\1+$/.test(pw) || /^(12345|password|qwerty|abc123)/i.test(pw)) s = 1;
    return Math.min(4, Math.max(1, s));
  }
  const PW_LABEL = ['', '弱', '普通', '良好', '強'];

  function attachMeter(input) {
    const meter = document.createElement('div');
    meter.className = 'pw-meter';
    meter.innerHTML = '<div class="pw-meter-bar"><i></i><i></i><i></i><i></i></div><span class="pw-meter-text" aria-live="polite"></span>';
    (input.closest('.pw-field') || input).insertAdjacentElement('afterend', meter);
    const update = () => {
      const s = passwordScore(input.value);
      meter.dataset.score = String(s);
      meter.querySelector('.pw-meter-text').textContent = input.value ? `密碼強度：${PW_LABEL[s]}` : '';
    };
    input.addEventListener('input', update);
    update();
  }

  function attachCounter(el) {
    const max = el.maxLength;
    const c = document.createElement('span');
    c.className = 'char-count';
    c.setAttribute('aria-hidden', 'true');
    el.insertAdjacentElement('afterend', c);
    const update = () => {
      const n = el.value.length;
      c.textContent = `${n} / ${max}`;
      c.classList.toggle('near', n >= max * 0.9);
      c.hidden = n === 0 && el.tagName !== 'TEXTAREA';
    };
    el.addEventListener('input', update);
    update();
  }

  // 送出鈕與它的表單
  function gateFormOf(btn) {
    if (btn.form) return btn.form;
    const modal = btn.closest('.modal');
    return modal ? modal.querySelector('form') : null;
  }
  function updateGate(form) {
    const btn = form.__uxGateBtn;
    if (!btn || !document.contains(btn)) return;
    const missing = [...form.querySelectorAll(FIELD_SEL)]
      .filter((el) => !el.disabled && !el.closest('[hidden]') && !el.checkValidity());
    if (missing.length) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = `還有 ${missing.length} 個欄位未完成或格式不正確`;
    } else {
      btn.removeAttribute('aria-disabled');
      if (btn.title.startsWith('還有 ')) btn.removeAttribute('title');
    }
  }

  function enhanceForm(form) {
    if (form.dataset.ux) return;
    form.dataset.ux = '1';
    const fields = [...form.querySelectorAll(FIELD_SEL)];

    fields.forEach((el) => {
      // 必填星號
      if (el.required) {
        const lab = el.closest('label');
        if (lab && !lab.querySelector('.req')) {
          const txt = [...lab.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
          if (txt) {
            const wrap = document.createElement('span');
            wrap.className = 'lbl';
            wrap.textContent = txt.textContent.replace(/\s+$/, '');
            const star = document.createElement('span');
            star.className = 'req req-auto'; star.textContent = '*'; star.setAttribute('aria-hidden', 'true');
            wrap.appendChild(star);
            txt.replaceWith(wrap);
          }
        }
      }
      // 長文字欄位上限（避免貼上整份文件）＋字數計數
      if (el.tagName === 'TEXTAREA' && !el.readOnly && el.maxLength < 0) el.maxLength = 2000;
      if (!el.readOnly && !el.disabled && el.maxLength >= 40 && (el.tagName === 'TEXTAREA' || el.type === 'text' || !el.getAttribute('type'))) attachCounter(el);
      // 數字欄：步進只影響上下箭頭，不讓 12,345 這類值被判為錯誤
      if (el.type === 'number') {
        if (Number(el.step) > 1) { el.dataset.step = el.step; el.step = 'any'; }
        el.inputMode = el.step === 'any' || Number(el.step) < 1 ? 'decimal' : 'numeric';
        el.addEventListener('keydown', (e) => {
          if (['e', 'E', '+'].includes(e.key) || (e.key === '-' && Number(el.min) >= 0)) e.preventDefault();
        });
        el.addEventListener('wheel', () => { if (document.activeElement === el) el.blur(); }, { passive: true });
      }
      if (el.type === 'email') {
        el.addEventListener('blur', () => { const v = el.value.trim().toLowerCase(); if (v !== el.value) el.value = v; });
      }
      // 全形英數自動轉半形（Email、數字、代碼）
      if (['email', 'number', 'tel'].includes(el.type) || el.classList.contains('code-input')) {
        el.addEventListener('input', () => {
          const v = el.value.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
          if (v !== el.value && el.type !== 'number') el.value = v;
        });
      }
      // 新密碼：強度條
      if (el.type === 'password' && el.autocomplete === 'new-password' && /^(password|pw1|new_password)$/.test(el.name)) attachMeter(el);

      // 即時驗證：離開欄位時檢查；已顯示錯誤的欄位邊打邊更新
      // 只檢查使用者真的改過的欄位（避免一打開對話框、點別的按鈕時欄位下方突然冒出訊息，造成版面跳動點錯）
      el.addEventListener('blur', () => {
        if (!el.dataset.uxEdited) return;
        el.dataset.uxTouched = '1';
        afterPointer(() => validateField(el));
      });
      el.addEventListener('input', () => {
        el.dataset.uxEdited = '1';
        if (el.dataset.uxTouched) validateField(el, { quietOk: false });
        updateGate(form);
      });
      el.addEventListener('change', () => {
        if (el.tagName === 'SELECT' || el.type === 'date') { el.dataset.uxEdited = '1'; el.dataset.uxTouched = '1'; }
        if (el.dataset.uxTouched) validateField(el);
        updateGate(form);
      });
    });

    // 再輸入一次密碼：即時比對
    const pw2 = form.querySelector('input[name=password2], input[name=pw2]');
    const pw1 = form.querySelector('input[name=password], input[name=pw1]');
    if (pw1 && pw2) {
      const match = () => {
        pw2.setCustomValidity(pw2.value && pw2.value !== pw1.value ? '兩次輸入的密碼不一致' : '');
        if (pw2.dataset.uxTouched || pw2.value.length >= pw1.value.length) { pw2.dataset.uxTouched = pw2.value ? '1' : ''; if (pw2.value) validateField(pw2); }
        updateGate(form);
      };
      pw1.addEventListener('input', match); pw2.addEventListener('input', match);
    }

    // 送出鈕：必填未完成時呈現停用樣式
    const modal = form.closest('.modal');
    const btn = form.querySelector('button[type=submit]:not([data-no-gate])')
      || (modal && modal.querySelector('.modal-foot .btn.primary:not([data-no-gate])'));
    if (btn && fields.some((el) => el.required || el.type === 'email' || el.type === 'number' || el.minLength > 0)) {
      btn.dataset.uxGate = '1';
      form.__uxGateBtn = btn;
      updateGate(form);
      // 瀏覽器自動填入不一定觸發 input 事件，稍後再檢查一次
      setTimeout(() => updateGate(form), 600);
    }
  }

  // 有新畫面產生時自動套用
  let enhanceQueued = false;
  function enhanceAll() {
    enhanceQueued = false;
    document.querySelectorAll('form:not([data-ux])').forEach(enhanceForm);
  }
  const observer = new MutationObserver(() => {
    if (enhanceQueued) return;
    enhanceQueued = true;
    requestAnimationFrame(enhanceAll);
  });

  // =====================================================================
  // 7. 防誤關：未儲存修改
  // =====================================================================
  const hasUnsaved = () => (U.isModalDirty && U.isModalDirty()) || !!document.body.dataset.unsaved;

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';   // 舊版瀏覽器需要
  });

  // 選單換頁前確認（個人資料頁有未儲存修改時）
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a || !document.body.dataset.unsaved || a.dataset.uxConfirmed) return;
    if (a.getAttribute('href') === location.hash) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const ok = await U.confirmBox('這一頁有尚未儲存的修改，離開後修改會遺失。確定要離開嗎？', '離開不儲存', true);
    if (!ok) return;
    delete document.body.dataset.unsaved;
    location.hash = a.getAttribute('href');
  }, true);

  // =====================================================================
  // 8. 閒置逾時：先倒數提醒，再自動登出
  // =====================================================================
  const IDLE_MIN = Number(cfg.IDLE_MINUTES) || 30;
  const WARN_SEC = 120;
  const ACT_KEY = 'pm.lastActive';
  let lastLocal = Date.now();
  let lastWrite = 0;
  function touch(e) {
    lastLocal = Date.now();
    if (lastLocal - lastWrite > 15000) {       // 多個分頁共用活動時間
      lastWrite = lastLocal;
      try { localStorage.setItem(ACT_KEY, String(lastLocal)); } catch (e) { /* ignore */ }
    }
    // 點的是橫幅上的「繼續使用」時，交給按鈕自己處理（才看得到「已延長」提示）
    const onBanner = e && e.target && e.target.closest && e.target.closest('#banner-idle');
    if (!onBanner && document.getElementById('banner-idle')) banner('idle');
  }
  function lastActive() {
    let shared = 0;
    try { shared = Number(localStorage.getItem(ACT_KEY)) || 0; } catch (e) { /* ignore */ }
    return Math.max(lastLocal, shared);
  }
  function watchIdle() {
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
      window.addEventListener(ev, touch, { passive: true, capture: true }));
    let lastMove = 0;
    window.addEventListener('pointermove', () => { const n = Date.now(); if (n - lastMove > 5000) { lastMove = n; touch(); } }, { passive: true });
    setInterval(() => {
      if (typeof Auth === 'undefined' || !Auth.current()) { banner('idle'); return; }
      const idleSec = (Date.now() - lastActive()) / 1000;
      const left = Math.ceil(IDLE_MIN * 60 - idleSec);
      if (left <= 0) {
        banner('idle');
        Auth.logout().then(() => U.toast(`閒置超過 ${IDLE_MIN} 分鐘，已自動登出。未儲存的表單已保存為草稿。`, 'warn', 10000));
        return;
      }
      if (left <= WARN_SEC) {
        const mm = Math.floor(left / 60); const ss = String(left % 60).padStart(2, '0');
        banner('idle', {
          type: 'warn',
          text: `⏱ 你已閒置一段時間，將在 ${mm}:${ss} 後自動登出。`,
          actions: [{ label: '繼續使用', onClick: () => { lastWrite = 0; touch(); U.toast('已延長登入時間', 'ok'); } }]
        });
      } else if (document.getElementById('banner-idle')) {
        banner('idle');
      }
    }, 1000);
  }

  // =====================================================================
  // 9. 多步驟流程條
  // =====================================================================
  function stepper(steps, current) {
    return `<ol class="stepper" aria-label="進度">${steps.map((s, i) => {
      const state = i < current ? 'done' : i === current ? 'current' : '';
      return `<li class="${state}" ${i === current ? 'aria-current="step"' : ''}>
        <span class="step-dot" aria-hidden="true">${i < current ? '✓' : i + 1}</span><span class="step-label">${U.esc(s)}</span></li>`;
    }).join('')}</ol>`;
  }

  // ---------- 啟動 ----------
  function init() {
    observer.observe(document.body, { childList: true, subtree: true });
    enhanceAll();
    watchOnline();
    watchIdle();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { skeleton, banner, stepper, markBusy, validateField, revealErrors, passwordScore, isBusy: () => inflight > 0, touch };
})();
