/**
 * 登入、註冊、建立公司／輸入邀請碼、變更密碼、登出
 */
const Auth = (() => {
  const cfg = window.APP_CONFIG;
  let profile = null;

  const current = () => profile;

  async function loadProfile() {
    const rows = API.check(await API.sb.rpc('get_my_profile'), '讀取帳號資料');
    profile = rows && rows.length ? rows[0] : null;
    return profile;
  }

  async function getSession() {
    const { data } = await API.sb.auth.getSession();
    return data.session;
  }

  async function logout() {
    await API.sb.auth.signOut();
    profile = null;
    API.cache.members = null;
    U.destroyCharts();
    history.replaceState(null, '', location.pathname);
    renderLogin();
  }

  function passwordProblem(pw, memberId = '') {
    if (pw.length < cfg.MIN_PASSWORD) return `密碼至少 ${cfg.MIN_PASSWORD} 個字元`;
    if (/[^\x20-\x7E]/.test(pw)) return '密碼只能使用英文、數字與半形符號（請確認不是中文或全形輸入）';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '密碼需同時包含英文字母與數字';
    if (memberId && pw.toLowerCase() === String(memberId).toLowerCase()) return '密碼不可與員工編號相同';
    return '';
  }

  function authErrorText(error) {
    const m = error.message || '';
    if (/Invalid login/i.test(m)) return '信箱或密碼錯誤';
    if (/already registered|already been registered|exists/i.test(m)) return '這個 Email 已經註冊過，請直接登入';
    if (/rate|too many|security purposes/i.test(m)) return '嘗試次數過多，請稍後再試';
    if (/Email not confirmed|confirm/i.test(m)) return 'Email 尚未驗證，請先到信箱點選確認連結';
    if (/weak|pwned|leaked/i.test(m)) return '這組密碼太常見，請換一組';
    if (/Signups not allowed|signup.*disabled/i.test(m)) return '系統目前未開放註冊（請在 Supabase 開啟 Allow new users to sign up）';
    return m;
  }

  // ---------- 記住 Email（只存 Email，不存密碼） ----------
  const REMEMBER_KEY = 'pm.rememberEmail';
  function rememberedEmail() {
    try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch (e) { return ''; }
  }
  function setRememberedEmail(email) {
    try {
      if (email) localStorage.setItem(REMEMBER_KEY, email);
      else localStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* 無痕模式等無法使用 localStorage 時，略過即可 */ }
  }

  // ---------- 重設密碼信連結回來時的狀態 ----------
  // 必須在 supabase 清掉網址 hash 之前讀取，所以在載入時就先記下來
  const bootHash = location.hash || '';
  let recoveryPending = /type=recovery/.test(bootHash);
  let bootLinkError = /error_code=|error=/.test(bootHash)
    ? (/otp_expired|expired/i.test(bootHash)
        ? '這個連結已失效或已使用過，請重新申請。'
        : '連結無法使用，請重新申請。')
    : '';
  if (API.sb) {
    API.sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') recoveryPending = true;
    });
  }
  /** 取出並清除「需要設定新密碼」的狀態（只會回傳一次 true） */
  function consumeRecovery() {
    const r = recoveryPending;
    recoveryPending = false;
    return r;
  }
  /** 取出並清除「連結失效」訊息（只顯示一次） */
  function consumeLinkError() {
    const m = bootLinkError;
    bootLinkError = '';
    return m;
  }

  // ---------- 邀請連結：網址帶 ?join=邀請碼 ----------
  // 存起來（30 天），註冊／收驗證信／登入後都還能自動帶入
  const JOIN_KEY = 'pm.joinCode';
  (function captureJoinLink() {
    try {
      const url = new URL(location.href);
      const code = (url.searchParams.get('join') || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 8);
      if (!url.searchParams.has('join')) return;
      if (code.length === 8) localStorage.setItem(JOIN_KEY, JSON.stringify({ code, ts: Date.now() }));
      url.searchParams.delete('join');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) { /* 無法使用 localStorage 時略過 */ }
  })();
  function pendingJoinCode() {
    try {
      const v = JSON.parse(localStorage.getItem(JOIN_KEY) || 'null');
      if (v && v.code && Date.now() - v.ts < 30 * 86400000) return v.code;
      localStorage.removeItem(JOIN_KEY);
    } catch (e) { /* ignore */ }
    return '';
  }
  function clearJoinCode() {
    try { localStorage.removeItem(JOIN_KEY); } catch (e) { /* ignore */ }
  }

  // ---------- 登入／註冊／忘記密碼 ----------
  // mode: 'login' | 'signup' | 'forgot'
  function renderLogin(message = '', mode = 'login') {
    if (!message && mode === 'login') {
      const linkErr = consumeLinkError();
      if (linkErr) {
        message = linkErr;
        history.replaceState(null, '', location.pathname);
      }
    }
    const isSignup = mode === 'signup';
    const isForgot = mode === 'forgot';
    const saved = rememberedEmail();
    const title = isSignup ? '註冊新帳號' : isForgot ? '忘記密碼' : '登入';
    const submitText = isSignup ? '建立帳號' : isForgot ? '寄送重設連結' : '登入';
    const busyText = isSignup ? '建立中…' : isForgot ? '寄送中…' : '登入中…';

    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="logo">AI</div>
            <div>
              <h1>${U.esc(cfg.APP_NAME)}</h1>
              <p>專案進度、行銷成效與 AI 預警，一個平台管理</p>
            </div>
          </div>
          <h2 class="auth-title">${title}</h2>
          ${message ? `<div class="notice" role="status">${U.esc(message)}</div>` : ''}
          ${isForgot ? '<p class="muted small">輸入註冊用的 Email，我們會寄一封重設密碼的連結給你。</p>' : ''}
          <form id="auth-form" autocomplete="on" novalidate>
            <label>Email
              <input type="email" name="email" required autocomplete="username" placeholder="name@company.com"
                value="${isSignup ? '' : U.esc(saved)}">
            </label>
            ${isForgot ? '' : `
            <label>密碼
              <div class="pw-field">
                <input type="password" name="password" required autocomplete="${isSignup ? 'new-password' : 'current-password'}">
                <button type="button" class="pw-toggle" aria-label="顯示密碼">顯示</button>
              </div>
            </label>`}
            ${isSignup ? `
            <label>再輸入一次密碼
              <input type="password" name="password2" required autocomplete="new-password">
            </label>
            <p class="muted small">密碼至少 ${cfg.MIN_PASSWORD} 個字元，需包含英文字母與數字。</p>` : ''}
            ${mode === 'login' ? `
            <div class="auth-row">
              <label class="check-inline">
                <input type="checkbox" name="remember" ${saved ? 'checked' : ''}> 記住我的 Email
              </label>
              <button type="button" class="link-btn" data-mode="forgot">忘記密碼？</button>
            </div>` : ''}
            <div class="form-error" id="auth-error" role="alert"></div>
            <button class="btn primary block" type="submit">${submitText}</button>
          </form>
          <p class="auth-switch">
            ${mode === 'login'
              ? '還沒有帳號？<button type="button" class="link-btn" data-mode="signup">註冊新帳號</button>'
              : isSignup
                ? '已經有帳號？<button type="button" class="link-btn" data-mode="login">返回登入</button>'
                : '<button type="button" class="link-btn" data-mode="login">← 返回登入</button>'}
          </p>
          ${isForgot ? '' : pendingJoinCode()
            ? `<p class="auth-hint join-hint">🔗 你是用<b>邀請連結</b>進來的（邀請碼 <b class="mono">${U.esc(pendingJoinCode())}</b>）。${isSignup ? '註冊並登入後會自動帶入。' : '還沒有帳號請先註冊；登入後會自動帶入邀請碼。'}</p>`
            : `<p class="auth-hint">${isSignup
            ? '註冊後可以「建立新公司」，或輸入主管提供的「邀請碼」加入公司。'
            : '員工請先用公司 Email 註冊帳號，再輸入專案經理提供的邀請碼或打開邀請連結。'}</p>`}
        </div>
      </div>`;

    bindCredentialInputs();
    document.querySelectorAll('.auth-card [data-mode]').forEach((b) => {
      b.onclick = () => renderLogin('', b.dataset.mode);
    });

    const form = document.getElementById('auth-form');
    // 有記住 Email 時，游標直接放在密碼欄
    const firstEmpty = [...form.querySelectorAll('input[type=email], input[type=password]')].find((i) => !i.value);
    (firstEmpty || form.querySelector('input'))?.focus();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = U.formData(form);
      const errBox = document.getElementById('auth-error');
      const btn = form.querySelector('button[type=submit]');
      errBox.textContent = '';

      const email = String(f.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (errBox.textContent = '請輸入正確的 Email');
      if (!isForgot && !f.password) return (errBox.textContent = '請輸入密碼');
      if (isSignup) {
        const p = passwordProblem(f.password);
        if (p) return (errBox.textContent = p);
        if (f.password !== f.password2) return (errBox.textContent = '兩次輸入的密碼不一致');
      }

      btn.disabled = true; btn.textContent = busyText;
      try {
        if (isForgot) {
          const { error } = await API.sb.auth.resetPasswordForEmail(email, {
            redirectTo: location.origin + location.pathname
          });
          if (error) return (errBox.textContent = authErrorText(error));
          // 不透露這個 Email 是否有註冊，統一顯示相同訊息
          return renderLogin(`如果「${email}」有註冊，幾分鐘內會收到重設密碼信（也請檢查垃圾郵件匣）。點信中的連結即可設定新密碼。`, 'login');
        }
        if (isSignup) {
          const { data, error } = await API.sb.auth.signUp({
            email, password: f.password,
            options: { emailRedirectTo: location.origin + location.pathname }
          });
          if (error) return (errBox.textContent = authErrorText(error));
          if (!data.session) {
            return renderLogin('帳號已建立！請到信箱點選確認連結，完成後回到這裡登入。', 'login');
          }
        } else {
          const { error } = await API.sb.auth.signInWithPassword({ email, password: f.password });
          if (error) return (errBox.textContent = authErrorText(error));
          setRememberedEmail(f.remember ? email : '');
          API.sb.rpc('touch_last_login').then(() => {}, () => {});
        }
        await App.start();
      } catch (err) {
        errBox.textContent = err.message;
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.textContent = submitText; }
      }
    };
  }

  // ---------- 從重設密碼信回來：設定新密碼 ----------
  function renderResetPassword(email) {
    history.replaceState(null, '', location.pathname);
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2 class="auth-title">設定新密碼</h2>
          <p class="muted small">帳號：${U.esc(email || '')}</p>
          <form id="reset-form" novalidate>
            <label>新密碼
              <div class="pw-field">
                <input type="password" name="pw1" required autocomplete="new-password">
                <button type="button" class="pw-toggle" aria-label="顯示密碼">顯示</button>
              </div>
            </label>
            <label>再輸入一次<input type="password" name="pw2" required autocomplete="new-password"></label>
            <p class="muted small">密碼至少 ${cfg.MIN_PASSWORD} 個字元，需包含英文字母與數字。</p>
            <div class="form-error" id="reset-error" role="alert"></div>
            <button class="btn primary block" type="submit">儲存新密碼並登入</button>
          </form>
          <p class="auth-switch"><button type="button" class="link-btn" id="reset-cancel">取消並登出</button></p>
        </div>
      </div>`;
    bindCredentialInputs();
    const form = document.getElementById('reset-form');
    form.querySelector('input').focus();
    document.getElementById('reset-cancel').onclick = logout;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { pw1, pw2 } = U.formData(form);
      const err = document.getElementById('reset-error');
      const btn = form.querySelector('button[type=submit]');
      err.textContent = '';
      const p = passwordProblem(pw1 || '');
      if (p) return (err.textContent = p);
      if (pw1 !== pw2) return (err.textContent = '兩次輸入的密碼不一致');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        const { error } = await API.sb.auth.updateUser({ password: pw1 });
        if (error) throw new Error(/same|different/i.test(error.message) ? '新密碼不可與舊密碼相同' : authErrorText(error));
        // 已加入公司的帳號才有這個紀錄；尚未加入公司時失敗可忽略
        await API.sb.rpc('mark_password_changed').then(() => {}, () => {});
        U.toast('密碼已更新', 'ok');
        await App.start();
      } catch (e2) {
        err.textContent = e2.message;
        btn.disabled = false; btn.textContent = '儲存新密碼並登入';
      }
    };
  }

  // ---------- 登入後還沒有公司：用邀請碼加入 或 建立公司 ----------
  function renderOnboarding(email) {
    const linkCode = pendingJoinCode();
    const joinCard = `
            <div class="auth-card join-card${linkCode ? ' highlight' : ''}">
              <h3>✉️ 我有邀請碼／邀請連結</h3>
              <p class="muted small">輸入專案經理給你的 8 碼邀請碼。專案邀請碼送出後，需等專案經理核准。</p>
              <form id="code-form" novalidate>
                <label>邀請碼<input name="code" required maxlength="12" autocomplete="off" autocapitalize="characters"
                  spellcheck="false" placeholder="例如：K7P3XQ9M" class="code-input" value="${U.esc(linkCode)}"></label>
                <div class="join-preview" id="join-preview" aria-live="polite"></div>
                <div class="join-extra" id="join-extra" hidden>
                  <label>你的姓名<input name="name" maxlength="40" autocomplete="name" placeholder="專案經理會看到這個名字"></label>
                  <label>所屬部門<input name="department" maxlength="40" placeholder="可留空"></label>
                </div>
                <div class="form-error" id="code-error" role="alert"></div>
                <button class="btn primary block" type="submit">加入</button>
              </form>
            </div>`;
    const orgCard = `
            <div class="auth-card">
              <h3>🏢 建立新公司</h3>
              <p class="muted small">你會成為這家公司的第一位「專案經理」，之後可以邀請同事加入。</p>
              <form id="org-form">
                <label>公司名稱<input name="org" required maxlength="80" placeholder="例如：好日子行銷股份有限公司"></label>
                <label>你的姓名<input name="name" required maxlength="40"></label>
                <label>所屬部門<input name="dept" maxlength="40" placeholder="可留空"></label>
                <label>第一個專案名稱<input name="project" maxlength="80" placeholder="例如：2026 秋冬整合行銷"></label>
                <div class="form-error" id="org-error"></div>
                <button class="btn outline block" type="submit">建立公司</button>
              </form>
            </div>`;

    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="onboard">
          <div class="onboard-head">
            <h2>歡迎！接下來要做什麼？</h2>
            <p class="muted">目前登入：${U.esc(email)}　<a href="#" id="btn-out">登出</a></p>
            ${UX.stepper(['註冊並登入', '輸入邀請碼', '專案經理核准', '開始使用'], 1)}
          </div>
          <div class="onboard-grid">${joinCard}${orgCard}</div>
        </div>
      </div>`;

    document.getElementById('btn-out').onclick = (e) => { e.preventDefault(); logout(); };

    const orgForm = document.getElementById('org-form');
    orgForm.onsubmit = async (e) => {
      e.preventDefault();
      const f = U.formData(orgForm);
      const btn = orgForm.querySelector('button');
      btn.disabled = true; btn.textContent = '建立中…';
      try {
        API.check(await API.sb.rpc('create_organization', {
          p_org_name: f.org, p_member_name: f.name, p_department: f.dept || null, p_project_name: f.project || null
        }), '建立公司');
        clearJoinCode();
        U.toast('公司建立完成！', 'ok');
        await App.start();
      } catch (err) {
        document.getElementById('org-error').textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = '建立公司';
      }
    };

    // --- 邀請碼：輸滿 8 碼自動查詢是哪家公司／哪個專案 ---
    const codeForm = document.getElementById('code-form');
    const codeInput = codeForm.elements.namedItem('code');
    const preview = document.getElementById('join-preview');
    const extra = document.getElementById('join-extra');
    const errBox = document.getElementById('code-error');
    const nameInput = codeForm.elements.namedItem('name');
    let kind = '';          // 'personal' | 'project' | ''
    let lookupSeq = 0;
    const clean = (v) => String(v || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 8);

    async function lookup() {
      const code = clean(codeInput.value);
      kind = ''; extra.hidden = true; errBox.textContent = '';
      if (code.length < 8) { preview.innerHTML = ''; return; }
      const seq = ++lookupSeq;
      preview.innerHTML = '<span class="muted small">查詢中…</span>';
      const { data, error } = await API.sb.rpc('preview_join_code', { p_code: code });
      if (seq !== lookupSeq) return;
      if (error || !data || !data.length) {
        preview.innerHTML = `<div class="join-target bad">${U.esc(error ? error.message : '邀請碼錯誤或已失效')}</div>`;
        return;
      }
      const r = data[0];
      kind = r.kind;
      preview.innerHTML = r.kind === 'project'
        ? `<div class="join-target"><span class="muted small">即將申請加入</span><b>${U.esc(r.org_name)}</b><span>專案：${U.esc(r.project_name)}</span></div>`
        : `<div class="join-target"><span class="muted small">即將加入</span><b>${U.esc(r.org_name)}</b><span>個人邀請，送出後立即加入</span></div>`;
      extra.hidden = r.kind !== 'project';
      if (r.kind === 'project' && !nameInput.value) nameInput.focus();
    }
    codeInput.addEventListener('input', () => {
      const pos = codeInput.selectionStart;
      const before = codeInput.value;
      const v = clean(before);
      if (v !== before) { codeInput.value = v; try { codeInput.setSelectionRange(Math.min(pos, v.length), Math.min(pos, v.length)); } catch (e) { /* ignore */ } }
      lookup();
    });
    if (codeInput.value) lookup(); else codeInput.focus();

    codeForm.onsubmit = async (e) => {
      e.preventDefault();
      const code = clean(codeInput.value);
      errBox.textContent = '';
      if (code.length !== 8) { errBox.textContent = '邀請碼是 8 碼英數字'; return codeInput.focus(); }
      if (!kind) await lookup();
      if (!kind) { errBox.textContent = errBox.textContent || '邀請碼錯誤或已失效'; return; }
      const name = String(nameInput.value || '').trim();
      if (kind === 'project' && !name) { errBox.textContent = '請填寫你的姓名'; return nameInput.focus(); }
      const btn = codeForm.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = '送出中…';
      try {
        const rows = API.check(await API.sb.rpc('join_with_code', {
          p_code: code, p_name: name || null, p_department: String(codeForm.elements.namedItem('department').value || '').trim() || null
        }), '加入');
        clearJoinCode();
        const r = rows[0];
        if (r.status === '已加入') {
          U.toast(`已加入「${r.org_name}」`, 'ok');
          await App.start();
        } else {
          U.toast('已送出加入申請，等待專案經理核准', 'ok');
          await App.start();
        }
      } catch (err) {
        errBox.textContent = err.message;
        btn.disabled = false; btn.textContent = '加入';
      }
    };
  }

  // ---------- 加入申請：審核中／被拒絕 ----------
  async function loadJoinRequest() {
    const { data, error } = await API.sb.rpc('get_my_join_request');
    if (error) return null;               // 舊版資料庫沒有這個函式時，直接走一般流程
    const r = data && data[0];
    if (!r) return null;
    try { if (r.status === '已拒絕' && sessionStorage.getItem('pm.dismissReq') === r.request_id) return null; } catch (e) { /* ignore */ }
    return r;
  }

  let joinPoll = null;
  function stopJoinPoll() { if (joinPoll) { clearInterval(joinPoll); joinPoll = null; } }

  function renderJoinStatus(req, email) {
    stopJoinPoll();
    const pending = req.status === '待審核';
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card join-status ${pending ? 'pending' : 'rejected'}">
          ${pending ? UX.stepper(['註冊並登入', '輸入邀請碼', '專案經理核准', '開始使用'], 2) : ''}
          <div class="join-status-icon" aria-hidden="true">${pending ? '⏳' : '✋'}</div>
          <h2>${pending ? '加入申請審核中' : '加入申請未通過'}</h2>
          <dl class="join-dl">
            <dt>公司</dt><dd>${U.esc(req.org_name)}</dd>
            <dt>專案</dt><dd>${U.esc(req.project_name || '—')}</dd>
            <dt>申請人</dt><dd>${U.esc(req.name)}（${U.esc(email)}）</dd>
            <dt>${pending ? '送出時間' : '處理時間'}</dt><dd>${U.dateTime(pending ? req.created_at : req.decided_at)}</dd>
            ${!pending && req.decision_note ? `<dt>說明</dt><dd>${U.esc(req.decision_note)}</dd>` : ''}
          </dl>
          <p class="muted small" role="status" id="join-msg">${pending
            ? '專案經理核准後就能使用系統。這個頁面會自動檢查，也可以按「重新檢查」。'
            : '如有疑問請聯絡專案經理，或改用其他邀請碼。'}</p>
          ${pending
            ? '<button class="btn primary block" id="btn-recheck">重新檢查</button><button class="btn ghost block" id="btn-cancel-req">取消申請</button>'
            : '<button class="btn primary block" id="btn-retry">重新輸入邀請碼</button>'}
          <button class="btn ghost block" id="btn-out">登出</button>
        </div>
      </div>`;
    document.getElementById('btn-out').onclick = () => { stopJoinPoll(); logout(); };

    if (!pending) {
      document.getElementById('btn-retry').onclick = () => {
        try { sessionStorage.setItem('pm.dismissReq', req.request_id); } catch (e) { /* ignore */ }
        renderOnboarding(email);
      };
      return;
    }

    const check = async (manual) => {
      try {
        const p = await loadProfile();
        if (p) { stopJoinPoll(); U.toast('申請已核准，歡迎加入！', 'ok'); return App.start(); }
        const r = await loadJoinRequest();
        if (!r) { stopJoinPoll(); return App.start(); }
        if (r.status !== '待審核') { return renderJoinStatus(r, email); }
        if (manual) document.getElementById('join-msg').textContent = `仍在審核中（${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 已檢查）`;
      } catch (e) { if (manual) U.toast(e.message, 'bad'); }
    };
    document.getElementById('btn-recheck').onclick = async (ev) => {
      ev.target.disabled = true; await check(true); if (document.body.contains(ev.target)) ev.target.disabled = false;
    };
    document.getElementById('btn-cancel-req').onclick = async () => {
      if (!(await U.confirmBox('確定要取消加入申請嗎？取消後可以重新輸入邀請碼。', '取消申請', true))) return;
      try {
        API.check(await API.sb.rpc('cancel_my_join_request'), '取消申請');
        stopJoinPoll(); U.toast('已取消申請', 'ok'); renderOnboarding(email);
      } catch (e) { U.toast(e.message, 'bad'); }
    };
    joinPoll = setInterval(() => { if (!document.hidden) check(false); }, 20000);
  }
  // ---------- 變更密碼 ----------
  function renderChangePassword({ forced = false } = {}) {
    const body = `
      <form id="pw-form" class="stack">
        ${forced ? '<p class="notice">為了帳號安全，請先設定新密碼。</p>' : ''}
        <ul class="pw-rules">
          <li>至少 ${cfg.MIN_PASSWORD} 個字元</li>
          <li>需同時包含英文字母與數字</li>
        </ul>
        <label>新密碼
          <div class="pw-field">
            <input type="password" name="pw1" required autocomplete="new-password">
            <button type="button" class="pw-toggle">顯示</button>
          </div>
        </label>
        <label>再輸入一次<input type="password" name="pw2" required autocomplete="new-password"></label>
        <div class="form-error" id="pw-error"></div>
      </form>`;
    const m = U.openModal({
      title: forced ? '請設定新密碼' : '變更密碼', body,
      footer: `<span class="spacer"></span>
        ${forced ? '<button class="btn ghost" data-out>登出</button>' : '<button class="btn ghost" data-cancel>取消</button>'}
        <button class="btn primary" id="pw-save">儲存新密碼</button>`
    });
    bindCredentialInputs(m);
    m.querySelector('[data-cancel]')?.addEventListener('click', U.closeModal);
    m.querySelector('[data-out]')?.addEventListener('click', () => { U.closeModal(); logout(); });
    m.querySelector('#pw-save').onclick = async (ev) => {
      const { pw1, pw2 } = U.formData(m.querySelector('#pw-form'));
      const err = m.querySelector('#pw-error');
      const p = passwordProblem(pw1, profile?.member_id);
      if (p) return (err.textContent = p);
      if (pw1 !== pw2) return (err.textContent = '兩次輸入的密碼不一致');
      ev.target.disabled = true;
      try {
        const { error } = await API.sb.auth.updateUser({ password: pw1 });
        if (error) throw new Error(/same|different/i.test(error.message) ? '新密碼不可與舊密碼相同' : authErrorText(error));
        await API.sb.rpc('mark_password_changed');
        U.toast('密碼已更新', 'ok');
        U.closeModal();
        if (forced) await App.start();
      } catch (e2) {
        err.textContent = e2.message;
        ev.target.disabled = false;
      }
    };
  }

  // ---------- 帳號停用／公司停權 ----------
  function renderBlocked(title, text) {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2>${U.esc(title)}</h2>
          <p>${U.esc(text)}</p>
          <button class="btn primary block" id="btn-out">登出</button>
        </div>
      </div>`;
    document.getElementById('btn-out').onclick = logout;
  }

  function renderNotConfigured() {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2>尚未設定 Supabase 連線</h2>
          <p>請編輯 <code>docs/js/config.js</code>，填入 SUPABASE_URL 與 anon（Publishable）key。</p>
        </div>
      </div>`;
  }

  // ---------- 密碼與 Email 欄位：中文輸入法保護 ----------
  // 網頁無法強制切換作業系統的輸入法，因此改用以下方式：
  // 1. 「顯示密碼」不再把欄位改成一般文字欄（那會讓中文輸入法重新啟用），
  //    欄位維持密碼欄，改在下方顯示一行明碼預覽（Chrome 不允許直接取消密碼欄的遮蔽）。
  // 2. 全形英數（例如 ａｂｃ１２３＠）自動轉成半形。
  // 3. 若輸入法仍組字（例如注音、拼音），組好的中文字會被移除，並提示切換方式。
  // 4. Caps Lock 開啟時提示。
  const toHalfWidth = (v) => v
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
  const NON_ASCII = /[^\x20-\x7E]/g;

  function hintFor(input) {
    const host = input.closest('.pw-field') || input;
    let h = host.parentElement.querySelector(':scope > .ime-hint');
    if (!h) {
      h = document.createElement('div');
      h.className = 'ime-hint';
      h.setAttribute('role', 'status');
      h.setAttribute('aria-live', 'polite');
      host.insertAdjacentElement('afterend', h);
    }
    return h;
  }
  function showHint(input, text) {
    const h = hintFor(input);
    h.textContent = text;
    h.hidden = !text;
  }

  function bindCredentialInputs(scope = document) {
    // 顯示／隱藏密碼：欄位維持 password，另外顯示明碼預覽
    scope.querySelectorAll('.pw-toggle').forEach((b) => {
      const input = b.parentElement.querySelector('input');
      const preview = document.createElement('div');
      preview.className = 'pw-preview';
      preview.hidden = true;
      b.parentElement.insertAdjacentElement('afterend', preview);
      const paint = () => {
        preview.textContent = input.value ? input.value : '（尚未輸入）';
        preview.classList.toggle('is-empty', !input.value);
      };
      input.addEventListener('input', () => { if (!preview.hidden) paint(); });
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', '顯示密碼');
      b.onclick = () => {
        const show = b.getAttribute('aria-pressed') !== 'true';
        preview.hidden = !show;
        if (show) paint();
        b.setAttribute('aria-pressed', String(show));
        b.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
        b.textContent = show ? '隱藏' : '顯示';
        input.focus();
      };
    });

    scope.querySelectorAll('input[type=password], input[type=email]').forEach((input) => {
      if (input.dataset.imeGuard) return;
      input.dataset.imeGuard = '1';
      const isPw = input.type === 'password';
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
      if (!isPw) input.setAttribute('inputmode', 'email');
      let composing = false;
      let imeWarned = false;

      const clean = () => {
        const before = input.value;
        let v = toHalfWidth(before);
        const converted = v !== before;
        const hadCjk = NON_ASCII.test(v);
        NON_ASCII.lastIndex = 0;
        if (hadCjk) v = v.replace(NON_ASCII, '');
        if (v !== before) {
          queueMicrotask(() => input.dispatchEvent(new Event('input')));
          const pos = Math.max(0, (input.selectionStart ?? v.length) - (before.length - v.length));
          input.value = v;
          try { input.setSelectionRange(pos, pos); } catch (e) { /* email 欄位不支援游標設定，略過 */ }
        }
        if (hadCjk || imeWarned) {
          imeWarned = true;
          showHint(input, `偵測到中文輸入法，${isPw ? '密碼' : 'Email'}只能輸入英文、數字與符號。請先切換成英文（Windows：按 Shift 或 Ctrl＋空白鍵；Mac：Control＋空白鍵）。`);
        } else if (converted) {
          showHint(input, '已將全形字元自動轉成半形。');
        } else if (input.value === '') {
          showHint(input, '');
        }
      };

      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; clean(); });
      input.addEventListener('input', () => { if (!composing) clean(); });
      // 失去焦點時不清除提示：登入卡片是垂直置中的，提示消失會讓版面位移、按鈕點不到
      input.addEventListener('blur', () => { if (!isPw) input.value = input.value.trim(); });
      if (isPw) {
        const caps = (e) => {
          if (typeof e.getModifierState !== 'function') return;
          const on = e.getModifierState('CapsLock');
          if (imeWarned) return;
          showHint(input, on ? '注意：Caps Lock 已開啟（大寫鎖定）。' : '');
        };
        input.addEventListener('keydown', caps);
        input.addEventListener('keyup', caps);
      }
    });
  }

  return {
    current, loadProfile, getSession, logout, consumeRecovery,
    renderLogin, renderResetPassword, renderOnboarding, renderChangePassword, renderBlocked, renderNotConfigured,
    loadJoinRequest, renderJoinStatus, stopJoinPoll
  };
})();
