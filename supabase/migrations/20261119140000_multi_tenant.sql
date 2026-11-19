-- =====================================================================
-- AI 品牌行銷專案管理與成效預警系統：多公司共用版（v2）
--
-- 重點：
--   1. 每家公司一筆 organizations，所有資料表都有 org_id
--   2. 主鍵改為 (org_id, 編號)，外鍵也包含 org_id → 不可能跨公司關聯
--   3. RLS 一律限制 org_id = 目前登入者的公司
--   4. 公司自行註冊（create_organization），員工用邀請制加入（invitations）
--   5. 所有編號（T-001、MKT-001…）由資料庫自動產生，各公司各自從 001 開始
--
-- ⚠️ 本檔會先刪除 v1（單一公司版）的所有資料表與函式，再重新建立
-- =====================================================================

alter database postgres set timezone to 'Asia/Taipei';
set timezone to 'Asia/Taipei';

-- =====================================================================
-- 0. 清除 v1
-- =====================================================================
drop trigger if exists on_auth_user_created on auth.users;

drop view if exists public.v_data_quality, public.v_project_overview, public.v_campaign_summary,
  public.v_issues, public.v_member_workload cascade;

drop table if exists
  public.option_lists, public.system_settings, public.sync_status, public.backups, public.imports,
  public.notifications, public.audit_log, public.attachments, public.approvals, public.kpis,
  public.expenses, public.metrics, public.contents, public.ai_alerts, public.ai_runs, public.issues,
  public.risks, public.hour_allocations, public.task_dependencies, public.subtasks,
  public.task_collaborators, public.progress_updates, public.milestones, public.tasks,
  public.campaigns, public.profiles, public.members, public.projects,
  public.invitations, public.org_sequences, public.organizations
  cascade;

drop function if exists
  public.current_member_id, public.current_app_role, public.current_org_id, public.is_pm,
  public.is_leader_or_pm, public.is_authorized, public.can_edit_task, public.tg_touch_row,
  public.tg_touch_profile, public.tg_audit, public.handle_new_user, public.mark_password_changed,
  public.touch_last_login, public.get_my_profile, public.tg_guard_task_member_edit,
  public.tg_auto_code, public.next_code, public.seed_org_defaults, public.create_organization,
  public.claim_invitation, public.tg_guard_last_pm, public.invite_member, public.my_invitation,
  public.tg_guard_org
  cascade;

-- =====================================================================
-- 1. 公司
-- =====================================================================
create table public.organizations (
  org_id          uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) between 2 and 80), -- 公司名稱
  logo_url        text,                                  -- Logo 網址
  primary_color   text not null default '#4f46e5',       -- 品牌主色
  currency        text not null default 'TWD',
  timezone        text not null default 'Asia/Taipei',
  plan            text not null default 'free',
  status          text not null default 'active' check (status in ('active','suspended')),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 目前登入者所屬公司（plpgsql：建立時不檢查 profiles 是否存在）
create or replace function public.current_org_id()
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare v uuid;
begin
  select p.org_id into v
    from public.profiles p
    join public.organizations o on o.org_id = p.org_id and o.status = 'active'
   where p.user_id = auth.uid() and p.auth_status = '已授權';
  return v;
end;
$$;

-- 1. 主檔：專案、組員、帳號
-- =====================================================================

-- 02 專案總覽（原本是「指標／數值」直式表，改為一列一個專案）
create table public.projects (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  project_id         text not null,                 -- 專案ID（PRJ-001）
  name               text not null,                    -- 專案名稱
  owner_name         text,                             -- 專案負責人
  objective          text,                             -- 專案目標
  start_date         date,                             -- 開始日期
  planned_end_date   date,                             -- 預計結束日期
  forecast_end_date  date,                             -- 預測完成日期
  status             text default '進行中',             -- 專案狀態
  total_budget       numeric(14,2) default 0,          -- 專案總預算
  schema_version     text,                             -- 資料結構版本
  notes              text,                             -- 備註／資料性質
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, project_id)
);

-- 10 組員資訊（統計類欄位改由 v_member_workload 計算）
create table public.members (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  member_id            text not null,               -- 組員ID（M006）
  name                 text not null,                  -- 組員姓名
  project_role         text not null default '組員',    -- 專案角色：專案經理／組長／組員…
  department           text,                           -- 所屬部門
  email                text,                    -- 電子郵件（登入帳號）
  contact              text,                           -- 聯絡方式
  join_date            date,                           -- 加入日期
  leave_date           date,                           -- 離開日期
  status               text default '在職',             -- 人員狀態
  skills               text,                           -- 專業技能
  skill_level          text,                           -- 技能等級
  weekly_hours         numeric(6,1) default 40,        -- 每週可投入工時
  last_report_at       timestamptz,                    -- 最後進度回報時間
  notes                text,                           -- 備註
  line_user_id         text,                    -- LINE接收身分識別
  leader_id            text, -- 直屬組長ID
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  created_by           text,
  updated_at           timestamptz not null default now(),
  updated_by           text,
  is_deleted           boolean not null default false,
  deleted_at           timestamptz,
  deleted_by           text,
  primary key (org_id, member_id),
  unique (org_id, email),
  unique (org_id, line_user_id),
  foreign key (org_id, leader_id) references public.members(org_id, member_id)
);

-- 27 使用者授權管理（對應 Supabase Auth 帳號）
create table public.profiles (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  user_id               uuid primary key references auth.users(id) on delete cascade,
  member_id             text not null,
  email                 text not null,
  role                  text not null default '組員'
                        check (role in ('專案經理','組長','組員')),
  auth_status           text not null default '已授權'
                        check (auth_status in ('已授權','已停用','待審核')),
  must_change_password  boolean not null default true,  -- 需變更密碼（首次登入強制變更）
  authorized_by         text,                           -- 授權人ID
  authorized_at         timestamptz default now(),      -- 授權時間
  last_login_at         timestamptz,                    -- 最後登入時間
  password_updated_at   timestamptz,                    -- 密碼更新時間
  disabled_at           timestamptz,                    -- 停用時間
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  created_by            text,
  updated_at            timestamptz not null default now(),
  updated_by            text,
  unique (org_id, member_id),
  foreign key (org_id, member_id) references public.members(org_id, member_id)
);

-- =====================================================================
-- 2. 行銷活動與任務
-- =====================================================================

-- 13 行銷活動管理
create table public.campaigns (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  campaign_id        text not null,                 -- 活動ID（MKT-001）
  project_id         text, -- 專案ID
  name               text not null,                    -- 活動名稱
  campaign_type      text,                             -- 活動類型
  objective          text,                             -- 活動目標
  target_audience    text,                             -- 目標受眾
  owner_id           text, -- 活動負責人ID
  planned_start      date,                             -- 計畫開始日期
  planned_end        date,                             -- 計畫結束日期
  actual_start       date,                             -- 實際開始日期
  actual_end         date,                             -- 實際結束日期
  approved_budget    numeric(14,2) default 0,          -- 核定預算
  status             text,                             -- 活動狀態
  applicant_id       text,                             -- 申請人ID
  submitted_at       timestamptz,                      -- 送審時間
  approver_id        text,                             -- 核准人ID
  approved_at        timestamptz,                      -- 核准時間
  actual_progress    numeric(5,4) default 0,           -- 實際進度（0～1）
  notes              text,                             -- 備註
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, campaign_id),
  foreign key (org_id, project_id) references public.projects(org_id, project_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id)
);

