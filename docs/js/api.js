/**
 * 資料存取層：所有 Supabase 呼叫都集中在這裡
 * 多公司共用：資料庫的 RLS 會自動限制只讀寫「目前登入者所屬公司」的資料，
 * 新增資料時不必帶 org_id，也不必帶編號（由資料庫自動產生）。
 */
const API = (() => {
  const cfg = window.APP_CONFIG;
  const configured = !/YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY);
  const url = String(cfg.SUPABASE_URL).replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');

  const sb = configured
    ? supabase.createClient(url, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      })
    : null;

  function check({ data, error }, action = '讀取資料') {
    if (error) {
      console.error(action, error);
      throw new Error(`${action}失敗：${translateError(error)}`);
    }
    return data;
  }

  function translateError(err) {
    const m = err.message || String(err);
    if (/row-level security/i.test(m)) return '沒有權限執行此操作';
    if (err.code === '42501' && !/[一-鿿]/.test(m)) return '沒有權限執行此操作';
    if (/duplicate key/i.test(m)) return '編號或資料重複';
    if (/foreign key/i.test(m)) return '關聯的資料不存在（請檢查負責人、活動或任務）';
    if (/JWT|token/i.test(m)) return '登入已過期，請重新登入';
    if (/Failed to fetch|NetworkError/i.test(m)) return '網路連線失敗';
    return m;
  }

  // ---------- 共用資料快取 ----------
  const cache = { members: null, campaigns: null, projects: null, options: null, settings: null };

  async function loadLookups(force = false) {
    if (!force && cache.members) return cache;
    const [members, campaigns, projects, options, settings] = await Promise.all([
      sb.from('members').select('member_id,name,project_role,department,email,status,leader_id,line_user_id,weekly_hours,version')
        .eq('is_deleted', false).order('member_id'),
      sb.from('campaigns').select('campaign_id,project_id,name,status').eq('is_deleted', false).order('campaign_id'),
      sb.from('projects').select('project_id,name,status').eq('is_deleted', false).order('project_id'),
      sb.from('option_lists').select('category,value,sort_order,is_active').order('sort_order'),
      sb.from('system_settings').select('key,value,description')
    ]);
    cache.members = check(members, '讀取組員');
    cache.campaigns = check(campaigns, '讀取活動');
    cache.projects = check(projects, '讀取專案');
    cache.allOptions = check(options, '讀取選單');
    cache.options = {};
    cache.allOptions.filter((o) => o.is_active).forEach((o) => {
      (cache.options[o.category] = cache.options[o.category] || []).push(o.value);
    });
    cache.settingRows = check(settings, '讀取設定');
    cache.settings = {};
    cache.settingRows.forEach((s) => { cache.settings[s.key] = s.value; });
    return cache;
  }

  const memberName = (id) => (cache.members || []).find((x) => x.member_id === id)?.name || (id || '—');
  const campaignName = (id) => (cache.campaigns || []).find((x) => x.campaign_id === id)?.name || (id || '—');
  const projectName = (id) => (cache.projects || []).find((x) => x.project_id === id)?.name || (id || '—');
  const opts = (category, fallback = []) => (cache.options && cache.options[category]) || fallback;
  const setting = (key, fallback) => {
    const v = cache.settings?.[key];
    return v === undefined || v === null || v === '' ? fallback : v;
  };
  const roasTarget = () => Number(setting('ROAS目標', cfg.ROAS_TARGET)) || cfg.ROAS_TARGET;

  // 目前選擇的專案（存在瀏覽器）
  function currentProjectId() {
    const list = cache.projects || [];
    let id = null;
    try { id = localStorage.getItem('pm.project'); } catch (e) { /* 忽略 */ }
    if (id && list.some((p) => p.project_id === id)) return id;
    return list[0]?.project_id || null;
  }
  function setProject(id) {
    try { localStorage.setItem('pm.project', id); } catch (e) { /* 忽略 */ }
  }

  // ---------- 帶版本檢查的更新（樂觀鎖） ----------
  async function updateWithVersion(table, pkCol, pkVal, version, patch) {
    const res = await sb.from(table).update(patch).eq(pkCol, pkVal).eq('version', version).select();
    const rows = check(res, '儲存');
    if (!rows || rows.length === 0) {
      throw new Error('儲存失敗：資料已被其他人更新，或你沒有權限修改這筆資料。請重新整理後再試。');
    }
    return rows[0];
  }

  async function insert(table, row, action = '新增') {
    return check(await sb.from(table).insert(row).select(), action)[0];
  }

  // ---------- 查詢 ----------
  const q = {
    projectOverview: () => sb.from('v_project_overview').select('*').order('project_id'),
    tasks: () => sb.from('tasks').select('*').eq('is_deleted', false).order('planned_end', { ascending: true, nullsFirst: false }),
    progressOf: (id) => sb.from('progress_updates').select('*').eq('task_id', id).order('updated_time', { ascending: false }).limit(10),
    subtasksOf: (id) => sb.from('subtasks').select('*').eq('parent_task_id', id).eq('is_deleted', false).order('due_date'),
    alerts: () => sb.from('ai_alerts').select('*').eq('is_deleted', false).order('alert_time', { ascending: false }),
    risks: () => sb.from('risks').select('*').eq('is_deleted', false).order('risk_score', { ascending: false }),
    issues: () => sb.from('v_issues').select('*').order('due_date', { ascending: true, nullsFirst: false }),
    campaignSummary: () => sb.from('v_campaign_summary').select('*').order('planned_start'),
    campaigns: () => sb.from('campaigns').select('*').eq('is_deleted', false).order('campaign_id'),
    projects: () => sb.from('projects').select('*').eq('is_deleted', false).order('project_id'),
    metrics: () => sb.from('metrics').select('campaign_id,data_date,impressions,clicks,conversions,revenue,ad_spend')
      .eq('is_deleted', false).order('data_date'),
    workload: () => sb.from('v_member_workload').select('*').order('member_id'),
    dataQuality: () => sb.from('v_data_quality').select('*'),
    profiles: () => sb.from('profiles').select('user_id,member_id,email,role,auth_status,last_login_at,version'),
    invitations: () => sb.from('invitations').select('*').order('created_at', { ascending: false }),
    organization: () => sb.from('organizations').select('*').maybeSingle()
  };

  return {
    sb, configured, check, translateError, cache, loadLookups, insert,
    memberName, campaignName, projectName, opts, setting, roasTarget,
    currentProjectId, setProject, updateWithVersion, q
  };
})();
