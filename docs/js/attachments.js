/**
 * 附件：上傳到 Supabase Storage 私有 bucket「attachments」，索引存在 attachments 資料表
 * 路徑：{org_id}/{業務類型編碼}/{業務ID}/{uuid}.{副檔名}（第一層一定是公司ID，RLS 靠它隔離公司）
 * 權限（資料庫與 Storage 政策都會把關）：專案經理、組長可上傳與下載；只有專案經理可刪除。
 *
 * 用法：Attachments.mount(容器元素, { businessType: '支出', businessId: 'EXP-001' })
 */
const Attachments = (() => {
  const BUCKET = 'attachments';
  const MAX_BYTES = 10 * 1024 * 1024;
  // 允許的副檔名 → MIME（須與 migration 中 bucket 的 allowed_mime_types 一致）
  const TYPES = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    csv: 'text/csv', txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  // 業務類型 → 路徑用的 ASCII 資料夾名（避免中文與特殊字元進入 Storage 路徑）
  const FOLDER = { '支出': 'expense' };

  const me = () => Auth.current();
  const isPM = () => me()?.role === '專案經理';
  const isLeaderOrPM = () => ['專案經理', '組長'].includes(me()?.role);
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  function validate(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!TYPES[ext]) return `不支援 .${ext || '?'} 格式（可用：${Object.keys(TYPES).join('、')}）`;
    if (file.size <= 0) return '檔案是空的';
    if (file.size > MAX_BYTES) return `檔案超過 ${size(MAX_BYTES)}（目前 ${size(file.size)}）`;
    return null;
  }

  async function list(businessType, businessId) {
    const r = await API.sb.from('attachments').select('*')
      .eq('business_type', businessType).eq('business_id', businessId).eq('is_deleted', false)
      .order('uploaded_at', { ascending: false });
    return API.check(r, '讀取附件');
  }

  async function upload(file, businessType, businessId) {
    const err = validate(file);
    if (err) throw new Error(err);
    const folder = FOLDER[businessType];
    const orgId = me()?.org_id;
    if (!folder || !orgId) throw new Error('無法判斷附件位置，請重新登入後再試');

    const ext = file.name.split('.').pop().toLowerCase();
    // businessId 只允許資料庫編號格式，避免路徑被插入 ../ 之類的字元
    if (!/^[A-Za-z0-9._-]{1,50}$/.test(businessId)) throw new Error('業務編號格式不正確');
    const path = `${orgId}/${folder}/${businessId}/${uuid()}.${ext}`;

    const up = await API.sb.storage.from(BUCKET).upload(path, file, { contentType: TYPES[ext], upsert: false });
    if (up.error) throw new Error('上傳失敗：' + API.translateError(up.error));
    try {
      return await API.insert('attachments', {
        business_type: businessType, business_id: businessId, drive_file_id: path,
        file_name: file.name.slice(0, 200), mime_type: TYPES[ext], file_size: file.size,
        uploader_id: me().member_id, access_status: '有效'
      }, '登記附件');
    } catch (e) {
      // 索引寫入失敗時，把剛上傳的檔案移除，避免留下沒人管的孤兒檔案
      await API.sb.storage.from(BUCKET).remove([path]).catch(() => {});
      throw e;
    }
  }

  async function download(row) {
    // 短效連結（60 秒）；檔案不公開，必須有權限才拿得到
    const { data, error } = await API.sb.storage.from(BUCKET).createSignedUrl(row.drive_file_id, 60, { download: row.file_name });
    if (error || !data?.signedUrl) throw new Error('取得下載連結失敗：' + API.translateError(error || { message: '無資料' }));
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function mount(box, { businessType, businessId }) {
    if (!box) return;
    const canUpload = isLeaderOrPM();
    const canDelete = isPM();

    async function draw() {
      let rows = [];
      try { rows = await list(businessType, businessId); } catch (e) { box.innerHTML = `<p class="bad-text small">${U.esc(e.message)}</p>`; return; }
      box.innerHTML = `
        <div class="card-head"><h4>附件（憑證）</h4>
          ${canUpload ? `<label class="btn small outline" style="cursor:pointer">＋ 上傳檔案
            <input type="file" id="att-file" hidden accept="${Object.keys(TYPES).map((x) => '.' + x).join(',')}"></label>` : ''}</div>
        <div class="muted small">單檔 10 MB 以內；可用格式：${Object.keys(TYPES).join('、')}</div>
        <ul class="small" style="list-style:none;padding:0;margin:8px 0">
          ${rows.map((r) => `<li data-id="${U.esc(r.attachment_id)}" style="display:flex;gap:8px;align-items:center;padding:4px 0">
            <button type="button" class="btn small ghost" data-dl>⤓ ${U.esc(r.file_name)}</button>
            <span class="muted">${U.esc(size(U.num(r.file_size)))}・${U.esc(API.memberName(r.uploader_id))}・${U.date(r.uploaded_at)}</span>
            ${canDelete ? '<button type="button" class="btn small danger ghost" data-del>刪除</button>' : ''}</li>`).join('')
            || '<li class="muted">尚無附件</li>'}
        </ul>
        <div class="form-error" id="att-error" role="alert"></div>`;

      const fail = (e) => { box.querySelector('#att-error').textContent = e.message; };
      const input = box.querySelector('#att-file');
      if (input) input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        input.disabled = true;
        try { await upload(f, businessType, businessId); U.toast('附件已上傳', 'ok'); await draw(); }
        catch (e) { fail(e); input.disabled = false; input.value = ''; }
      };
      box.querySelectorAll('li[data-id]').forEach((li) => {
        const row = rows.find((r) => r.attachment_id === li.dataset.id);
        li.querySelector('[data-dl]').onclick = () => download(row).catch(fail);
        const del = li.querySelector('[data-del]');
        if (del) del.onclick = async () => {
          if (!(await U.confirmBox(`確定刪除附件「${row.file_name}」？檔案會一併移除，無法復原。`, '刪除'))) return;
          try {
            const rm = await API.sb.storage.from(BUCKET).remove([row.drive_file_id]);
            if (rm.error) throw new Error('移除檔案失敗：' + API.translateError(rm.error));
            await API.updateWithVersion('attachments', 'attachment_id', row.attachment_id, row.version, { is_deleted: true });
            U.toast('附件已刪除', 'ok'); await draw();
          } catch (e) { fail(e); }
        };
      });
    }
    await draw();
  }

  return { mount, validate };
})();