-- 04 任務管理（進度一律存 0～1 的小數，例如 100% → 1）
create table public.tasks (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  task_id               text not null,              -- 任務ID（T-MKT-001）
  name                  text not null,                 -- 任務名稱
  description           text,                          -- 任務說明
  owner_id              text, -- 負責人ID
  priority              text default '中',              -- 優先級
  planned_start         date,                          -- 預計開始日期
  planned_end           date,                          -- 預計完成日期
  actual_end            date,                          -- 實際完成日期
  planned_progress      numeric(5,4) default 0,        -- 預計進度
  actual_progress       numeric(5,4) default 0,        -- 實際進度
  progress_gap          numeric(6,4)                   -- 進度落差（實際－預計，負數代表落後）
                        generated always as (actual_progress - planned_progress) stored,
  status                text default '未開始',          -- 任務狀態
  predecessor_ids       text,                          -- 前置任務ID（詳細關係見 task_dependencies）
  estimated_hours       numeric(8,1) default 0,        -- 預估工時
  actual_hours          numeric(8,1) default 0,        -- 實際工時
  remaining_hours       numeric(8,1) default 0,        -- 剩餘工時
  delay_days            integer default 0,             -- 延誤天數
  forecast_end          date,                          -- 預測完成日期
  risk_light            text,                          -- 風險燈號（綠／黃／紅）
  blocked_reason        text,                          -- 阻塞原因
  notes                 text,                          -- 備註
  weight_draft          numeric(8,2),                  -- 任務權重草稿
  weight_status         text,                          -- 任務權重狀態
  campaign_id           text, -- 關聯活動ID
  progress_source       text,                          -- 進度來源
  manager_override      numeric(5,4),                  -- 主管覆寫進度
  review_status         text,                          -- 審核狀態
  version               integer not null default 1,    -- 資料版本
  created_at            timestamptz not null default now(),
  created_by            text,
  updated_at            timestamptz not null default now(), -- 最後更新時間
  updated_by            text,
  is_deleted            boolean not null default false,
  deleted_at            timestamptz,
  deleted_by            text,
  primary key (org_id, task_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id)
);

-- 05 里程碑管理
create table public.milestones (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  milestone_id       text not null,                 -- 里程碑ID
  name               text not null,                    -- 里程碑名稱
  description        text,                             -- 里程碑說明
  planned_end        date,                             -- 預計完成日期
  forecast_end       date,                             -- 預測完成日期
  actual_end         date,                             -- 實際完成日期
  task_ids           text,                             -- 關聯任務ID（可多筆，以逗號分隔）
  acceptance_criteria text,                            -- 完成標準
  acceptor_name      text,                             -- 驗收負責人
  acceptance_status  text default '未驗收',             -- 驗收狀態
  delay_days         integer default 0,                -- 延誤天數
  light              text,                             -- 里程碑燈號
  campaign_id        text, -- 關聯活動ID
  approval_id        text,                             -- 審核紀錄ID
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, milestone_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id)
);

-- 06 進度更新紀錄
create table public.progress_updates (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  update_id          text not null,                    -- 更新ID（自動編號）
  task_id            text not null, -- 任務ID
  updated_time       timestamptz not null default now(), -- 更新時間
  progress_before    numeric(5,4),                     -- 更新前進度
  progress_after     numeric(5,4),                     -- 更新後進度
  done_items         text,                             -- 本次完成事項
  next_steps         text,                             -- 下一步工作
  difficulties       text,                             -- 遭遇困難
  remaining_hours    numeric(8,1),                     -- 預估剩餘工時
  updater_id         text, -- 更新人ID
  source             text default 'APP',               -- 更新來源
  created_at         timestamptz not null default now(),
  primary key (org_id, update_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, updater_id) references public.members(org_id, member_id)
);

-- 17 任務協作成員
create table public.task_collaborators (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  collab_id          text not null,                 -- 協作ID
  task_id            text not null,
  member_id          text not null,
  collab_role        text default '協作者',             -- 協作角色
  join_date          date,
  leave_date         date,
  responsibility     text,                             -- 分工說明
  status             text default '有效',
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, collab_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, member_id) references public.members(org_id, member_id)
);

-- 18 子任務管理
create table public.subtasks (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  subtask_id         text not null,                 -- 子任務ID
  parent_task_id     text not null, -- 父任務ID
  name               text not null,
  description        text,
  owner_id           text,
  start_date         date,
  due_date           date,
  actual_progress    numeric(5,4) default 0,
  weight             numeric(5,4) default 0,
  status             text default '未開始',
  actual_end         date,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, subtask_id),
  foreign key (org_id, parent_task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id)
);

-- 19 任務依賴關係
create table public.task_dependencies (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  dependency_id      text not null,                 -- 依賴ID
  predecessor_id     text not null, -- 前置任務ID
  successor_id       text not null, -- 後續任務ID
  dependency_type    text default '完成後開始',          -- 依賴類型
  lag_days           integer default 0,                -- 延遲天數
  block_status       text default '無',                 -- 阻塞狀態
  notes              text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  check (predecessor_id <> successor_id),
  primary key (org_id, dependency_id),
  foreign key (org_id, predecessor_id) references public.tasks(org_id, task_id),
  foreign key (org_id, successor_id) references public.tasks(org_id, task_id)
);

-- 11 工時分配紀錄
create table public.hour_allocations (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  allocation_id      text not null,                 -- 分配ID
  member_id          text not null,
  task_id            text,
  week_start         date not null,                    -- 週起始日期
  allocated_hours    numeric(6,1) default 0,           -- 本週分配工時
  status             text,                             -- 分配狀態
  notes              text,
  actual_hours       numeric(6,1),                     -- 實際工時
  confirmed_by       text,                             -- 工時確認人ID
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, allocation_id),
  foreign key (org_id, member_id) references public.members(org_id, member_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id)
);

-- =====================================================================
-- 3. 風險、問題、AI 預警
-- =====================================================================

-- 07 風險管理
create table public.risks (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  risk_id            text not null,
  task_id            text,
  name               text not null,
  description        text,
  risk_type          text,                             -- 風險類型
  probability        smallint check (probability between 1 and 5), -- 發生機率
  impact             smallint check (impact between 1 and 5),      -- 影響程度
  risk_score         smallint generated always as (probability * impact) stored, -- 風險分數
  risk_level         text,                             -- 風險等級
  owner_id           text, -- 風險負責人
  response_plan      text,                             -- 應對措施
  response_due       date,                             -- 應對期限
  status             text default '待處理',             -- 風險狀態
  last_assessed      date,                             -- 最後評估日期
  notes              text,
  campaign_id        text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, risk_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id)
);

-- 08 問題追蹤（逾期天數改由 View 即時計算）
create table public.issues (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  issue_id           text not null,
  task_id            text,
  name               text not null,
  description        text,
  severity           text,                             -- 嚴重程度
  found_date         date,                             -- 發現日期
  owner_id           text, -- 問題負責人
  due_date           date,                             -- 預計解決日期
  resolved_date      date,                             -- 實際解決日期
  status             text default '待處理',             -- 問題狀態
  solution           text,                             -- 解決方案
  escalated          boolean default false,            -- 是否升級處理
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, issue_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id)
);

-- 29 AI分析執行紀錄（先建，09 會參照）
create table public.ai_runs (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  run_id             text not null,                 -- 執行ID
  alert_id           text,                             -- 關聯預警ID
  provider           text,                             -- 模型供應商（Google Gemini）
  model              text,                             -- 模型代碼
  run_at             timestamptz default now(),        -- 執行時間
  status             text,                             -- 分析狀態
  input_hash         text,                             -- 輸入摘要雜湊
  output_summary     text,                             -- 輸出摘要
  error_code         text,                             -- 錯誤代碼
  duration_ms        integer,                          -- 處理時間（毫秒）
  estimated_cost     numeric(10,4) default 0,           -- 估算費用
  primary key (org_id, run_id)
);

