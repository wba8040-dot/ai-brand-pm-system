/**
 * 主程式：啟動流程、版面、路由、自動重新整理
 */
const App = (() => {
  const cfg = window.APP_CONFIG;

  // roles 留空 = 所有角色可見；group 用來分隔選單
  const ROUTES = [
    { key: 'dashboard', label: '專案儀表板',   icon: '◧' },
    { key: 'tasks',     label: '任務管理',     icon: '☑' },
    { key: 'alerts',    label: 'AI 預警',      icon: '⚠' },
    { key: 'risks',     label: '風險與問題',   icon: '◆' },
    { key: 'campaigns', label: '行銷活動成效', icon: '▲' },
    { key: 'members',   label: '組員負荷',     icon: '◎', roles: ['專案經理', '組長'] },
    { key: 'projects',  label: '專案與活動設定', icon: '▤', roles: ['專案經理', '組長'], group: '管理' },
    { key: 'accounts',  label: '成員與帳號',   icon: '☺', roles: ['專案經理'], group: '管理' },
    { key: 'settings',  label: '公司設定',     icon: '⚙', roles: ['專案經理'], group: '管理' }
  ];

  let timer = null;
  let started = false;

  const allowedRoutes = () => {
    const role = Auth.current()?.role;
    return ROUTES.filter((r) => !r.roles || r.roles.includes(role));
  };

  function currentRoute() {
    const key = (location.hash || '').replace(/^#\/?/, '') || 'dashboard';
    return allowedRoutes().find((r) => r.key === key) || allowedRoutes()[0];
  }

  // ---------- 啟動 ----------
  async function start() {
    if (!API.configured) return Auth.renderNotConfigured();

    const session = await Auth.getSession();
    if (!session) return Auth.renderLogin();

    let profile;
    try {
      profile = await Auth.loadProfile();
    } catch (e) {
      return Auth.renderLogin(e.message);
    }
    if (!profile) return Auth.renderOnboarding(session.user.email);
    if (profile.auth_status !== '已授權') {
      return Auth.renderBlocked('帳號已停用', `你在「${profile.org_name}」的帳號已被停用，請聯絡公司的專案經理。`);
    }

    applyBrand(profile);
    try {
      await API.loadLookups(true);
    } catch (e) {
      U.toast(e.message, 'bad', 6000);
    }

    renderShell();
    await renderPage();
    if (profile.must_change_password) Auth.renderChangePassword({ forced: true });

    if (!started) {
      started = true;
      window.addEventListener('hashchange', () => renderPage());
      API.sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') Auth.renderLogin('你已登出');
      });
    }
    startAutoRefresh();
  }

  function applyBrand(p) {
    const color = /^#[0-9a-f]{6}$/i.test(p.primary_color || '') ? p.primary_color : '#4f46e5';
    document.documentElement.style.setProperty('--primary', color);
    document.documentElement.style.setProperty('--primary-soft', color + '1a');
    document.title = `${p.org_name}｜${cfg.APP_SHORT}`;
  }

  // ---------- 版面 ----------
  function renderShell() {
    const p = Auth.current();
    const color = U.ROLE_COLOR[p.role] || '#475569';
    const initial = (p.name || '?').slice(-2);
    const logo = p.logo_url && /^https:\/\//.test(p.logo_url)
      ? `<img src="${U.esc(p.logo_url)}" alt="" class="org-logo">`
      : `<div class="org-logo text">${U.esc((p.org_name || '?').slice(0, 1))}</div>`;

    document.getElementById('app').innerHTML = `
      <div class="layout">
        <aside class="sidebar" id="sidebar">
          <div class="org-brand">${logo}<div class="org-name" title="${U.esc(p.org_name)}">${U.esc(p.org_name)}</div></div>
          <div class="user-card" style="--role:${color}">
            <div class="user-top">
              <div class="avatar">${U.esc(initial)}</div>
              <div class="user-meta">
                <div class="user-name">${U.esc(p.name)}</div>
                <span class="role-badge">${U.esc(p.role)}</span>
              </div>
            </div>
            <div class="user-email" title="${U.esc(p.email)}">${U.esc(p.email)}</div>
            <div class="user-sub">${U.esc(p.member_id)}${p.department ? '｜' + U.esc(p.department) : ''}
              ${p.line_bound ? '<span class="line-tag">LINE 已綁定</span>' : ''}</div>
            ${p.is_test_account ? `<div class="test-switch"><span>🧪 測試身分</span>
              <select id="test-role">${U.options(['專案經理', '組長', '組員'], p.role)}</select></div>` : ''}
            <div class="user-actions">
              <button class="btn small ghost" id="btn-pw">變更密碼</button>
              <button class="btn small outline" id="btn-logout">登出／切換帳號</button>
            </div>
          </div>
          <nav class="nav" id="nav"></nav>
          <div class="sidebar-foot">${U.esc(cfg.APP_SHORT)}</div>
        </aside>
        <div class="sidebar-mask" id="sidebar-mask"></div>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn menu-btn" id="btn-menu" aria-label="選單">☰</button>
            <h2 id="page-title"></h2>
            <div class="topbar-right">
              <select id="project-switch" class="project-switch" title="切換專案"></select>
              <span class="muted small" id="last-updated"></span>
              <button class="btn small ghost" id="btn-refresh">↻ 重新整理</button>
            </div>
          </header>
          <section id="page" class="page"></section>
        </main>
      </div>`;

    let lastGroup = null;
    document.getElementById('nav').innerHTML = allowedRoutes().map((r) => {
      const head = r.group && r.group !== lastGroup ? `<div class="nav-group">${U.esc(r.group)}</div>` : '';
      lastGroup = r.group || lastGroup;
      return `${head}<a href="#/${r.key}" data-key="${r.key}"><span class="nav-icon">${r.icon}</span>${U.esc(r.label)}</a>`;
    }).join('');

    renderProjectSwitch();

    document.getElementById('btn-logout').onclick = async () => {
      if (await U.confirmBox('確定要登出嗎？登出後可以用其他帳號登入。', '登出')) Auth.logout();
    };
    document.getElementById('btn-pw').onclick = () => Auth.renderChangePassword();
    document.getElementById('btn-refresh').onclick = () => renderPage(true);

    // 測試帳號：切換角色後重新載入，用真正的權限測試各層級畫面
    const tr = document.getElementById('test-role');
    if (tr) tr.onchange = async () => {
      tr.disabled = true;
      try {
        API.check(await API.sb.rpc('set_my_test_role', { p_role: tr.value }), '切換角色');
        U.toast(`已切換為「${tr.value}」`, 'ok');
        history.replaceState(null, '', location.pathname + '#/dashboard');
        await start();
      } catch (e) {
        U.toast(e.message, 'bad', 6000);
        tr.disabled = false;
      }
    };

    const sidebar = document.getElementById('sidebar');
    const mask = document.getElementById('sidebar-mask');
    document.getElementById('btn-menu').onclick = () => { sidebar.classList.add('open'); mask.classList.add('show'); };
    mask.onclick = () => { sidebar.classList.remove('open'); mask.classList.remove('show'); };
  }

  function renderProjectSwitch() {
    const sel = document.getElementById('project-switch');
    if (!sel) return;
    const list = API.cache.projects || [];
    sel.style.display = list.length > 1 ? '' : 'none';
    sel.innerHTML = list.map((p) => `<option value="${U.esc(p.project_id)}">${U.esc(p.name)}</option>`).join('');
    sel.value = API.currentProjectId() || '';
    sel.onchange = () => { API.setProject(sel.value); renderPage(); };
  }

  // ---------- 換頁 ----------
  let rendering = false;

  async function renderPage(reloadLookups = false) {
    const page = document.getElementById('page');
    if (!page || rendering) return;
    rendering = true;

    const route = currentRoute();
    document.getElementById('page-title').textContent = route.label;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === route.key));
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-mask').classList.remove('show');

    if (page.dataset.route !== route.key) {
      page.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    }
    page.dataset.route = route.key;

    try {
      if (reloadLookups) { await API.loadLookups(true); renderProjectSwitch(); }
      U.destroyCharts();
      await Pages[route.key](page);
      document.getElementById('last-updated').textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
    } catch (e) {
      console.error(e);
      page.innerHTML = `<div class="empty error">⚠ ${U.esc(e.message)}</div>`;
      if (/登入已過期/.test(e.message)) setTimeout(() => Auth.logout(), 1500);
    } finally {
      rendering = false;
    }
  }

  // 新增或修改主檔後呼叫：重新載入快取並重畫
  async function refreshAll() {
    await API.loadLookups(true);
    renderProjectSwitch();
    await renderPage();
  }

  function startAutoRefresh() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !U.isModalOpen() && document.getElementById('page')) {
        renderPage();
      }
    }, cfg.REFRESH_SECONDS * 1000);
  }

  return { start, renderPage, refreshAll, applyBrand };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.start().catch((e) => {
    console.error(e);
    document.getElementById('app').innerHTML = `<div class="empty error">系統啟動失敗：${U.esc(e.message)}</div>`;
  });
});
