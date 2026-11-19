/**
 * 登入、首次登入強制改密碼、登出
 * 帳號由 Supabase Auth 管理（員工信箱＋密碼）
 */
const Auth = (() => {
  const cfg = window.APP_CONFIG;
  let profile = null;

  function current() { return profile; }

  async function loadProfile() {
    const res = await API.sb.rpc('get_my_profile');
    const rows = API.check(res, '讀取帳號資料');
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
    location.hash = '';
    renderLogin();
  }

  // ---------- 登入頁 ----------
  function renderLogin(message = '') {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="logo">AI</div>
            <div>
              <h1>${U.esc(cfg.APP_NAME)}</h1>
              <p>請使用員工信箱登入</p>
            </div>
          </div>
          ${message ? `<div class="notice">${U.esc(message)}</div>` : ''}
          <form id="login-form" autocomplete="on">
            <label>員工信箱
              <input type="email" name="email" required autocomplete="username" placeholder="name@example.com">
            </label>
            <label>密碼
              <div class="pw-field">
                <input type="password" name="password" required autocomplete="current-password" placeholder="首次登入請輸入員工ID">
                <button type="button" class="pw-toggle" aria-label="顯示密碼">顯示</button>
              </div>
            </label>
            <div class="form-error" id="login-error"></div>
            <button class="btn primary block" type="submit">登入</button>
          </form>
          <p class="auth-hint">忘記密碼請聯絡專案經理重設。連續輸入錯誤過多次會被暫時限制登入。</p>
        </div>
      </div>`;

    bindPwToggle();
    const form = document.getElementById('login-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { email, password } = U.formData(form);
      const btn = form.querySelector('button[type=submit]');
      const errBox = document.getElementById('login-error');
      errBox.textContent = '';
      btn.disabled = true; btn.textContent = '登入中…';
      try {
        const { error } = await API.sb.auth.signInWithPassword({ email, password });
        if (error) {
          errBox.textContent = /Invalid login/i.test(error.message)
            ? '信箱或密碼錯誤'
            : /rate|too many/i.test(error.message)
              ? '嘗試次數過多，請稍後再試'
              : /confirm/i.test(error.message)
                ? '帳號尚未啟用，請聯絡專案經理'
                : error.message;
          return;
        }
        API.sb.rpc('touch_last_login').then(() => {}, () => {});
        await App.start();
      } catch (err) {
        errBox.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = '登入';
      }
    };
  }

  // ---------- 首次登入：強制變更密碼 ----------
  function renderChangePassword({ forced = true } = {}) {
    const html = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2>${forced ? '首次登入，請設定新密碼' : '變更密碼'}</h2>
          <p class="muted">登入帳號：${U.esc(profile.email)}（${U.esc(profile.name)}）</p>
          <ul class="pw-rules">
            <li>至少 ${cfg.MIN_PASSWORD} 個字元</li>
            <li>需同時包含英文字母與數字</li>
            <li>不可與員工ID相同</li>
          </ul>
          <form id="pw-form">
            <label>新密碼
              <div class="pw-field">
                <input type="password" name="pw1" required autocomplete="new-password">
                <button type="button" class="pw-toggle">顯示</button>
              </div>
            </label>
            <label>再輸入一次
              <input type="password" name="pw2" required autocomplete="new-password">
            </label>
            <div class="form-error" id="pw-error"></div>
            <button class="btn primary block" type="submit">儲存新密碼</button>
            <button class="btn ghost block" type="button" id="pw-cancel">${forced ? '登出' : '取消'}</button>
          </form>
        </div>
      </div>`;

    if (forced) {
      document.getElementById('app').innerHTML = html;
    } else {
      U.openModal({ title: '變更密碼', body: html });
    }
    const scope = forced ? document : document.getElementById('modal-root');
    bindPwToggle(scope);

    scope.querySelector('#pw-cancel').onclick = () => (forced ? logout() : U.closeModal());
    const form = scope.querySelector('#pw-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { pw1, pw2 } = U.formData(form);
      const err = scope.querySelector('#pw-error');
      err.textContent = '';
      if (pw1.length < cfg.MIN_PASSWORD) return (err.textContent = `密碼至少 ${cfg.MIN_PASSWORD} 個字元`);
      if (!/[A-Za-z]/.test(pw1) || !/\d/.test(pw1)) return (err.textContent = '需同時包含英文字母與數字');
      if (pw1.toLowerCase() === String(profile.member_id).toLowerCase()) return (err.textContent = '不可與員工ID相同');
      if (pw1 !== pw2) return (err.textContent = '兩次輸入的密碼不一致');

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        const { error } = await API.sb.auth.updateUser({ password: pw1 });
        if (error) {
          err.textContent = /same|different/i.test(error.message)
            ? '新密碼不可與舊密碼相同'
            : /weak|pwned|leaked/i.test(error.message)
              ? '這組密碼太常見，請換一組'
              : error.message;
          return;
        }
        await API.sb.rpc('mark_password_changed');
        U.toast('密碼已更新', 'ok');
        if (forced) await App.start(); else U.closeModal();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        btn.disabled = false; btn.textContent = '儲存新密碼';
      }
    };
  }

  // ---------- 帳號未授權 ----------
  function renderUnauthorized(email) {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2>帳號尚未授權</h2>
          <p>你的帳號（${U.esc(email || '')}）已登入，但尚未對應到組員資料，或授權已被停用。</p>
          <p class="muted">請聯絡專案經理，確認「組員資訊」中的電子郵件與登入信箱一致。</p>
          <button class="btn primary block" id="btn-out">登出</button>
        </div>
      </div>`;
    document.getElementById('btn-out').onclick = logout;
  }

  // ---------- 尚未設定 Supabase ----------
  function renderNotConfigured() {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h2>尚未設定 Supabase 連線</h2>
          <p>請編輯 <code>docs/js/config.js</code>，填入：</p>
          <ul class="pw-rules">
            <li><b>SUPABASE_URL</b>：Project Settings → API Keys 的 Project URL</li>
            <li><b>SUPABASE_ANON_KEY</b>：anon（或 Publishable）key</li>
          </ul>
          <p class="muted">⚠️ 不可填入 service_role / Secret key。</p>
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
    renderLogin, renderChangePassword, renderUnauthorized, renderNotConfigured
  };
})();