-- 09 AI預警紀錄
create table public.ai_alerts (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  alert_id           text not null,                 -- 預警ID
  task_id            text,
  alert_time         timestamptz not null default now(), -- 預警時間
  alert_type         text,                             -- 預警類型
  alert_level        text,                             -- 預警等級
  trigger_condition  text,                             -- 觸發條件
  evidence           text,                             -- 依據資料
  ai_summary         text,                             -- AI分析摘要
  ai_suggestion      text,                             -- AI建議措施
  suggested_due      date,                             -- 建議處理期限
  notify_member_id   text, -- 通知對象
  notify_status      text default '待發送',             -- 通知狀態
  handle_status      text default '待處理',             -- 處理狀態
  handler_id         text, -- 處理負責人
  handle_result      text,                             -- 處理結果
  closed_at          timestamptz,                      -- 結案時間
  campaign_id        text,
  rule_code          text,                             -- 規則代碼（MKT07）
  ai_run_id          text, -- AI執行ID
  review_result      text,                             -- 建議審核結果
  review_comment     text,                             -- 建議審核意見
  reviewer_id        text,                             -- 建議審核人ID
  reviewed_at        timestamptz,                      -- 建議審核時間
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, alert_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, notify_member_id) references public.members(org_id, member_id),
  foreign key (org_id, handler_id) references public.members(org_id, member_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id),
  foreign key (org_id, ai_run_id) references public.ai_runs(org_id, run_id)
);

-- =====================================================================
-- 4. 行銷內容、成效、預算、KPI
-- =====================================================================

-- 14 內容發布排程
create table public.contents (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  content_id         text not null,
  campaign_id        text,
  task_id            text,
  title              text not null,
  content_type       text,                             -- 內容類型
  platform           text,                             -- 發布平台
  summary            text,
  asset_url          text,                             -- 素材連結
  owner_id           text,
  scheduled_at       timestamptz,                      -- 預定發布時間
  published_at       timestamptz,                      -- 實際發布時間
  production_status  text,                             -- 製作狀態
  review_status      text,                             -- 審核狀態
  submitted_at       timestamptz,
  approver_id        text,
  approved_at        timestamptz,
  publish_status     text,                             -- 發布狀態
  publish_url        text,                             -- 發布網址
  notes              text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, content_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id),
  foreign key (org_id, task_id) references public.tasks(org_id, task_id),
  foreign key (org_id, owner_id) references public.members(org_id, member_id)
);

-- 15 行銷成效紀錄（CTR、CPC、CPA、ROAS、互動率自動計算）
create table public.metrics (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  metric_id          text not null,                 -- 成效ID
  campaign_id        text,
  content_id         text,
  platform           text,
  data_date          date not null,                    -- 數據日期
  impressions        bigint default 0,                 -- 曝光數
  reach              bigint default 0,                 -- 觸及數
  clicks             bigint default 0,                 -- 點擊數
  interactions       bigint default 0,                 -- 互動數
  conversions        bigint default 0,                 -- 轉換數
  revenue            numeric(14,2) default 0,          -- 歸因營收
  ad_spend           numeric(14,2) default 0,          -- 廣告花費
  ctr                numeric generated always as (clicks::numeric / nullif(impressions,0)) stored,
  cpc                numeric generated always as (ad_spend / nullif(clicks,0)) stored,
  cpa                numeric generated always as (ad_spend / nullif(conversions,0)) stored,
  roas               numeric generated always as (revenue / nullif(ad_spend,0)) stored,
  engagement_rate    numeric generated always as (interactions::numeric / nullif(reach,0)) stored,
  data_source        text,                             -- 資料來源
  source_record_id   text,                             -- 來源紀錄ID
  import_batch_id    text,                             -- 匯入批次ID
  data_updated_at    timestamptz,                      -- 資料更新時間
  notes              text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, metric_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id),
  foreign key (org_id, content_id) references public.contents(org_id, content_id)
);

-- 16 行銷預算管理
create table public.expenses (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  expense_id         text not null,                 -- 支出ID
  campaign_id        text,
  item               text not null,                    -- 支出項目
  category           text,                             -- 支出類別
  vendor             text,                             -- 供應商
  applicant_id       text,                             -- 申請人ID
  apply_date         date,                             -- 申請日期
  requested_amount   numeric(14,2) default 0,          -- 申請金額
  approved_amount    numeric(14,2) default 0,          -- 核准金額
  committed_amount   numeric(14,2) default 0,          -- 承諾金額
  actual_amount      numeric(14,2) default 0,          -- 實際支出金額
  paid_amount        numeric(14,2) default 0,          -- 已付款金額
  currency           text default 'TWD',
  review_status      text,
  payment_status     text,
  planned_pay_date   date,
  actual_pay_date    date,
  approver_id        text,
  approved_date      date,
  attachment_id      text,                             -- 憑證附件ID
  notes              text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, expense_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id)
);

-- 22 行銷KPI設定
create table public.kpis (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  kpi_id             text not null,                 -- KPI設定ID
  campaign_id        text,
  metric_code        text not null,                    -- 指標代碼
  metric_name        text,                             -- 指標名稱
  direction          text default '越高越好',            -- 計算方向
  target_value       numeric(14,4),                    -- 目標值
  weight             numeric(5,4) default 0,           -- 權重
  period             text,                             -- 計算期間
  data_source        text,
  is_active          boolean default true,             -- 是否啟用
  notes              text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, kpi_id),
  foreign key (org_id, campaign_id) references public.campaigns(org_id, campaign_id)
);

-- =====================================================================
-- 5. 審核、附件、系統紀錄
-- =====================================================================

-- 20 審核紀錄
create table public.approvals (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  approval_id        text not null,
  business_type      text not null,                    -- 業務類型（行銷活動／內容／支出…）
  business_id        text not null,                    -- 業務ID
  stage              text,                             -- 審核階段
  submitter_id       text,
  reviewer_id        text,
  submitted_at       timestamptz,
  reviewed_at        timestamptz,
  result             text,                             -- 審核結果
  reject_reason      text,
  comment            text,
  review_version     integer,
  created_at         timestamptz not null default now(),
  primary key (org_id, approval_id)
);

-- 21 附件索引（之後可改用 Supabase Storage）
create table public.attachments (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  attachment_id      text not null,
  business_type      text,
  business_id        text,
  drive_file_id      text,                             -- Drive檔案ID 或 Storage 路徑
  file_name          text,
  mime_type          text,
  file_size          bigint,
  uploader_id        text,
  uploaded_at        timestamptz default now(),
  access_status      text,
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text,
  primary key (org_id, attachment_id)
);

-- 23 資料異動紀錄（由 trigger 自動寫入）
create table public.audit_log (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  audit_id           bigint generated always as identity primary key,
  legacy_id          text,                             -- 原試算表的異動ID（匯入舊資料用）
  table_name         text not null,                    -- 工作表／資料表
  record_id          text,                             -- 紀錄ID
  action             text not null,                    -- 操作類型
  changed_fields     text[],                           -- 欄位
  old_data           jsonb,                            -- 修改前值
  new_data           jsonb,                            -- 修改後值
  actor_id           text,                             -- 操作人ID
  source             text default 'APP',               -- 操作來源
  created_at         timestamptz not null default now(), -- 操作時間
  old_version        integer,
  new_version        integer,
  request_id         text
);

-- 24 系統通知紀錄
create table public.notifications (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  notification_id    text not null,
  event_type         text,
  related_id         text,
  recipient_id       text,
  channel            text,                             -- LINE／Email
  summary            text,
  send_status        text default '待發送',
  attempts           integer default 0,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz,
  error_code         text,
  primary key (org_id, notification_id),
  foreign key (org_id, recipient_id) references public.members(org_id, member_id)
);

