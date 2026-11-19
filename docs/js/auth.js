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

  // ---------- 登入／註冊 ----------
  function renderLogin(message = '', mode = 'login') {
    const isSignup = mode === 'signup';
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
          <div class="tabs">
            <button class="tab ${isSignup ? '' : 'active'}" data-mode="login">登入</button>
            <button class="tab ${isSignup ? 'active' : ''}" data-mode="signup">註冊新帳號</button>
          </div>
          ${message ? `<div class="notice">${U.esc(message)}</div>` : ''}
          <form id="auth-form" autocomplete="on">
            <label>Email
              <input type="email" name="email" required autocomplete="username" placeholder="name@company.com">
            </label>
            <label>密碼
              <div class="pw-field">
                <input type="password" name="password" required autocomplete="${isSignup ? 'new-password' : 'current-password'}">
                <button type="button" class="pw-toggle">顯示</button>
              </div>
            </label>
            ${isSignup ? `
            <label>再輸入一次密碼
              <input type="password" name="password2" required autocomplete="new-password">
            </label>
            <p class="muted small">密碼至少 ${cfg.MIN_PASSWORD} 個字元，需包含英文字母與數字。</p>` : ''}
            <div class="form-error" id="auth-error"></div>
            <button class="btn primary block" type="submit">${isSignup ? '建立帳號' : '登入'}</button>
          </form>
          <p class="auth-hint">${isSignup
            ? '註冊後可以「建立新公司」，或輸入主管提供的「邀請碼」加入公司。'
            : '員工請先用公司 Email 註冊帳號，再輸入專案經理提供的邀請碼。'}</p>
        </div>
      </div>`;

    bindPwToggle();
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => renderLogin('', t.dataset.mode); });

    const form = document.getElementById('auth-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = U.formData(form);
      const errBox = document.getElementById('auth-error');
      const btn = form.querySelector('button[type=submit]');
      errBox.textContent = '';

      if (isSignup) {
        const p = passwordProblem(f.password);
        if (p) return (errBox.textContent = p);
        if (f.password !== f.password2) return (errBox.textContent = '兩次輸入的密碼不一致');
      }

      btn.disabled = true; btn.textContent = isSignup ? '建立中…' : '登入中…';
      try {
        if (isSignup) {
          const { data, error } = await API.sb.auth.signUp({
            email: f.email, password: f.password,
            options: { emailRedirectTo: location.origin + location.pathname }
          });
          if (error) return (errBox.textContent = authErrorText(error));
          if (!data.session) {
            return renderLogin('帳號已建立！請到信箱點選確認連結，完成後回到這裡登入。', 'login');
          }
        } else {
          const { error } = await API.sb.auth.signInWithPassword({ email: f.email, password: f.password });
          if (error) return (errBox.textContent = authErrorText(error));
          API.sb.rpc('touch_last_login').then(() => {}, () => {});
        }
        await App.start();
      } catch (err) {
        errBox.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = isSignup ? '建立帳號' : '登入';
      }
    };
  }

  // ---------- 登入後還沒有公司：建立公司 或 輸入邀請碼 ----------
  function renderOnboarding(email) {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="onboard">
          <div class="onboard-head">
            <h2>歡迎！接下來要做什麼？</h2>
            <p class="muted">目前登入：${U.esc(email)}　<a href="#" id="btn-out">登出</a></p>
          </div>
          <div class="onboard-grid">
            <div class="auth-card">
              <h3>🏢 建立新公司</h3>
              <p class="muted small">你會成為這家公司的第一位「專案經理」，之後可以邀請同事加入。</p>
              <form id="org-form">
                <label>公司名稱<input name="org" required maxlength="80" placeholder="例如：好日子行銷股份有限公司"></label>
                <label>你的姓名<input name="name" required maxlength="40"></label>
                <label>所屬部門<input name="dept" maxlength="40" placeholder="可留空"></label>
                <label>第一個專案名稱<input name="project" maxlength="80" placeholder="例如：2026 秋冬整合行銷"></label>
                <div class="form-error" id="org-error"></div>
                <button class="btn primary block" type="submit">建立公司</button>
              </form>
            </div>
            <div class="auth-card">
              <h3>✉️ 我有邀請碼</h3>
              <p class="muted small">請向公司的專案經理索取 8 碼邀請碼。註冊用的 Email 必須和被邀請的 Email 相同。</p>
              <form id="code-form">
                <label>邀請碼<input name="code" required maxlength="8" placeholder="例如：B809D65F" style="text-transform:uppercase;letter-spacing:2px"></label>
                <div class="form-error" id="code-error"></div>
                <button class="btn outline block" type="submit">加入公司</button>
              </form>
            </div>
          </div>
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
        U.toast('公司建立完成！', 'ok');
        await App.start();
      } catch (err) {
        document.getElementById('org-error').textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = '建立公司';
      }
    };

    const codeForm = document.getElementById('code-form');
    codeForm.onsubmit = async (e) => {
      e.preventDefault();
      const btn = codeForm.querySelector('button');
      btn.disabled = true; btn.textContent = '加入中…';
      try {
        const orgName = API.check(await API.sb.rpc('claim_invitation', { p_code: U.formData(codeForm).code }), '加入公司');
        U.toast(`已加入「${orgName}」`, 'ok');
        await App.start();
      } catch (err) {
        document.getElementById('code-error').textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = '加入公司';
      }
    };
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
    bindPwToggle(m);
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

  function bindPwToggle(scope = document) {
    scope.querySelectorAll('.pw-toggle').forEach((b) => {
      b.onclick = () => {
        const input = b.parentElement.querySelector('input');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.textContent = show ? '隱藏' : '顯示';
      };
    });
  }

  return {
    current, loadProfile, getSession, logout,
    renderLogin, renderOnboarding, renderChangePassword, renderBlocked, renderNotConfigured
  };
})();
