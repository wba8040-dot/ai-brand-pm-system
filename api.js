/**
 * 資料存取層：所有 Supabase 呼叫都集中在這裡
 * 取代原本 Apps Script 的 google.script.run
 */
const API = (() => {
  const cfg = window.APP_CONFIG;
  const configured = !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);

  const sb = configured
    ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      })
    : null;

  // 統一錯誤處理
  function check({ data, error }, action = '讀取資料') {
    if (error) {
      console.error(action, error);
      const msg = translateError(error);
      throw new Error(`${action}失敗：${msg}`);
    }
    return data;
  }

  function translateError(err) {
    const m = err.message || String(err);
    if (/row-level security/i.test(m) || err.code === '42501') return '沒有權限執行此操作';
    if (/duplicate key/i.test(m)) return '編號重複，請換一個 ID';
    if (/foreign key/i.test(m)) return '關聯的資料不存在（請檢查負責人、活動或任務 ID）';
    if (/JWT|token/i.test(m)) return '登入已過期，請重新登入';
    if (/Failed to fetch|NetworkError/i.test(m)) return '網路連線失敗';
    return m;
  }

  // ---------- 共用資料快取（組員、活動、選單、設定） ----------
  const cache = { members: null, campaigns: null, options: null, settings: null };

  async function loadLookups(force = false) {
    if (!force && cache.members) return cache;
    const [members, campaigns, options, settings] = await Promise.all([
      sb.from('members').select('member_id,name,project_role,department,email,status,leader_id,line_user_id')
        .eq('is_deleted', false).order('member_id'),
      sb.from('campaigns').select('campaign_id,name,status').eq('is_deleted', false).order('campaign_id'),
      sb.from('option_lists').select('category,value,sort_order').eq('is_active', true).order('sort_order'),
      sb.from('system_settings').select('key,value')
    ]);
    cache.members = check(members, '讀取組員');
    cache.campaigns = check(campaigns, '讀取活動');
    cache.options = {};
    check(options, '讀取選單').forEach((o) => {
      (cache.options[o.category] = cache.options[o.category] || []).push(o.value);
    });
    cache.settings = {};
    check(settings, '讀取設定').forEach((s) => { cache.settings[s.key] = s.value; });
    return cache;
  }

  function memberName(id) {
    const m = (cache.members || []).find((x) => x.member_id === id);
    return m ? m.name : (id || '—');
  }

  function campaignName(id) {
    const c = (cache.campaigns || []).find((x) => x.campaign_id === id);
    return c ? c.name : (id || '—');
  }

  function opts(category, fallback = []) {
    return (cache.options && cache.options[category]) || fallback;
  }

  // ---------- 帶版本檢查的更新（樂觀鎖） ----------
  // 回傳更新後的資料；若版本不符或沒有權限，丟出錯誤
  async function updateWithVersion(table, pkCol, pkVal, version, patch) {
    const res = await sb.from(table).update(patch)
      .eq(pkCol, pkVal).eq('version', version)
      .select();
    const rows = check(res, '儲存');
    if (!rows || rows.length === 0) {
      throw new Error('儲存失敗：資料已被其他人更新，或你沒有權限修改這筆資料。請重新整理後再試。');
    }
    return rows[0];
  }

  // ---------- 各頁面查詢 ----------
  const q = {
    projectOverview: () => sb.from('v_project_overview').select('*').limit(1).maybeSingle(),
    tasks: () => sb.from('tasks').select('*').eq('is_deleted', false).order('planned_end', { ascending: true, nullsFirst: false }),
    task: (id) => sb.from('tasks').select('*').eq('task_id', id).single(),
    progressOf: (id) => sb.from('progress_updates').select('*').eq('task_id', id).order('updated_time', { ascending: false }).limit(10),
    subtasksOf: (id) => sb.from('subtasks').select('*').eq('parent_task_id', id).eq('is_deleted', false).order('due_date'),
    alerts: () => sb.from('ai_alerts').select('*').eq('is_deleted', false).order('alert_time', { ascending: false }),
    risks: () => sb.from('risks').select('*').eq('is_deleted', false).order('risk_score', { ascending: false }),
    issues: () => sb.from('v_issues').select('*').order('due_date', { ascending: true, nullsFirst: false }),
    campaignSummary: () => sb.from('v_campaign_summary').select('*').order('planned_start'),
    metrics: () => sb.from('metrics').select('campaign_id,data_date,impressions,clicks,conversions,revenue,ad_spend')
      .eq('is_deleted', false).order('data_date'),
    workload: () => sb.from('v_member_workload').select('*').order('member_id'),
    dataQuality: () => sb.from('v_data_quality').select('*')
  };

  return {
    sb, configured, check, translateError, cache, loadLookups,
    memberName, campaignName, opts, updateWithVersion, q
  };
})();