-- 25 資料匯入紀錄
create table public.imports (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  import_id          text not null,
  batch_id           text,
  source_platform    text,
  file_name          text,
  file_hash          text,
  field_mapping      text,
  total_rows         integer,
  success_rows       integer,
  failed_rows        integer,
  status             text,
  operator_id        text,
  imported_at        timestamptz default now(),
  error_summary      text,
  primary key (org_id, import_id)
);

-- 26 系統備份紀錄
create table public.backups (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  backup_id          text not null,
  backup_type        text,
  drive_file_id      text,
  started_at         timestamptz,
  finished_at        timestamptz,
  status             text,
  file_hash          text,
  retain_until       date,
  restore_test       text,
  message            text,
  primary key (org_id, backup_id)
);

-- 28 資料同步狀態（改記錄 Supabase → 試算表的同步）
create table public.sync_status (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  sync_id            text not null,
  target_sheet       text,                             -- 工作表
  record_id          text,
  current_version    integer,
  data_hash          text,
  last_source        text,                             -- 最後同步來源
  last_synced_at     timestamptz,
  conflict_status    text,
  conflict_reason    text,
  handled_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (org_id, sync_id)
);

-- 12 系統設定：參數
create table public.system_settings (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  key                text not null,                 -- 設定參數
  value              text not null,                    -- 參數值
  description        text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  primary key (org_id, key)
);

-- 12 系統設定：下拉選單
create table public.option_lists (
  org_id             uuid not null default public.current_org_id()
                     references public.organizations(org_id) on delete cascade,
  category           text not null,                    -- 例如「任務狀態」
  value              text not null,
  sort_order         integer not null default 0,
  is_active          boolean not null default true,
  primary key (org_id, category, value)
);

-- =====================================================================

-- 邀請（員工以邀請碼加入公司）
create table public.invitations (
  org_id          uuid not null default public.current_org_id()
                  references public.organizations(org_id) on delete cascade,
  invitation_id   uuid primary key default gen_random_uuid(),
  email           text not null,
  member_id       text not null,
  role            text not null default '組員' check (role in ('專案經理','組長','組員')),
  invite_code     text not null default upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)), -- 邀請碼
  status          text not null default '待接受' check (status in ('待接受','已接受','已取消')),
  invited_by      text,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  expires_at      timestamptz not null default now() + interval '30 days',
  foreign key (org_id, member_id) references public.members(org_id, member_id) on delete cascade
);
-- 同一個 Email 同時間只能有一張有效邀請（一個帳號只屬於一家公司）
create unique index invitations_one_pending on public.invitations (lower(email)) where status = '待接受';

-- 各公司的流水號
create table public.org_sequences (
  org_id      uuid not null references public.organizations(org_id) on delete cascade,
  seq_name    text not null,
  last_value  integer not null default 0,
  primary key (org_id, seq_name)
);


-- =====================================================================
-- 6. 索引
-- =====================================================================
create index on public.tasks (org_id, owner_id);
create index on public.tasks (org_id, campaign_id);
create index on public.tasks (org_id, status);
create index on public.tasks (org_id, planned_end);
create index on public.campaigns (org_id, project_id);
create index on public.milestones (org_id, campaign_id);
create index on public.progress_updates (org_id, task_id, updated_time desc);
create index on public.task_collaborators (org_id, task_id);
create index on public.task_collaborators (org_id, member_id);
create index on public.subtasks (org_id, parent_task_id);
create index on public.task_dependencies (org_id, successor_id);
create index on public.hour_allocations (org_id, member_id, week_start);
create index on public.risks (org_id, task_id);
create index on public.issues (org_id, task_id);
create index on public.ai_alerts (org_id, task_id);
create index on public.ai_alerts (org_id, handle_status, alert_time desc);
create index on public.contents (org_id, campaign_id);
create index on public.metrics (org_id, campaign_id, data_date);
create index on public.expenses (org_id, campaign_id);
create index on public.kpis (org_id, campaign_id);
create index on public.audit_log (org_id, table_name, record_id);
create index on public.audit_log (org_id, created_at desc);
create index on public.members (org_id, leader_id);
create index on public.members (lower(email));
create index on public.profiles (org_id, role);

-- =====================================================================
-- 7. 身分與權限輔助函式
-- =====================================================================
create or replace function public.current_member_id()
returns text
language sql stable security definer set search_path = public
as $$
  select p.member_id from public.profiles p
  where p.user_id = auth.uid() and p.auth_status = '已授權'
    and p.org_id = public.current_org_id()
$$;

create or replace function public.current_app_role()
returns text
language sql stable security definer set search_path = public
as $$
  select p.role from public.profiles p
  where p.user_id = auth.uid() and p.auth_status = '已授權'
    and p.org_id = public.current_org_id()
$$;

create or replace function public.is_pm()
returns boolean language sql stable
as $$ select coalesce(public.current_app_role() = '專案經理', false) $$;

create or replace function public.is_leader_or_pm()
returns boolean language sql stable
as $$ select coalesce(public.current_app_role() in ('專案經理','組長'), false) $$;

create or replace function public.is_authorized()
returns boolean language sql stable
as $$ select public.current_org_id() is not null $$;

-- 是否可編輯任務：專案經理全部可；組長可改自己或直屬組員的；組員可改自己負責或協作的
create or replace function public.can_edit_task(p_task_id text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.current_org_id() is null then false
    when public.is_pm() then true
    else exists (
      select 1 from public.tasks t
      left join public.members m on m.org_id = t.org_id and m.member_id = t.owner_id
      where t.org_id = public.current_org_id()
        and t.task_id = p_task_id
        and (
          t.owner_id = public.current_member_id()
          or (public.current_app_role() = '組長' and m.leader_id = public.current_member_id())
          or exists (
            select 1 from public.task_collaborators c
            where c.org_id = t.org_id and c.task_id = t.task_id
              and c.member_id = public.current_member_id()
              and c.is_deleted = false and c.status = '有效'
          )
        )
    )
  end
$$;

-- =====================================================================
-- 8. 觸發器
-- =====================================================================

-- (a) 自動編號：沒給編號時，依公司各自流水號產生（例如 T-001）
create or replace function public.tg_auto_code()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_col    text := tg_argv[0];
  v_prefix text := tg_argv[1];
  v_cur    text;
  v_n      integer;
  v_code   text;
  v_exists boolean;
begin
  if new.org_id is null then
    new.org_id := public.current_org_id();
  end if;
  if new.org_id is null then
    raise exception '無法判斷所屬公司，請重新登入' using errcode = '42501';
  end if;

  v_cur := to_jsonb(new) ->> v_col;
  if v_cur is not null and btrim(v_cur) <> '' then
    return new;
  end if;

  loop
    insert into public.org_sequences (org_id, seq_name, last_value)
    values (new.org_id, tg_table_name, 1)
    on conflict (org_id, seq_name)
      do update set last_value = public.org_sequences.last_value + 1
    returning last_value into v_n;

    v_code := v_prefix || lpad(v_n::text, 3, '0');
    execute format('select exists (select 1 from public.%I where org_id = $1 and %I = $2)', tg_table_name, v_col)
      into v_exists using new.org_id, v_code;
    exit when not v_exists;
  end loop;

  new := jsonb_populate_record(new, jsonb_build_object(v_col, v_code));
  return new;
end;
$$;

-- (b) 更新時間、版本號（樂觀鎖）、建立人／更新人、軟刪除
create or replace function public.tg_touch_row()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception '不可變更資料所屬公司' using errcode = '42501';
    end if;
    new.version := coalesce(old.version, 0) + 1;
  end if;
  new.updated_by := coalesce(public.current_member_id(), new.updated_by);
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, public.current_member_id());
  end if;
  if new.is_deleted and (tg_op = 'INSERT' or not old.is_deleted) then
    new.deleted_at := coalesce(new.deleted_at, now());
    new.deleted_by := coalesce(new.deleted_by, public.current_member_id());
  end if;
  return new;
