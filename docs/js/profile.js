/**
 * 個人資料：每位使用者可修改自己的
 *   - 姓名、聯絡電話
 *   - 大頭貼（瀏覽器端先裁成 256×256 JPEG 再上傳，存放於 Supabase Storage 的 avatars）
 *   - 專長、技能等級
 *   - 通知偏好（LINE 預警、Email 預警、每日摘要、到期提醒）
 *
 * 角色、直屬組長、員工編號、部門、Email 仍只能由專案經理在「成員與帳號」修改。
 *
 * 寫入一律透過資料庫函式 update_my_profile（security definer，只能改自己、只能改允許的欄位）。
 * 這個函式與 avatar_path／notify_prefs 欄位需要先套用
 *   supabase/migrations/20261120090000_profile_self_service.sql
 * 尚未套用時，頁面只能檢視，並顯示「待啟用」說明，不會出錯。
 */
const Profile = (() => {
  const me = () => Auth.current();
  const AVATAR_BUCKET = 'avatars';
  const AVATAR_SIZE = 256;
  const MAX_UPLOAD_MB = 8;
  const NOTIFY = [
    { key: 'line_alert',    label: 'LINE 預警通知',        hint: '有指派給你的 AI 預警時，透過 LINE 通知（需先綁定 LINE）' },
    { key: 'email_alert',   label: 'Email 預警通知',       hint: '有指派給你的 AI 預警時，寄送 Email' },
    { key: 'daily_summary', label: '每日 21:00 摘要',      hint: '每天晚上收到一則當日預警與進度摘要' },
    { key: 'due_reminder',  label: '任務到期前一天提醒',   hint: '你負責的任務在截止前一天提醒' }
  ];
  const DEFAULT_PREFS = { line_alert: true, email_alert: false, daily_summary: true, due_reminder: true };

  let pendingAvatar = null;   // { blob, url } 尚未上傳的新頭像
  let removeAvatar = false;

  /** 讀取自己的成員資料（用 select('*')，資料庫尚未加新欄位時也不會出錯） */
  async function loadMine() {
    const rows = API.check(
      await API.sb.from('members').select('*').eq('member_id', me().member_id).eq('is_deleted', false),
      '讀取個人資料');
    return rows[0] || null;
  }

  const avatarUrl = (path) => (path ? API.sb.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl : null);
  const initials = (name) => String(name || '?').slice(-2);

  async function render(el) {
    pendingAvatar = null;
    removeAvatar = false;
    const p = me();
    const m = await loadMine();
    if (!m) {
      el.innerHTML = '<div class="empty card error" role="alert">找不到你的成員資料，請聯絡專案經理。</div>';
      return;
    }
    // 判斷資料庫是否已套用「個人資料自助修改」：新欄位存在才算啟用
    const ready = Object.prototype.hasOwnProperty.call(m, 'notify_prefs');
    const prefs = { ...DEFAULT_PREFS, ...(m.notify_prefs || {}) };
    const levels = API.opts('技能等級', ['初階', '中階', '高階', '專家']);
    const leader = m.leader_id ? API.memberName(m.leader_id) : '—';
    const url = avatarUrl(m.avatar_path);
    const roleColor = U.ROLE_COLOR[p.role] || '#475569';
    const dis = ready ? '' : 'disabled';

    el.innerHTML = `
      ${ready ? '' : `<div class="notice warn" role="status">
        <b>個人資料修改「待啟用」</b>：資料庫還沒套用個人資料自助修改功能，目前只能檢視。
        專案經理（或系統管理者）在 Supabase 執行 <code>20261120090000_profile_self_service.sql</code> 後即可儲存。</div>`}

      <div class="profile-layout">
        <section class="card profile-hero" style="--role:${roleColor}" aria-labelledby="pf-name-h">
          <div class="pf-avatar-wrap">
            <div class="pf-avatar" id="pf-avatar">${url ? `<img src="${U.esc(url)}" alt="${U.esc(m.name)} 的大頭貼">` : `<span aria-hidden="true">${U.esc(initials(m.name))}</span>`}</div>
            <div class="pf-avatar-actions">
              <label class="btn small outline ${ready ? '' : 'is-disabled'}">更換照片
                <input type="file" id="pf-file" accept="image/jpeg,image/png,image/webp" class="sr-only" ${dis}></label>
              <button type="button" class="btn small ghost" id="pf-remove" ${ready && (m.avatar_path) ? '' : 'hidden'}>移除</button>
            </div>
            <p class="muted small">JPG／PNG／WebP，${MAX_UPLOAD_MB} MB 以內；會自動裁成正方形。</p>
          </div>
          <div class="pf-id">
            <h2 id="pf-name-h" class="pf-name">${U.esc(m.name)}</h2>
            <span class="role-badge">${U.esc(p.role)}</span>
            <dl class="kv compact">
              <dt>員工編號</dt><dd class="mono">${U.esc(m.member_id)}</dd>
              <dt>登入 Email</dt><dd>${U.esc(p.email || m.email || '—')}</dd>
              <dt>公司</dt><dd>${U.esc(p.org_name)}</dd>
              <dt>部門</dt><dd>${U.esc(m.department || '—')}</dd>
              <dt>直屬組長</dt><dd>${U.esc(leader)}</dd>
              <dt>加入日期</dt><dd>${U.date(m.join_date)}</dd>
              <dt>LINE</dt><dd>${m.line_user_id ? '<span class="chip ok">已綁定</span>' : '<span class="chip muted">未綁定</span>'}</dd>
            </dl>
            <p class="muted small">角色、部門、直屬組長、員工編號與 Email 由專案經理在「成員與帳號」管理。</p>
            <button type="button" class="btn small ghost" id="pf-pw">變更密碼</button>
          </div>
        </section>

        <form id="pf-form" class="profile-forms" novalidate>
          <section class="card" aria-labelledby="pf-basic-h">
            <h3 id="pf-basic-h" class="h-section">基本資料</h3>
            <div class="form-grid">
              <label>姓名 <span class="req" aria-hidden="true">*</span>
                <input name="name" required maxlength="40" autocomplete="name" value="${U.esc(m.name || '')}" ${dis}></label>
              <label>聯絡電話
                <input name="contact" type="tel" maxlength="30" autocomplete="tel" inputmode="tel" placeholder="例如 0912-345-678"
                  value="${U.esc(m.contact || '')}" ${dis}></label>
            </div>
          </section>

          <section class="card" aria-labelledby="pf-skill-h">
            <h3 id="pf-skill-h" class="h-section">專長與技能</h3>
            <div class="form-grid">
              <label class="span-2">專長（以逗號分隔）
                <input name="skills" maxlength="300" placeholder="例如：社群廣告投放, 文案, Figma" value="${U.esc(m.skills || '')}" ${dis}></label>
              <label>技能等級
                <select name="skill_level" ${dis}>${U.options(levels, m.skill_level || '', { blank: true })}</select></label>
            </div>
            <div class="skill-tags" id="pf-tags" aria-hidden="true"></div>
          </section>

          <section class="card" aria-labelledby="pf-notify-h">
            <h3 id="pf-notify-h" class="h-section">通知偏好</h3>
            <fieldset class="notify-list">
              <legend class="sr-only">選擇要接收的通知</legend>
              ${NOTIFY.map((n) => `<label class="switch-row">
                <input type="checkbox" role="switch" name="n_${n.key}" ${prefs[n.key] ? 'checked' : ''} ${dis}>
                <span class="switch" aria-hidden="true"></span>
                <span><b>${n.label}</b><span class="muted small">${n.hint}</span></span></label>`).join('')}
            </fieldset>
            ${m.line_user_id ? '' : '<p class="muted small">尚未綁定 LINE，LINE 通知暫時不會送達。</p>'}
            <p class="muted small">通知偏好會儲存下來，實際寄送要等 LINE 推播與 Email 功能上線後才會生效。</p>
          </section>

          <div class="form-error" id="pf-error" role="alert"></div>
          <div class="save-bar">
            <span class="muted small" id="pf-dirty" aria-live="polite"></span>
            <button type="button" class="btn ghost" id="pf-reset" ${dis}>還原</button>
            <button type="submit" class="btn primary" id="pf-save" disabled>儲存變更</button>
          </div>
        </form>
      </div>`;

    bind(el, m, ready);
    AIActions.mountLineBind(el);
  }

  function bind(el, m, ready) {
    const form = el.querySelector('#pf-form');
    // 注意：form.name 是表單本身的 name 屬性，欄位一律用 namedItem 取得
    const F = (n) => form.elements.namedItem(n);
    const saveBtn = el.querySelector('#pf-save');
    const dirtyTxt = el.querySelector('#pf-dirty');
    const tags = el.querySelector('#pf-tags');
    const snapshot = () => JSON.stringify([...form.elements].map((x) => (x.type === 'checkbox' ? x.checked : x.value)));
    let initial = snapshot();

    const drawTags = () => {
      const list = String(F('skills').value || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
      tags.innerHTML = list.map((s) => `<span class="tag">${U.esc(s)}</span>`).join('');
    };
    const refreshDirty = () => {
      const dirty = snapshot() !== initial || !!pendingAvatar || removeAvatar;
      saveBtn.disabled = !ready || !dirty;
      dirtyTxt.textContent = dirty ? '有尚未儲存的修改' : '';
      // 有未儲存修改時，自動重新整理不能覆蓋使用者的輸入
      if (dirty) document.body.dataset.unsaved = '1'; else delete document.body.dataset.unsaved;
    };
    form.addEventListener('input', () => { drawTags(); refreshDirty(); });
    form.addEventListener('change', refreshDirty);
    drawTags();

    el.querySelector('#pf-pw').onclick = () => Auth.renderChangePassword();
    el.querySelector('#pf-reset').onclick = () => App.renderPage();

    const file = el.querySelector('#pf-file');
    if (file) file.onchange = async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      const err = el.querySelector('#pf-error');
      err.textContent = '';
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { err.textContent = '只接受 JPG、PNG 或 WebP 圖片'; return; }
      if (f.size > MAX_UPLOAD_MB * 1024 * 1024) { err.textContent = `圖片太大，請小於 ${MAX_UPLOAD_MB} MB`; return; }
      try {
        const blob = await squareJpeg(f, AVATAR_SIZE);
        if (pendingAvatar) URL.revokeObjectURL(pendingAvatar.url);
        pendingAvatar = { blob, url: URL.createObjectURL(blob) };
        removeAvatar = false;
        el.querySelector('#pf-avatar').innerHTML = `<img src="${pendingAvatar.url}" alt="新大頭貼預覽">`;
        el.querySelector('#pf-remove').hidden = false;
        refreshDirty();
      } catch (e) {
        err.textContent = '無法讀取這張圖片，請換一張試試';
      }
    };
    const rm = el.querySelector('#pf-remove');
    if (rm) rm.onclick = () => {
      if (pendingAvatar) { URL.revokeObjectURL(pendingAvatar.url); pendingAvatar = null; }
      removeAvatar = true;
      el.querySelector('#pf-avatar').innerHTML = `<span aria-hidden="true">${U.esc(initials(F('name').value || m.name))}</span>`;
      rm.hidden = true;
      refreshDirty();
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!ready) return;
      const err = el.querySelector('#pf-error');
      err.textContent = '';
      const name = F('name').value.trim();
      const contact = F('contact').value.trim();
      const skills = F('skills').value.trim();
      if (!name) { err.textContent = '請輸入姓名'; F('name').focus(); return; }
      if (name.length > 40) { err.textContent = '姓名最多 40 個字'; F('name').focus(); return; }
      if (contact && !/^[0-9+()\-#\s]{6,30}$/.test(contact)) {
        err.textContent = '聯絡電話只能包含數字、空白與 + - ( ) #，長度 6～30'; F('contact').focus(); return;
      }
      const prefs = Object.fromEntries(NOTIFY.map((n) => [n.key, F(`n_${n.key}`).checked]));

      saveBtn.disabled = true;
      saveBtn.textContent = '儲存中…';
      let uploadedPath = null;
      try {
        // 1) 先上傳新頭像（路徑：公司ID/員工編號/時間戳.jpg，Storage 規則只允許寫自己的資料夾）
        if (pendingAvatar) {
          uploadedPath = `${me().org_id}/${me().member_id}/${Date.now()}.jpg`;
          const up = await API.sb.storage.from(AVATAR_BUCKET).upload(uploadedPath, pendingAvatar.blob, {
            contentType: 'image/jpeg', upsert: false, cacheControl: '3600'
          });
          if (up.error) throw new Error('上傳大頭貼失敗：' + API.translateError(up.error));
        }
        // 2) 寫入資料：null＝不變更，''＝清除
        const { error } = await API.sb.rpc('update_my_profile', {
          p_name: name,
          p_contact: contact,
          p_skills: skills,
          p_skill_level: F('skill_level').value || '',
          p_notify_prefs: prefs,
          p_avatar_path: uploadedPath || (removeAvatar ? '' : null)
        });
        if (error) {
          if (uploadedPath) await API.sb.storage.from(AVATAR_BUCKET).remove([uploadedPath]).catch(() => {});
          throw new Error(isMissingFn(error) ? '個人資料修改功能尚未啟用（資料庫尚未套用更新）' : API.translateError(error));
        }
        // 3) 舊頭像檔案順手刪除（失敗不影響）
        if ((uploadedPath || removeAvatar) && m.avatar_path) {
          API.sb.storage.from(AVATAR_BUCKET).remove([m.avatar_path]).catch(() => {});
        }
        pendingAvatar = null;
        removeAvatar = false;
        delete document.body.dataset.unsaved;
        U.toast('個人資料已更新', 'ok');
        await Auth.loadProfile();
        await API.loadLookups(true);
        initial = snapshot();
        await App.start();       // 重畫側邊欄（姓名、頭像）與目前頁面
      } catch (e2) {
        err.textContent = e2.message;
        saveBtn.disabled = false;
      } finally {
        saveBtn.textContent = '儲存變更';
      }
    };
  }

  const isMissingFn = (error) => error && (error.code === 'PGRST202' || /Could not find the function|does not exist/i.test(error.message || ''));

  /** 讀圖並置中裁切為正方形 JPEG（縮小檔案、避免直接上傳原始大圖） */
  function squareJpeg(file, size) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        if (!s) { reject(new Error('empty')); return; }
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  /** 側邊欄頭像：有上傳就顯示照片（失敗或尚未啟用就維持文字頭像） */
  async function applySidebarAvatar() {
    try {
      const m = await loadMine();
      const url = avatarUrl(m?.avatar_path);
      const box = document.querySelector('.user-card .avatar');
      if (url && box) box.innerHTML = `<img src="${U.esc(url)}" alt="">`;
    } catch (e) { /* 不影響主畫面 */ }
  }

  return { render, applySidebarAvatar };
})();
