/**
 * 主程式：啟動流程、版面、路由、自動重新整理
 */
const App = (() => {
  const cfg = window.APP_CONFIG;

  // 線條圖示（SVG，不依賴外部圖示庫；aria-hidden，文字標籤才是可讀名稱）
  const ICON = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    risk: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M12 9v4"/><path d="M12 16h.01"/>',
    campaign: '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/>',
    team: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c2.8 0 5 2.2 5 5"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    users: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/><path d="M7 14h4M7 17h7"/>',
    profile: '<circle cx="12" cy="9" r="3.5"/><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M6.5 19c1-3 3-4.5 5.5-4.5s4.5 1.5 5.5 4.5"/>'
  };
  const icon = (k) => `<svg class="nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[k]}</svg>`;

  // roles 留空 = 所有角色可見；選單分成「工作／行銷／管理」三組
  const ROUTES = [
    { key: 'dashboard', label: '首頁',         icon: 'home',     group: '工作' },
    { key: 'tasks',     label: '任務',         icon: 'tasks',    group: '工作' },
    { key: 'schedule',  label: '活動日程',     icon: 'calendar', group: '工作' },
    { key: 'alerts',    label: 'AI 預警',      icon: 'alert',    group: '工作' },
    { key: 'risks',     label: '風險與問題',   icon: 'risk',     group: '工作' },
    { key: 'members',   label: '組員負荷',     icon: 'team',     group: '工作', roles: ['專案經理', '組長'] },
    { key: 'campaigns', label: '行銷活動',     icon: 'campaign', group: '行銷' },
    { key: 'projects',  label: '專案管理',     icon: 'folder',   group: '管理', roles: ['專案經理', '組長'] },
    { key: 'accounts',  label: '成員與帳號',   icon: 'users',    group: '管理', roles: ['專案經理'] },
    { key: 'settings',  label: '公司設定',     icon: 'gear',     group: '管理', roles: ['專案經理'] },
    { key: 'profile',   label: '個人資料',     icon: 'profile',  group: '個人' }
  ];

  // 獨立模組的頁面（其餘頁面在 pages.js）
  const PAGE_MODULES = {
    schedule: (el) => Schedule.render(el),
    profile: (el) => Profile.render(el)
  };

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

    let session;
    try {
      session = await Auth.getSession();
    } catch (e) {
      return renderFatal('無法連線到伺服器，請檢查網路後重新整理。');
    }
    if (!session) return Auth.renderLogin();
    // 從「重設密碼信」的連結進來：先設定新密碼，再進系統
    if (Auth.consumeRecovery()) return Auth.renderResetPassword(session.user.email);

    let profile;
    try {
      profile = await Auth.loadProfile();
    } catch (e) {
      return Auth.renderLogin(e.message);
    }
    if (!profile) {
      // 用專案邀請碼申請後，等待專案經理核准
      const req = await Auth.loadJoinRequest();
      if (req) return Auth.renderJoinStatus(req, session.user.email);
      return Auth.renderOnboarding(session.user.email);
    }
    Auth.stopJoinPoll();
    if (profile.auth_status !== '已授權') {
      return Auth.renderBlocked('帳號已停用', `你在「${profile.org_name}」的帳號已被停用，請聯絡公司的專案經理。`);
    }

    applyBrand(profile);
    U.pruneDrafts();
    UX.touch();
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
      window.addEventListener('hashchange', () => renderPage(false, { focusTitle: true }));
      API.sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') Auth.renderLogin('你已登出');
      });
    }
    startAutoRefresh();
  }

  function renderFatal(msg) {
    document.getElementById('app').innerHTML = `
      <div class="auth-wrap"><div class="auth-card" role="alert">
        <h1 class="h-section">發生錯誤</h1><p>${U.esc(msg)}</p>
        <button class="btn primary block" onclick="location.reload()">重新整理</button>
      </div></div>`;
  }

  function applyBrand(p) {
    const color = /^#[0-9a-f]{6}$/i.test(p.primary_color || '') ? p.primary_color : '#4f46e5';
    document.documentElement.style.setProperty('--primary', color);
    document.documentElement.style.setProperty('--primary-soft', color + '1a');
    document.title = `${p.org_name}｜${cfg.APP_SHORT}`;
  }

  // ---------- 版面 ----------
  // 專案經理：側邊選單「成員與帳號」顯示待審核的加入申請數
  async function updateJoinBadge() {
    const link = document.querySelector('#nav a[data-key="accounts"]');
    if (!link) return;
    const { data, error } = await API.sb.rpc('list_join_requests');
    const n = error || !data ? 0 : data.length;
    let b = link.querySelector('.nav-count');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'nav-count'; link.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.setAttribute('aria-label', `${n} 件待審核的加入申請`);
  }

  function renderShell() {
    const p = Auth.current();
    const color = U.ROLE_COLOR[p.role] || '#475569';
    const initial = (p.name || '?').slice(-2);
    const logo = p.logo_url && /^https:\/\//.test(p.logo_url)
      ? `<img src="${U.esc(p.logo_url)}" alt="" class="org-logo">`
      : `<div class="org-logo text" aria-hidden="true">${U.esc((p.org_name || '?').slice(0, 1))}</div>`;

    document.getElementById('app').innerHTML = `
      <a class="skip-link" href="#page" id="skip-link">跳到主要內容</a>
      <div class="layout">
        <aside class="sidebar" id="sidebar" aria-label="側邊選單">
          <div class="org-brand">${logo}<div class="org-name" title="${U.esc(p.org_name)}">${U.esc(p.org_name)}</div></div>
          <div class="user-card" style="--role:${color}">
            <div class="user-top">
              <div class="avatar" aria-hidden="true">${U.esc(initial)}</div>
              <div class="user-meta">
                <div class="user-name">${U.esc(p.name)}</div>
                <span class="role-badge">${U.esc(p.role)}</span>
              </div>
            </div>
            <div class="user-email" title="${U.esc(p.email)}">${U.esc(p.email)}</div>
            <div class="user-sub">${U.esc(p.member_id)}${p.department ? '｜' + U.esc(p.department) : ''}
              ${p.line_bound ? '<span class="line-tag">LINE 已綁定</span>' : ''}</div>
            ${p.is_test_account ? `<label class="test-switch"><span>🧪 測試身分</span>
              <select id="test-role" aria-label="切換測試身分">${U.options(['專案經理', '組長', '組員'], p.role)}</select></label>` : ''}
            <div class="user-actions">
              <a class="btn small ghost" href="#/profile" id="btn-profile">個人資料</a>
              <button class="btn small ghost" id="btn-pw">變更密碼</button>
              <button class="btn small outline" id="btn-logout">登出／切換帳號</button>
            </div>
          </div>
          <nav class="nav" id="nav" aria-label="主要功能"></nav>
          <div class="sidebar-foot">${U.esc(cfg.APP_SHORT)}</div>
        </aside>
        <div class="sidebar-mask" id="sidebar-mask"></div>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn menu-btn" id="btn-menu" aria-label="開啟選單" aria-controls="sidebar" aria-expanded="false">☰</button>
            <div class="title-wrap">
              <nav class="breadcrumb" id="breadcrumb" aria-label="目前位置"></nav>
              <h1 id="page-title" tabindex="-1"></h1>
            </div>
            <div class="topbar-right">
              <label class="sr-only" for="project-switch">切換專案</label>
              <select id="project-switch" class="project-switch"></select>
              <span class="muted small" id="last-updated" aria-live="polite"></span>
              <button class="btn small ghost" id="btn-refresh" aria-label="重新整理資料">↻ <span class="hide-sm">重新整理</span></button>
            </div>
          </header>
          <section id="page" class="page" tabindex="-1"></section>
        </main>
      </div>`;

    let lastGroup = null;
    document.getElementById('nav').innerHTML = allowedRoutes().map((r) => {
      const head = r.group !== lastGroup ? `<div class="nav-group" role="presentation">${U.esc(r.group)}</div>` : '';
      lastGroup = r.group;
      return `${head}<a href="#/${r.key}" data-key="${r.key}">${icon(r.icon)}<span>${U.esc(r.label)}</span></a>`;
    }).join('');

    renderProjectSwitch();
    Profile.applySidebarAvatar();
    updateJoinBadge();

    // 「跳到主要內容」：系統使用 #/ 路由，所以不能用一般錨點，改為直接移動焦點
    document.getElementById('skip-link').onclick = (e) => { e.preventDefault(); document.getElementById('page').focus(); };

    document.getElementById('btn-logout').onclick = async () => {
      if (await U.confirmBox('確定要登出嗎？登出後可以用其他帳號登入。', '登出')) Auth.logout();
    };
    document.getElementById('btn-pw').onclick = () => Auth.renderChangePassword();
    document.getElementById('btn-refresh').onclick = () => renderPage(true);

    // 測試帳號（由系統管理者在資料庫設定）：切換角色後重新載入，用真正的權限測試各層級畫面
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

    // 手機選單（抽屜）
    const sidebar = document.getElementById('sidebar');
    const mask = document.getElementById('sidebar-mask');
    const menuBtn = document.getElementById('btn-menu');
    const closeMenu = () => { sidebar.classList.remove('open'); mask.classList.remove('show'); menuBtn.setAttribute('aria-expanded', 'false'); };
    menuBtn.onclick = () => {
      sidebar.classList.add('open'); mask.classList.add('show'); menuBtn.setAttribute('aria-expanded', 'true');
      const first = sidebar.querySelector('a, button, select'); if (first) first.focus();
    };
    mask.onclick = closeMenu;
    sidebar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('open')) { closeMenu(); menuBtn.focus(); } });
  }

  function renderProjectSwitch() {
    const sel = document.getElementById('project-switch');
    if (!sel) return;
    const list = API.cache.projects || [];
    const show = list.length > 1;
    sel.style.display = show ? '' : 'none';
    sel.innerHTML = list.map((p) => `<option value="${U.esc(p.project_id)}">${U.esc(p.name)}</option>`).join('');
    sel.value = API.currentProjectId() || '';
    sel.onchange = () => { API.setProject(sel.value); renderPage(); };
  }

  // ---------- 換頁 ----------
  let rendering = false;

  async function renderPage(reloadLookups = false, { focusTitle = false } = {}) {
    const page = document.getElementById('page');
    if (!page || rendering) return;
    rendering = true;

    const route = currentRoute();
    const title = route.key === 'dashboard' ? `${Auth.current()?.role || ''}首頁` : route.label;
    const h1 = document.getElementById('page-title');
    h1.textContent = title;
    document.title = `${title}｜${cfg.APP_SHORT}`;
    const bc = document.getElementById('breadcrumb');
    if (bc) {
      const proj = ['dashboard', 'tasks', 'schedule', 'campaigns', 'alerts', 'risks', 'members'].includes(route.key)
        ? API.projectName(API.currentProjectId()) : '';
      bc.innerHTML = `<a href="#/dashboard">${U.esc(Auth.current()?.org_name || '首頁')}</a>
        <span aria-hidden="true">›</span><span>${U.esc(route.group)}</span>
        ${proj && proj !== '—' ? `<span aria-hidden="true">›</span><span class="bc-proj" title="目前專案">${U.esc(proj)}</span>` : ''}
        <span aria-hidden="true">›</span><span aria-current="page">${U.esc(title)}</span>`;
    }
    document.querySelectorAll('#nav a').forEach((a) => {
      const on = a.dataset.key === route.key;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-mask').classList.remove('show');

    if (page.dataset.route !== route.key) {
      delete document.body.dataset.unsaved;   // 換頁後不再保留上一頁的「未儲存」狀態
      page.innerHTML = UX.skeleton();
    }
    page.dataset.route = route.key;
    page.setAttribute('aria-busy', 'true');

    try {
      if (reloadLookups) { await API.loadLookups(true); renderProjectSwitch(); }
      U.destroyCharts();
      await (PAGE_MODULES[route.key] || Pages[route.key])(page);
      U.fitText(page);
      document.getElementById('last-updated').textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
      if (focusTitle) h1.focus({ preventScroll: true });
    } catch (e) {
      console.error(e);
      page.innerHTML = `<div class="empty error" role="alert">
        <p>⚠ ${U.esc(e.message)}</p>
        <button class="btn outline" id="btn-retry">重試</button>
      </div>`;
      const r = document.getElementById('btn-retry');
      if (r) r.onclick = () => renderPage(true);
      if (/登入已過期/.test(e.message)) setTimeout(() => Auth.logout(), 1500);
    } finally {
      page.removeAttribute('aria-busy');
      rendering = false;
    }
  }

  // 新增或修改主檔後呼叫：重新載入快取並重畫
  async function refreshAll() {
    await API.loadLookups(true);
    renderProjectSwitch();
    await renderPage();
  }

  // 自動重新整理：對話框開著、正在輸入、或頁面不在前景時暫停，避免打斷使用者
  function startAutoRefresh() {
    clearInterval(timer);
    timer = setInterval(() => {
      const a = document.activeElement;
      const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
      // 拖曳甘特圖中、或個人資料有未儲存修改時，也不自動重畫
      const busy = document.body.dataset.dragging || document.body.dataset.unsaved;
      if (document.visibilityState === 'visible' && !U.isModalOpen() && !typing && !busy && document.getElementById('page')) {
        renderPage();
      }
      if (document.visibilityState === 'visible') updateJoinBadge();
    }, cfg.REFRESH_SECONDS * 1000);
  }

  // 旋轉手機或調整視窗大小時，重新調整 KPI 數字大小
  let fitTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { const p = document.getElementById('page'); if (p) U.fitText(p); }, 150);
  });

  return { start, renderPage, refreshAll, applyBrand, updateJoinBadge };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.start().catch((e) => {
    console.error(e);
    document.getElementById('app').innerHTML = `<div class="empty error" role="alert">系統啟動失敗：${U.esc(e.message)}</div>`;
  });
});