end;
$$;

create or replace function public.tg_touch_profile()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id or new.user_id is distinct from old.user_id
       or new.member_id is distinct from old.member_id then
      raise exception '不可變更帳號所屬公司或對應組員' using errcode = '42501';
    end if;
    new.version := coalesce(old.version, 0) + 1;
    if new.auth_status = '已停用' and old.auth_status <> '已停用' then
      new.disabled_at := now();
    elsif new.auth_status = '已授權' then
      new.disabled_at := null;
    end if;
  end if;
  new.updated_by := coalesce(public.current_member_id(), new.updated_by);
  return new;
end;
$$;

-- (c) 稽核紀錄（第一個參數是編號欄位名稱）
create or replace function public.tg_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_pk  text  := tg_argv[0];
  v_fields text[];
  v_action text;
begin
  if tg_op = 'UPDATE' then
    select array_agg(k) into v_fields
    from jsonb_object_keys(v_new) k
    where k not in ('updated_at','version','updated_by')
      and (v_new -> k) is distinct from (v_old -> k);
    if v_fields is null then
      return new;
    end if;
  end if;

  v_action := case
    when tg_op = 'INSERT' then '新增'
    when tg_op = 'DELETE' then '刪除'
    when (v_new ->> 'is_deleted') = 'true' and (v_old ->> 'is_deleted') = 'false' then '軟刪除'
    else '修改'
  end;

  insert into public.audit_log
    (org_id, table_name, record_id, action, changed_fields, old_data, new_data,
     actor_id, source, old_version, new_version)
  values
    ((coalesce(v_new, v_old) ->> 'org_id')::uuid,
     tg_table_name,
     coalesce(v_new ->> v_pk, v_old ->> v_pk),
     v_action, v_fields, v_old, v_new,
     public.current_member_id(),
     case when auth.uid() is null then 'SYSTEM' else 'APP' end,
     (v_old ->> 'version')::int, (v_new ->> 'version')::int);

  return coalesce(new, old);
end;
$$;

-- 套用到所有業務資料表：自動編號、時間版本、稽核
do $$
declare r record;
begin
  for r in
    select * from (values
      ('projects','project_id','PRJ-'),        ('members','member_id','M'),
      ('campaigns','campaign_id','MKT-'),      ('tasks','task_id','T-'),
      ('milestones','milestone_id','MS-'),     ('task_collaborators','collab_id','COL-'),
      ('subtasks','subtask_id','SUB-'),        ('task_dependencies','dependency_id','DEP-'),
      ('hour_allocations','allocation_id','ALLOC-'), ('risks','risk_id','R-'),
      ('issues','issue_id','I-'),              ('ai_alerts','alert_id','W-'),
      ('contents','content_id','CNT-'),        ('metrics','metric_id','PERF-'),
      ('expenses','expense_id','EXP-'),        ('kpis','kpi_id','KPI-'),
      ('attachments','attachment_id','ATT-')
    ) as t(tbl, pk, prefix)
  loop
    execute format('create trigger a_auto_code before insert on public.%I
      for each row execute function public.tg_auto_code(%L, %L)', r.tbl, r.pk, r.prefix);
    execute format('create trigger touch_row before insert or update on public.%I
      for each row execute function public.tg_touch_row()', r.tbl);
    execute format('create trigger audit_row after insert or update or delete on public.%I
      for each row execute function public.tg_audit(%L)', r.tbl, r.pk);
  end loop;

  -- 只需要自動編號的紀錄類資料表
  for r in
    select * from (values
      ('progress_updates','update_id','U-'), ('ai_runs','run_id','AIR-'),
      ('approvals','approval_id','APR-'),    ('notifications','notification_id','NTF-'),
      ('imports','import_id','IMP-'),        ('backups','backup_id','BAK-'),
      ('sync_status','sync_id','SYNC-')
    ) as t(tbl, pk, prefix)
  loop
    execute format('create trigger a_auto_code before insert on public.%I
      for each row execute function public.tg_auto_code(%L, %L)', r.tbl, r.pk, r.prefix);
  end loop;
end $$;

create trigger touch_profile before insert or update on public.profiles
  for each row execute function public.tg_touch_profile();
create trigger audit_profile after insert or update or delete on public.profiles
  for each row execute function public.tg_audit('member_id');

-- (d) 組員不可自行更改負責人、權重、計畫日期等欄位
create or replace function public.tg_guard_task_member_edit()
returns trigger language plpgsql
as $$
begin
  if not public.is_leader_or_pm() and auth.uid() is not null then
    if new.owner_id is distinct from old.owner_id
       or new.manager_override is distinct from old.manager_override
       or new.weight_draft is distinct from old.weight_draft
       or new.weight_status is distinct from old.weight_status
       or new.review_status is distinct from old.review_status
       or new.planned_start is distinct from old.planned_start
       or new.planned_end is distinct from old.planned_end
       or new.is_deleted is distinct from old.is_deleted then
      raise exception '組員沒有權限修改此欄位（負責人、權重、計畫日期、審核狀態或刪除）'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_task_member_edit before update on public.tasks
  for each row execute function public.tg_guard_task_member_edit();

-- (e) 每家公司至少要保留一位啟用中的專案經理；角色變更同步回組員資料
create or replace function public.tg_guard_last_pm()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.role = '專案經理' and old.auth_status = '已授權'
     and (tg_op = 'DELETE' or new.role <> '專案經理' or new.auth_status <> '已授權') then
    if not exists (
      select 1 from public.profiles p
      where p.org_id = old.org_id and p.user_id <> old.user_id
        and p.role = '專案經理' and p.auth_status = '已授權'
    ) then
      raise exception '公司至少需要一位啟用中的專案經理' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    update public.members set project_role = new.role
     where org_id = new.org_id and member_id = new.member_id;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger guard_last_pm before update or delete on public.profiles
  for each row execute function public.tg_guard_last_pm();

-- (f) 公司資料：使用者只能改名稱、Logo、主色、幣別、時區
create or replace function public.tg_guard_org()
returns trigger language plpgsql
as $$
begin
  if auth.uid() is not null and (new.plan is distinct from old.plan
       or new.status is distinct from old.status or new.created_by is distinct from old.created_by) then
    raise exception '不可修改方案或公司狀態' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_org before update on public.organizations
  for each row execute function public.tg_guard_org();

-- =====================================================================
-- 9. 公司註冊、預設資料、邀請
-- =====================================================================

-- 新公司的預設設定與下拉選單
create or replace function public.seed_org_defaults(p_org uuid)
returns void
language sql security definer set search_path = public
as $$
  insert into public.system_settings (org_id, key, value, description) values
    (p_org, '進度落後黃色門檻',     '0.10', '實際進度落後預計進度超過此比例 → 黃燈'),
    (p_org, '進度落後紅色門檻',     '0.20', '實際進度落後預計進度超過此比例 → 紅燈'),
    (p_org, '風險中級最低分',       '6',    '風險分數（機率×影響）達此分數 → 中'),
    (p_org, '風險高級最低分',       '15',   '風險分數達此分數 → 高'),
    (p_org, '未更新提醒天數',       '3',    '任務超過幾天未更新就提醒'),
    (p_org, '預算使用警戒比例',     '0.90', '活動支出達核定預算此比例 → 預警'),
    (p_org, '預警檢查間隔（小時）', '24',   'AI 預警自動檢查間隔'),
    (p_org, '工作負荷黃色門檻',     '0.8',  '本週分配工時 ÷ 可投入工時'),
    (p_org, '工作負荷紅色門檻',     '1',    '本週分配工時 ÷ 可投入工時'),
    (p_org, '未回報提醒天數',       '3',    '組員超過幾天未回報進度就提醒'),
    (p_org, 'ROAS目標',             '3.5',  '儀表板 ROAS 目標線'),
    (p_org, 'LINE每日摘要時間',     '21:00','每日預警摘要推播時間（只推給專案經理）')
  on conflict (org_id, key) do nothing;

  insert into public.option_lists (org_id, category, value, sort_order)
  select p_org, s.category, u.value, u.ord
  from (values
    ('專案狀態',     array['未開始','進行中','暫停','完成']),
    ('任務狀態',     array['未開始','進行中','阻塞','完成','取消']),
    ('活動狀態',     array['規劃中','待審核','進行中','已完成','已取消']),
    ('活動類型',     array['品牌曝光','會員招募','轉換促購','口碑行銷','再行銷','其他']),
    ('優先級',       array['高','中','低']),
    ('風險類型',     array['進度','成本','人力','技術','品質','外部','成效']),
    ('風險狀態',     array['待處理','處理中','已結案']),
    ('問題狀態',     array['待處理','處理中','已解決']),
    ('問題嚴重程度', array['高','中','低']),
    ('驗收狀態',     array['未驗收','驗收中','通過','未通過']),
    ('通知狀態',     array['待發送','成功','失敗']),
    ('預警處理狀態', array['待處理','處理中','已結案']),
    ('專案角色',     array['專案經理','組長','組員']),
    ('人員狀態',     array['在職','暫停參與','已離開']),
    ('技能等級',     array['初階','中階','高階','專家']),
    ('工時分配狀態', array['已規劃','已確認','已取消'])
  ) as s(category, vals),
  lateral unnest(s.vals) with ordinality as u(value, ord)
  on conflict (org_id, category, value) do nothing;
$$;

-- 公司自行註冊：建立公司＋第一位專案經理（自己）＋預設設定＋第一個專案
-- 前端：supabase.rpc('create_organization', { p_org_name, p_member_name, p_department, p_project_name })
create or replace function public.create_organization(
  p_org_name text, p_member_name text, p_department text default null, p_project_name text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_org   uuid;
  v_mid   text;
begin
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where user_id = v_uid) then
    raise exception '此帳號已屬於一家公司，不能再建立新公司' using errcode = '42501';
  end if;
  if coalesce(btrim(p_org_name), '') = '' or coalesce(btrim(p_member_name), '') = '' then
    raise exception '請填寫公司名稱與你的姓名';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.organizations (name, created_by)
  values (btrim(p_org_name), v_uid)
  returning org_id into v_org;

  perform public.seed_org_defaults(v_org);

  insert into public.members (org_id, name, project_role, department, email, join_date, status, created_by)
  values (v_org, btrim(p_member_name), '專案經理', nullif(btrim(p_department), ''), v_email, current_date, '在職', 'SYSTEM')
  returning member_id into v_mid;

  insert into public.profiles (org_id, user_id, member_id, email, role, auth_status, must_change_password, created_by)
  values (v_org, v_uid, v_mid, v_email, '專案經理', '已授權', false, 'SYSTEM');

  if coalesce(btrim(p_project_name), '') <> '' then
    insert into public.projects (org_id, name, owner_name, start_date, status, created_by)
    values (v_org, btrim(p_project_name), btrim(p_member_name), current_date, '進行中', v_mid);
  end if;

  -- 被邀請過的同一個 Email 若自行建公司，取消原本的邀請
  update public.invitations set status = '已取消'
   where lower(email) = lower(v_email) and status = '待接受';

  return v_org;
end;
$$;

-- 專案經理邀請員工：建立組員資料＋邀請碼
-- 前端：supabase.rpc('invite_member', { p_name, p_email, p_role, p_department, p_leader_id, p_weekly_hours })
create or replace function public.invite_member(
  p_name text, p_email text, p_role text default '組員', p_department text default null,
  p_leader_id text default null, p_weekly_hours numeric default 40)
returns table (member_id text, invite_code text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_org   uuid := public.current_org_id();
  v_email text := lower(btrim(p_email));
  v_mid   text;
  v_code  text;
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以邀請成員' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Email 格式不正確';
  end if;
  if p_role not in ('專案經理','組長','組員') then
    raise exception '角色不正確';
  end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_email) then
    raise exception '此 Email 已有帳號，無法邀請';
  end if;
  if exists (select 1 from public.invitations i where lower(i.email) = v_email and i.status = '待接受') then
    raise exception '此 Email 已有尚未接受的邀請';
  end if;

  -- 同公司已有同 Email 的組員（例如先前取消邀請）就沿用
  select m.member_id into v_mid from public.members m
   where m.org_id = v_org and lower(m.email) = v_email;

  if v_mid is null then
    insert into public.members (org_id, name, project_role, department, email, leader_id, weekly_hours, join_date, status)
    values (v_org, btrim(p_name), p_role, nullif(btrim(p_department), ''), v_email,
            nullif(p_leader_id, ''), coalesce(p_weekly_hours, 40), current_date, '在職')
    returning members.member_id into v_mid;
  else
    update public.members m set name = btrim(p_name), project_role = p_role, is_deleted = false
     where m.org_id = v_org and m.member_id = v_mid;
  end if;

  insert into public.invitations (org_id, email, member_id, role, invited_by)
  values (v_org, v_email, v_mid, p_role, public.current_member_id())
  returning invitations.invite_code into v_code;

  return query select v_mid, v_code;
end;
$$;

-- 員工註冊後，輸入邀請碼加入公司（Email 必須與邀請相同）
-- 前端：supabase.rpc('claim_invitation', { p_code })
create or replace function public.claim_invitation(p_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_inv   public.invitations%rowtype;
  v_name  text;
begin
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where user_id = v_uid) then
    raise exception '此帳號已加入公司';
  end if;
  select lower(email) into v_email from auth.users where id = v_uid;

  select * into v_inv from public.invitations
   where lower(email) = v_email and status = '待接受'
     and upper(invite_code) = upper(btrim(p_code)) and expires_at > now()
   limit 1;
  if not found then
    raise exception '邀請碼錯誤、已過期，或與登入的 Email 不符';
  end if;

  insert into public.profiles (org_id, user_id, member_id, email, role, auth_status, must_change_password, created_by)
  values (v_inv.org_id, v_uid, v_inv.member_id, v_email, v_inv.role, '已授權', false, 'SYSTEM');

  update public.invitations set status = '已接受', accepted_at = now()
   where invitation_id = v_inv.invitation_id;

  select name into v_name from public.organizations where org_id = v_inv.org_id;
  return v_name;
end;
$$;

-- 首次登入改完密碼後呼叫（保留給「專案經理重設密碼」功能使用）
create or replace function public.mark_password_changed()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles set must_change_password = false, password_updated_at = now()
   where user_id = auth.uid()
$$;

create or replace function public.touch_last_login()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles set last_login_at = now() where user_id = auth.uid()
$$;

-- 自己的身分＋公司資訊（左上角使用者卡片用）
create or replace function public.get_my_profile()
returns table (org_id uuid, org_name text, primary_color text, logo_url text,
               member_id text, name text, email text, role text, auth_status text,
               department text, must_change_password boolean, line_bound boolean)
language sql stable security definer set search_path = public
as $$
  select o.org_id, o.name, o.primary_color, o.logo_url,
         p.member_id, m.name, p.email, p.role, p.auth_status,
         m.department, p.must_change_password, (m.line_user_id is not null)
  from public.profiles p
  join public.organizations o on o.org_id = p.org_id
  join public.members m on m.org_id = p.org_id and m.member_id = p.member_id
  where p.user_id = auth.uid()
$$;

-- =====================================================================
-- 10. Row Level Security：所有資料只限本公司
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','projects','members','profiles','campaigns','tasks','milestones','progress_updates',
    'task_collaborators','subtasks','task_dependencies','hour_allocations','risks','issues',
    'ai_runs','ai_alerts','contents','metrics','expenses','kpis','approvals','attachments',
    'audit_log','notifications','imports','backups','sync_status','system_settings','option_lists',
    'invitations','org_sequences'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 公司：看自己的；專案經理可修改
create policy org_select on public.organizations for select to authenticated
  using (org_id = public.current_org_id());
create policy org_update on public.organizations for update to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());

-- (a) 一般業務資料：本公司可讀；專案經理、組長可新增／修改；專案經理可實體刪除
do $$
declare t text;
begin
  foreach t in array array[
    'projects','campaigns','milestones','task_dependencies','risks','issues',
    'contents','metrics','expenses','kpis','approvals','attachments'
  ] loop
    execute format($f$create policy "%1$s_select" on public.%1$I for select to authenticated
      using (org_id = public.current_org_id())$f$, t);
    execute format($f$create policy "%1$s_insert" on public.%1$I for insert to authenticated
      with check (org_id = public.current_org_id() and public.is_leader_or_pm())$f$, t);
    execute format($f$create policy "%1$s_update" on public.%1$I for update to authenticated
      using (org_id = public.current_org_id() and public.is_leader_or_pm())
      with check (org_id = public.current_org_id() and public.is_leader_or_pm())$f$, t);
    execute format($f$create policy "%1$s_delete" on public.%1$I for delete to authenticated
      using (org_id = public.current_org_id() and public.is_pm())$f$, t);
  end loop;
end $$;

-- (b) 任務
create policy tasks_select on public.tasks for select to authenticated
  using (org_id = public.current_org_id());
create policy tasks_insert on public.tasks for insert to authenticated
  with check (org_id = public.current_org_id() and public.is_leader_or_pm());
create policy tasks_update on public.tasks for update to authenticated
  using (org_id = public.current_org_id() and public.can_edit_task(task_id))
  with check (org_id = public.current_org_id() and public.can_edit_task(task_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (org_id = public.current_org_id() and public.is_pm());

-- (c) 子任務
create policy subtasks_select on public.subtasks for select to authenticated
  using (org_id = public.current_org_id());
create policy subtasks_insert on public.subtasks for insert to authenticated
  with check (org_id = public.current_org_id() and public.can_edit_task(parent_task_id));
create policy subtasks_update on public.subtasks for update to authenticated
  using (org_id = public.current_org_id()
         and (public.can_edit_task(parent_task_id) or owner_id = public.current_member_id()))
  with check (org_id = public.current_org_id()
         and (public.can_edit_task(parent_task_id) or owner_id = public.current_member_id()));
create policy subtasks_delete on public.subtasks for delete to authenticated
  using (org_id = public.current_org_id() and public.is_pm());

-- (d) 進度回報：可編輯該任務者可新增，更新人必須是自己；不可修改
create policy progress_select on public.progress_updates for select to authenticated
  using (org_id = public.current_org_id());
create policy progress_insert on public.progress_updates for insert to authenticated
  with check (org_id = public.current_org_id() and public.can_edit_task(task_id)
              and updater_id = public.current_member_id());

-- (e) 協作成員
create policy collab_select on public.task_collaborators for select to authenticated
  using (org_id = public.current_org_id());
create policy collab_write on public.task_collaborators for all to authenticated
  using (org_id = public.current_org_id() and public.is_leader_or_pm())
  with check (org_id = public.current_org_id() and public.is_leader_or_pm());

-- (f) 工時分配
create policy alloc_select on public.hour_allocations for select to authenticated
  using (org_id = public.current_org_id());
create policy alloc_insert on public.hour_allocations for insert to authenticated
  with check (org_id = public.current_org_id() and public.is_leader_or_pm());
create policy alloc_update on public.hour_allocations for update to authenticated
  using (org_id = public.current_org_id() and (public.is_leader_or_pm() or member_id = public.current_member_id()))
  with check (org_id = public.current_org_id() and (public.is_leader_or_pm() or member_id = public.current_member_id()));
create policy alloc_delete on public.hour_allocations for delete to authenticated
  using (org_id = public.current_org_id() and public.is_pm());

-- (g) AI 預警
create policy alerts_select on public.ai_alerts for select to authenticated
  using (org_id = public.current_org_id());
create policy alerts_insert on public.ai_alerts for insert to authenticated
  with check (org_id = public.current_org_id() and public.is_leader_or_pm());
create policy alerts_update on public.ai_alerts for update to authenticated
  using (org_id = public.current_org_id() and (public.is_leader_or_pm() or handler_id = public.current_member_id()))
  with check (org_id = public.current_org_id() and (public.is_leader_or_pm() or handler_id = public.current_member_id()));
create policy ai_runs_select on public.ai_runs for select to authenticated
  using (org_id = public.current_org_id() and public.is_leader_or_pm());

-- (h) 組員：本公司可讀；專案經理可新增／修改
create policy members_select on public.members for select to authenticated
  using (org_id = public.current_org_id());
create policy members_insert on public.members for insert to authenticated
  with check (org_id = public.current_org_id() and public.is_pm());
create policy members_update on public.members for update to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());

-- (i) 帳號：自己可讀自己（含停用狀態）；專案經理可讀寫本公司全部
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or (org_id = public.current_org_id() and public.is_pm()));
create policy profiles_update on public.profiles for update to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());

-- (j) 邀請：專案經理可看、可取消（新增請用 invite_member）
create policy inv_select on public.invitations for select to authenticated
  using (org_id = public.current_org_id() and public.is_pm());
create policy inv_update on public.invitations for update to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());

-- (k) 系統紀錄
create policy audit_select on public.audit_log for select to authenticated
  using (org_id = public.current_org_id() and public.is_pm());
create policy notif_select on public.notifications for select to authenticated
  using (org_id = public.current_org_id() and (public.is_pm() or recipient_id = public.current_member_id()));
create policy imports_select on public.imports for select to authenticated
  using (org_id = public.current_org_id() and public.is_leader_or_pm());
create policy imports_insert on public.imports for insert to authenticated
  with check (org_id = public.current_org_id() and public.is_leader_or_pm());
create policy backups_select on public.backups for select to authenticated
  using (org_id = public.current_org_id() and public.is_pm());
create policy sync_select on public.sync_status for select to authenticated
  using (org_id = public.current_org_id() and public.is_pm());

-- (l) 設定
create policy settings_select on public.system_settings for select to authenticated
  using (org_id = public.current_org_id());
create policy settings_write on public.system_settings for all to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());
create policy options_select on public.option_lists for select to authenticated
  using (org_id = public.current_org_id());
create policy options_write on public.option_lists for all to authenticated
  using (org_id = public.current_org_id() and public.is_pm())
  with check (org_id = public.current_org_id() and public.is_pm());
-- org_sequences：不開放任何直接存取

-- =====================================================================
-- 11. View（security_invoker：套用查詢者的 RLS，只會算到本公司）
-- =====================================================================
create view public.v_member_workload with (security_invoker = on) as
select
  m.org_id, m.member_id, m.name, m.project_role, m.department, m.status, m.weekly_hours, m.email,
  coalesce(a.week_hours, 0)                                         as allocated_hours_this_week,
  round(coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0), 4)   as workload_rate,
  m.weekly_hours - coalesce(a.week_hours, 0)                        as available_hours,
  coalesce(t.total, 0)       as task_count,
  coalesce(t.in_progress, 0) as in_progress_count,
  coalesce(t.done, 0)        as done_count,
  coalesce(t.overdue, 0)     as overdue_count,
  case
    when coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0)
         >= coalesce((select s.value::numeric from public.system_settings s where s.org_id = m.org_id and s.key = '工作負荷紅色門檻'), 1) then '紅'
    when coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0)
         >= coalesce((select s.value::numeric from public.system_settings s where s.org_id = m.org_id and s.key = '工作負荷黃色門檻'), 0.8) then '黃'
    else '綠'
  end as workload_light,
  m.last_report_at
from public.members m
left join (
  select org_id, member_id, sum(allocated_hours) as week_hours
  from public.hour_allocations
  where is_deleted = false
    and week_start = date_trunc('week', current_date)::date
    and coalesce(status, '') <> '已取消'
  group by org_id, member_id
) a on a.org_id = m.org_id and a.member_id = m.member_id
left join (
  select org_id, owner_id,
         count(*) as total,
         count(*) filter (where status = '進行中') as in_progress,
         count(*) filter (where status = '完成') as done,
         count(*) filter (where status not in ('完成','取消') and planned_end < current_date) as overdue
  from public.tasks
  where is_deleted = false
  group by org_id, owner_id
) t on t.org_id = m.org_id and t.owner_id = m.member_id
where m.is_deleted = false;

create view public.v_issues with (security_invoker = on) as
select i.*,
  case
    when i.status = '已解決' or i.due_date is null then 0
    else greatest(current_date - i.due_date, 0)
  end as overdue_days
from public.issues i
where i.is_deleted = false;

create view public.v_campaign_summary with (security_invoker = on) as
select
  c.org_id, c.campaign_id, c.project_id, c.name, c.status, c.owner_id, c.planned_start, c.planned_end,
  c.campaign_type, c.objective, c.target_audience, c.version,
  c.approved_budget,
  coalesce(e.actual, 0)                                          as actual_spend,
  coalesce(e.committed, 0)                                       as committed_spend,
  round(coalesce(e.actual, 0) / nullif(c.approved_budget, 0), 4) as budget_usage_rate,
  coalesce(p.impressions, 0) as impressions,
  coalesce(p.clicks, 0)      as clicks,
  coalesce(p.conversions, 0) as conversions,
  coalesce(p.revenue, 0)     as revenue,
  coalesce(p.ad_spend, 0)    as ad_spend,
  round(p.clicks::numeric / nullif(p.impressions, 0), 4) as ctr,
  round(p.revenue / nullif(p.ad_spend, 0), 2)            as roas,
  coalesce(t.task_count, 0)  as task_count,
  coalesce(t.overdue, 0)     as overdue_tasks,
  round(t.avg_progress, 4)   as avg_task_progress
from public.campaigns c
left join (
  select org_id, campaign_id, sum(actual_amount) as actual, sum(committed_amount) as committed
  from public.expenses where is_deleted = false group by org_id, campaign_id
) e on e.org_id = c.org_id and e.campaign_id = c.campaign_id
left join (
  select org_id, campaign_id, sum(impressions) as impressions, sum(clicks) as clicks,
         sum(conversions) as conversions, sum(revenue) as revenue, sum(ad_spend) as ad_spend
  from public.metrics where is_deleted = false group by org_id, campaign_id
) p on p.org_id = c.org_id and p.campaign_id = c.campaign_id
left join (
  select org_id, campaign_id, count(*) as task_count,
         count(*) filter (where status not in ('完成','取消') and planned_end < current_date) as overdue,
         avg(actual_progress) as avg_progress
  from public.tasks where is_deleted = false group by org_id, campaign_id
) t on t.org_id = c.org_id and t.campaign_id = c.campaign_id
where c.is_deleted = false;

create view public.v_project_overview with (security_invoker = on) as
select
  pj.org_id, pj.project_id, pj.name, pj.owner_name, pj.objective, pj.status, pj.start_date,
  pj.planned_end_date, pj.forecast_end_date, pj.total_budget, pj.version,
  round(avg(t.actual_progress), 4)   as overall_actual_progress,
  round(avg(t.planned_progress), 4)  as overall_planned_progress,
  round(avg(t.actual_progress) - avg(t.planned_progress), 4) as progress_gap,
  (select coalesce(sum(e.actual_amount), 0) from public.expenses e
     join public.campaigns c2 on c2.org_id = e.org_id and c2.campaign_id = e.campaign_id
    where c2.org_id = pj.org_id and c2.project_id = pj.project_id and e.is_deleted = false) as used_budget,
  count(t.*) filter (where t.status not in ('完成','取消'))                                 as open_tasks,
  count(t.*) filter (where t.status not in ('完成','取消') and t.planned_end < current_date) as overdue_tasks,
  (select count(*) from public.risks r
     join public.campaigns c3 on c3.org_id = r.org_id and c3.campaign_id = r.campaign_id
    where c3.org_id = pj.org_id and c3.project_id = pj.project_id and r.is_deleted = false
      and r.status <> '已結案' and r.risk_level = '高')                                    as high_risks,
  (select count(*) from public.issues i
     join public.tasks t2 on t2.org_id = i.org_id and t2.task_id = i.task_id
     join public.campaigns c4 on c4.org_id = t2.org_id and c4.campaign_id = t2.campaign_id
    where c4.org_id = pj.org_id and c4.project_id = pj.project_id and i.is_deleted = false
      and i.status <> '已解決')                                                            as open_issues,
  (select count(*) from public.campaigns c5
    where c5.org_id = pj.org_id and c5.project_id = pj.project_id and c5.is_deleted = false) as campaign_count
from public.projects pj
left join public.campaigns c on c.org_id = pj.org_id and c.project_id = pj.project_id and c.is_deleted = false
left join public.tasks t on t.org_id = c.org_id and t.campaign_id = c.campaign_id and t.is_deleted = false
where pj.is_deleted = false
group by pj.org_id, pj.project_id;

create view public.v_data_quality with (security_invoker = on) as
select '任務負責人不存在' as check_item, count(*) as problem_count
  from public.tasks t left join public.members m on m.org_id = t.org_id and m.member_id = t.owner_id
 where t.is_deleted = false and t.owner_id is not null and m.member_id is null
union all
select '任務預計完成早於開始', count(*) from public.tasks
 where is_deleted = false and planned_end < planned_start
union all
select '已完成但無實際完成日', count(*) from public.tasks
 where is_deleted = false and status = '完成' and actual_end is null
union all
select '任務未指定負責人', count(*) from public.tasks
 where is_deleted = false and owner_id is null and status not in ('完成','取消')
union all
select '活動支出超過核定預算', count(*) from public.v_campaign_summary
 where budget_usage_rate > 1
union all
select '在職組員尚未加入系統', count(*) from public.members m
 where m.is_deleted = false and m.status = '在職'
   and not exists (select 1 from public.profiles p where p.org_id = m.org_id and p.member_id = m.member_id);

-- =====================================================================
-- 12. 權限
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on public.org_sequences from authenticated;
grant execute on function
  public.current_org_id(), public.current_member_id(), public.current_app_role(),
  public.is_pm(), public.is_leader_or_pm(), public.is_authorized(), public.can_edit_task(text),
  public.create_organization(text, text, text, text),
  public.invite_member(text, text, text, text, text, numeric),
  public.claim_invitation(text), public.mark_password_changed(),
  public.touch_last_login(), public.get_my_profile()
to authenticated;
revoke execute on function public.seed_org_defaults(uuid) from public, anon, authenticated;
revoke all on all tables in schema public from anon;
