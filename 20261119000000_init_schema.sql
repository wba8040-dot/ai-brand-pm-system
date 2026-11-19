-- =====================================================================
-- AI 品牌行銷專案管理與成效預警系統：Supabase 初始資料庫結構
-- 對應原 Google 試算表 02～29 工作表
--   00 / 01 / 03 為前端畫面；30 / 31 改為 View（見本檔最後）
--   27 的密碼雜湊等欄位改由 Supabase Auth 處理，不再存於資料表
-- =====================================================================

-- 時區：讓匯入的「2026-11-12 09:00」這類時間以台灣時間解讀
alter database postgres set timezone to 'Asia/Taipei';
set timezone to 'Asia/Taipei';

-- =====================================================================
-- 1. 主檔：專案、組員、帳號
-- =====================================================================

-- 02 專案總覽（原本是「指標／數值」直式表，改為一列一個專案）
create table public.projects (
  project_id         text primary key,                 -- 專案ID（PRJ-001）
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
  deleted_by         text
);

-- 10 組員資訊（統計類欄位改由 v_member_workload 計算）
create table public.members (
  member_id            text primary key,               -- 組員ID（M006）
  name                 text not null,                  -- 組員姓名
  project_role         text not null default '組員',    -- 專案角色：專案經理／組長／組員…
  department           text,                           -- 所屬部門
  email                text unique,                    -- 電子郵件（登入帳號）
  contact              text,                           -- 聯絡方式
  join_date            date,                           -- 加入日期
  leave_date           date,                           -- 離開日期
  status               text default '在職',             -- 人員狀態
  skills               text,                           -- 專業技能
  skill_level          text,                           -- 技能等級
  weekly_hours         numeric(6,1) default 40,        -- 每週可投入工時
  last_report_at       timestamptz,                    -- 最後進度回報時間
  notes                text,                           -- 備註
  line_user_id         text unique,                    -- LINE接收身分識別
  leader_id            text references public.members(member_id), -- 直屬組長ID
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  created_by           text,
  updated_at           timestamptz not null default now(),
  updated_by           text,
  is_deleted           boolean not null default false,
  deleted_at           timestamptz,
  deleted_by           text
);

-- 27 使用者授權管理（對應 Supabase Auth 帳號）
create table public.profiles (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  member_id             text not null unique references public.members(member_id),
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
  updated_by            text
);

-- =====================================================================
-- 2. 行銷活動與任務
-- =====================================================================

-- 13 行銷活動管理
create table public.campaigns (
  campaign_id        text primary key,                 -- 活動ID（MKT-001）
  project_id         text references public.projects(project_id), -- 專案ID
  name               text not null,                    -- 活動名稱
  campaign_type      text,                             -- 活動類型
  objective          text,                             -- 活動目標
  target_audience    text,                             -- 目標受眾
  owner_id           text references public.members(member_id), -- 活動負責人ID
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
  deleted_by         text
);

-- 04 任務管理（進度一律存 0～1 的小數，例如 100% → 1）
create table public.tasks (
  task_id               text primary key,              -- 任務ID（T-MKT-001）
  name                  text not null,                 -- 任務名稱
  description           text,                          -- 任務說明
  owner_id              text references public.members(member_id), -- 負責人ID
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
  campaign_id           text references public.campaigns(campaign_id), -- 關聯活動ID
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
  deleted_by            text
);

-- 05 里程碑管理
create table public.milestones (
  milestone_id       text primary key,                 -- 里程碑ID
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
  campaign_id        text references public.campaigns(campaign_id), -- 關聯活動ID
  approval_id        text,                             -- 審核紀錄ID
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text
);

-- 06 進度更新紀錄
create table public.progress_updates (
  update_id          text primary key default ('U-' || to_char(now(),'YYYYMMDDHH24MISS') || '-' || substr(gen_random_uuid()::text,1,4)),
  task_id            text not null references public.tasks(task_id), -- 任務ID
  updated_time       timestamptz not null default now(), -- 更新時間
  progress_before    numeric(5,4),                     -- 更新前進度
  progress_after     numeric(5,4),                     -- 更新後進度
  done_items         text,                             -- 本次完成事項
  next_steps         text,                             -- 下一步工作
  difficulties       text,                             -- 遭遇困難
  remaining_hours    numeric(8,1),                     -- 預估剩餘工時
  updater_id         text references public.members(member_id), -- 更新人ID
  source             text default 'APP',               -- 更新來源
  created_at         timestamptz not null default now()
);

-- 17 任務協作成員
create table public.task_collaborators (
  collab_id          text primary key,                 -- 協作ID
  task_id            text not null references public.tasks(task_id),
  member_id          text not null references public.members(member_id),
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
  deleted_by         text
);

-- 18 子任務管理
create table public.subtasks (
  subtask_id         text primary key,                 -- 子任務ID
  parent_task_id     text not null references public.tasks(task_id), -- 父任務ID
  name               text not null,
  description        text,
  owner_id           text references public.members(member_id),
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
  deleted_by         text
);

-- 19 任務依賴關係
create table public.task_dependencies (
  dependency_id      text primary key,                 -- 依賴ID
  predecessor_id     text not null references public.tasks(task_id), -- 前置任務ID
  successor_id       text not null references public.tasks(task_id), -- 後續任務ID
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
  check (predecessor_id <> successor_id)
);

-- 11 工時分配紀錄
create table public.hour_allocations (
  allocation_id      text primary key,                 -- 分配ID
  member_id          text not null references public.members(member_id),
  task_id            text references public.tasks(task_id),
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
  deleted_by         text
);

-- =====================================================================
-- 3. 風險、問題、AI 預警
-- =====================================================================

-- 07 風險管理
create table public.risks (
  risk_id            text primary key,
  task_id            text references public.tasks(task_id),
  name               text not null,
  description        text,
  risk_type          text,                             -- 風險類型
  probability        smallint check (probability between 1 and 5), -- 發生機率
  impact             smallint check (impact between 1 and 5),      -- 影響程度
  risk_score         smallint generated always as (probability * impact) stored, -- 風險分數
  risk_level         text,                             -- 風險等級
  owner_id           text references public.members(member_id), -- 風險負責人
  response_plan      text,                             -- 應對措施
  response_due       date,                             -- 應對期限
  status             text default '待處理',             -- 風險狀態
  last_assessed      date,                             -- 最後評估日期
  notes              text,
  campaign_id        text references public.campaigns(campaign_id),
  version            integer not null default 1,
  created_at         timestamptz not null default now(),
  created_by         text,
  updated_at         timestamptz not null default now(),
  updated_by         text,
  is_deleted         boolean not null default false,
  deleted_at         timestamptz,
  deleted_by         text
);

-- 08 問題追蹤（逾期天數改由 View 即時計算）
create table public.issues (
  issue_id           text primary key,
  task_id            text references public.tasks(task_id),
  name               text not null,
  description        text,
  severity           text,                             -- 嚴重程度
  found_date         date,                             -- 發現日期
  owner_id           text references public.members(member_id), -- 問題負責人
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
  deleted_by         text
);

-- 29 AI分析執行紀錄（先建，09 會參照）
create table public.ai_runs (
  run_id             text primary key,                 -- 執行ID
  alert_id           text,                             -- 關聯預警ID
  provider           text,                             -- 模型供應商（Google Gemini）
  model              text,                             -- 模型代碼
  run_at             timestamptz default now(),        -- 執行時間
  status             text,                             -- 分析狀態
  input_hash         text,                             -- 輸入摘要雜湊
  output_summary     text,                             -- 輸出摘要
  error_code         text,                             -- 錯誤代碼
  duration_ms        integer,                          -- 處理時間（毫秒）
  estimated_cost     numeric(10,4) default 0           -- 估算費用
);

-- 09 AI預警紀錄
create table public.ai_alerts (
  alert_id           text primary key,                 -- 預警ID
  task_id            text references public.tasks(task_id),
  alert_time         timestamptz not null default now(), -- 預警時間
  alert_type         text,                             -- 預警類型
  alert_level        text,                             -- 預警等級
  trigger_condition  text,                             -- 觸發條件
  evidence           text,                             -- 依據資料
  ai_summary         text,                             -- AI分析摘要
  ai_suggestion      text,                             -- AI建議措施
  suggested_due      date,                             -- 建議處理期限
  notify_member_id   text references public.members(member_id), -- 通知對象
  notify_status      text default '待發送',             -- 通知狀態
  handle_status      text default '待處理',             -- 處理狀態
  handler_id         text references public.members(member_id), -- 處理負責人
  handle_result      text,                             -- 處理結果
  closed_at          timestamptz,                      -- 結案時間
  campaign_id        text references public.campaigns(campaign_id),
  rule_code          text,                             -- 規則代碼（MKT07）
  ai_run_id          text references public.ai_runs(run_id), -- AI執行ID
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
  deleted_by         text
);

-- =====================================================================
-- 4. 行銷內容、成效、預算、KPI
-- =====================================================================

-- 14 內容發布排程
create table public.contents (
  content_id         text primary key,
  campaign_id        text references public.campaigns(campaign_id),
  task_id            text references public.tasks(task_id),
  title              text not null,
  content_type       text,                             -- 內容類型
  platform           text,                             -- 發布平台
  summary            text,
  asset_url          text,                             -- 素材連結
  owner_id           text references public.members(member_id),
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
  deleted_by         text
);

-- 15 行銷成效紀錄（CTR、CPC、CPA、ROAS、互動率自動計算）
create table public.metrics (
  metric_id          text primary key,                 -- 成效ID
  campaign_id        text references public.campaigns(campaign_id),
  content_id         text references public.contents(content_id),
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
  deleted_by         text
);

-- 16 行銷預算管理
create table public.expenses (
  expense_id         text primary key,                 -- 支出ID
  campaign_id        text references public.campaigns(campaign_id),
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
  deleted_by         text
);

-- 22 行銷KPI設定
create table public.kpis (
  kpi_id             text primary key,                 -- KPI設定ID
  campaign_id        text references public.campaigns(campaign_id),
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
  deleted_by         text
);

-- =====================================================================
-- 5. 審核、附件、系統紀錄
-- =====================================================================

-- 20 審核紀錄
create table public.approvals (
  approval_id        text primary key,
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
  created_at         timestamptz not null default now()
);

-- 21 附件索引（之後可改用 Supabase Storage）
create table public.attachments (
  attachment_id      text primary key,
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
  deleted_by         text
);

-- 23 資料異動紀錄（由 trigger 自動寫入）
create table public.audit_log (
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
  notification_id    text primary key default ('NTF-' || substr(gen_random_uuid()::text,1,8)),
  event_type         text,
  related_id         text,
  recipient_id       text references public.members(member_id),
  channel            text,                             -- LINE／Email
  summary            text,
  send_status        text default '待發送',
  attempts           integer default 0,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz,
  error_code         text
);

-- 25 資料匯入紀錄
create table public.imports (
  import_id          text primary key,
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
  error_summary      text
);

-- 26 系統備份紀錄
create table public.backups (
  backup_id          text primary key,
  backup_type        text,
  drive_file_id      text,
  started_at         timestamptz,
  finished_at        timestamptz,
  status             text,
  file_hash          text,
  retain_until       date,
  restore_test       text,
  message            text
);

-- 28 資料同步狀態（改記錄 Supabase → 試算表的同步）
create table public.sync_status (
  sync_id            text primary key,
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
  updated_at         timestamptz not null default now()
);

-- 12 系統設定：參數
create table public.system_settings (
  key                text primary key,                 -- 設定參數
  value              text not null,                    -- 參數值
  description        text,
  updated_at         timestamptz not null default now(),
  updated_by         text
);

-- 12 系統設定：下拉選單
create table public.option_lists (
  category           text not null,                    -- 例如「任務狀態」
  value              text not null,
  sort_order         integer not null default 0,
  is_active          boolean not null default true,
  primary key (category, value)
);

-- =====================================================================
-- 6. 索引
-- =====================================================================
create index on public.tasks (owner_id);
create index on public.tasks (campaign_id);
create index on public.tasks (status);
create index on public.tasks (planned_end);
create index on public.milestones (campaign_id);
create index on public.progress_updates (task_id, updated_time desc);
create index on public.task_collaborators (task_id);
create index on public.task_collaborators (member_id);
create index on public.subtasks (parent_task_id);
create index on public.task_dependencies (successor_id);
create index on public.hour_allocations (member_id, week_start);
create index on public.risks (task_id);
create index on public.issues (task_id);
create index on public.ai_alerts (task_id);
create index on public.ai_alerts (handle_status, alert_time desc);
create index on public.contents (campaign_id);
create index on public.metrics (campaign_id, data_date);
create index on public.expenses (campaign_id);
create index on public.kpis (campaign_id);
create index on public.audit_log (table_name, record_id);
create index on public.audit_log (created_at desc);
create index on public.members (leader_id);

-- =====================================================================
-- 7. 身分與權限輔助函式
-- =====================================================================

-- 目前登入者的組員ID（未授權回傳 null）
create or replace function public.current_member_id()
returns text
language sql stable security definer set search_path = public
as $$
  select member_id from public.profiles
  where user_id = auth.uid() and auth_status = '已授權'
$$;

-- 目前登入者的角色
create or replace function public.current_app_role()
returns text
language sql stable security definer set search_path = public
as $$
  select role from public.profiles
  where user_id = auth.uid() and auth_status = '已授權'
$$;

create or replace function public.is_pm()
returns boolean language sql stable
as $$ select coalesce(public.current_app_role() = '專案經理', false) $$;

create or replace function public.is_leader_or_pm()
returns boolean language sql stable
as $$ select coalesce(public.current_app_role() in ('專案經理','組長'), false) $$;

create or replace function public.is_authorized()
returns boolean language sql stable
as $$ select public.current_member_id() is not null $$;

-- 是否可編輯這個任務：專案經理全部可；組長可改自己或直屬組員的；組員可改自己負責或協作的
create or replace function public.can_edit_task(p_task_id text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.is_pm() then true
    when public.current_member_id() is null then false
    else exists (
      select 1 from public.tasks t
      left join public.members m on m.member_id = t.owner_id
      where t.task_id = p_task_id
        and (
          t.owner_id = public.current_member_id()
          or (public.current_app_role() = '組長' and m.leader_id = public.current_member_id())
          or exists (
            select 1 from public.task_collaborators c
            where c.task_id = t.task_id
              and c.member_id = public.current_member_id()
              and c.is_deleted = false and c.status = '有效'
          )
        )
    )
  end
$$;

-- =====================================================================
-- 8. 觸發器：自動更新時間、版本號（樂觀鎖）、稽核紀錄
-- =====================================================================

-- 更新時：版本 +1、更新時間、更新人
-- 前端更新時請加上 .eq('version', 目前版本)，若回傳 0 筆代表別人已先修改
create or replace function public.tg_touch_row()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
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

-- profiles 沒有軟刪除欄位，另寫一個
create or replace function public.tg_touch_profile()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.version := coalesce(old.version, 0) + 1;
  end if;
  new.updated_by := coalesce(public.current_member_id(), new.updated_by);
  return new;
end;
$$;

-- 稽核：第一個參數是主鍵欄位名稱
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
      return new;  -- 沒有實質變更就不記錄
    end if;
  end if;

  v_action := case
    when tg_op = 'INSERT' then '新增'
    when tg_op = 'DELETE' then '刪除'
    when (v_new ->> 'is_deleted') = 'true' and (v_old ->> 'is_deleted') = 'false' then '軟刪除'
    else '修改'
  end;

  insert into public.audit_log
    (table_name, record_id, action, changed_fields, old_data, new_data,
     actor_id, source, old_version, new_version)
  values
    (tg_table_name,
     coalesce(v_new ->> v_pk, v_old ->> v_pk),
     v_action, v_fields,
     -- 不記錄任何密碼相關內容
     v_old, v_new,
     public.current_member_id(),
     case when auth.uid() is null then 'SYSTEM' else 'APP' end,
     (v_old ->> 'version')::int, (v_new ->> 'version')::int);

  return coalesce(new, old);
end;
$$;

-- 套用到所有業務資料表
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('projects','project_id'), ('members','member_id'), ('campaigns','campaign_id'),
      ('tasks','task_id'), ('milestones','milestone_id'), ('task_collaborators','collab_id'),
      ('subtasks','subtask_id'), ('task_dependencies','dependency_id'),
      ('hour_allocations','allocation_id'), ('risks','risk_id'), ('issues','issue_id'),
      ('ai_alerts','alert_id'), ('contents','content_id'), ('metrics','metric_id'),
      ('expenses','expense_id'), ('kpis','kpi_id'), ('attachments','attachment_id')
    ) as t(tbl, pk)
  loop
    execute format(
      'create trigger touch_row before insert or update on public.%I
         for each row execute function public.tg_touch_row()', r.tbl);
    execute format(
      'create trigger audit_row after insert or update or delete on public.%I
         for each row execute function public.tg_audit(%L)', r.tbl, r.pk);
  end loop;
end $$;

create trigger touch_profile before insert or update on public.profiles
  for each row execute function public.tg_touch_profile();
create trigger audit_profile after insert or update or delete on public.profiles
  for each row execute function public.tg_audit('member_id');

-- =====================================================================
-- 9. 帳號：建立 Auth 使用者時自動建立 profile
--    （Email 必須已存在於 members，角色取自 members.project_role）
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  m public.members%rowtype;
begin
  select * into m from public.members
  where lower(email) = lower(new.email) and is_deleted = false
  limit 1;

  if found then
    insert into public.profiles (user_id, member_id, email, role, must_change_password, created_by)
    values (
      new.id, m.member_id, new.email,
      case when m.project_role in ('專案經理','組長') then m.project_role else '組員' end,
      true, 'SYSTEM')
    on conflict (member_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 首次登入改完密碼後，前端呼叫：supabase.rpc('mark_password_changed')
create or replace function public.mark_password_changed()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles
     set must_change_password = false,
         password_updated_at = now()
   where user_id = auth.uid()
$$;

-- 登入成功後，前端呼叫：supabase.rpc('touch_last_login')
create or replace function public.touch_last_login()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles set last_login_at = now() where user_id = auth.uid()
$$;

-- 取得自己的身分資訊（左上角使用者卡片用）
create or replace function public.get_my_profile()
returns table (member_id text, name text, email text, role text,
               department text, must_change_password boolean, line_bound boolean)
language sql stable security definer set search_path = public
as $$
  select p.member_id, m.name, p.email, p.role, m.department,
         p.must_change_password, (m.line_user_id is not null)
  from public.profiles p
  join public.members m on m.member_id = p.member_id
  where p.user_id = auth.uid() and p.auth_status = '已授權'
$$;

-- =====================================================================
-- 10. Row Level Security（RLS）
--     Edge Functions 使用 service_role 金鑰，會略過 RLS
-- =====================================================================

-- 全部開啟 RLS
do $$
declare t text;
begin
  foreach t in array array[
    'projects','members','profiles','campaigns','tasks','milestones','progress_updates',
    'task_collaborators','subtasks','task_dependencies','hour_allocations','risks','issues',
    'ai_runs','ai_alerts','contents','metrics','expenses','kpis','approvals','attachments',
    'audit_log','notifications','imports','backups','sync_status','system_settings','option_lists'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- (a) 一般業務資料：已授權者可讀；專案經理、組長可新增／修改；只有專案經理可實體刪除
do $$
declare t text;
begin
  foreach t in array array[
    'projects','campaigns','milestones','task_dependencies','risks','issues',
    'contents','metrics','expenses','kpis','approvals','attachments'
  ] loop
    execute format('create policy "%1$s_select" on public.%1$I for select to authenticated using (public.is_authorized())', t);
    execute format('create policy "%1$s_insert" on public.%1$I for insert to authenticated with check (public.is_leader_or_pm())', t);
    execute format('create policy "%1$s_update" on public.%1$I for update to authenticated using (public.is_leader_or_pm()) with check (public.is_leader_or_pm())', t);
    execute format('create policy "%1$s_delete" on public.%1$I for delete to authenticated using (public.is_pm())', t);
  end loop;
end $$;

-- (b) 任務：依 can_edit_task 判斷
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_authorized());
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_leader_or_pm());
create policy tasks_update on public.tasks for update to authenticated
  using (public.can_edit_task(task_id)) with check (public.can_edit_task(task_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_pm());

-- 組員不可自行更改負責人、權重、主管覆寫進度等欄位
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

-- (c) 子任務：可編輯父任務者可編輯；自己負責的子任務也可編輯
create policy subtasks_select on public.subtasks for select to authenticated
  using (public.is_authorized());
create policy subtasks_insert on public.subtasks for insert to authenticated
  with check (public.can_edit_task(parent_task_id));
create policy subtasks_update on public.subtasks for update to authenticated
  using (public.can_edit_task(parent_task_id) or owner_id = public.current_member_id())
  with check (public.can_edit_task(parent_task_id) or owner_id = public.current_member_id());
create policy subtasks_delete on public.subtasks for delete to authenticated
  using (public.is_pm());

-- (d) 進度回報：可編輯該任務者可新增，且更新人必須是自己；紀錄不可修改
create policy progress_select on public.progress_updates for select to authenticated
  using (public.is_authorized());
create policy progress_insert on public.progress_updates for insert to authenticated
  with check (public.can_edit_task(task_id) and updater_id = public.current_member_id());

-- (e) 協作成員：專案經理、組長管理
create policy collab_select on public.task_collaborators for select to authenticated
  using (public.is_authorized());
create policy collab_write on public.task_collaborators for all to authenticated
  using (public.is_leader_or_pm()) with check (public.is_leader_or_pm());

-- (f) 工時分配：專案經理、組長管理；組員可回填自己的實際工時
create policy alloc_select on public.hour_allocations for select to authenticated
  using (public.is_authorized());
create policy alloc_insert on public.hour_allocations for insert to authenticated
  with check (public.is_leader_or_pm());
create policy alloc_update on public.hour_allocations for update to authenticated
  using (public.is_leader_or_pm() or member_id = public.current_member_id())
  with check (public.is_leader_or_pm() or member_id = public.current_member_id());
create policy alloc_delete on public.hour_allocations for delete to authenticated
  using (public.is_pm());

-- (g) AI 預警：所有人可讀；處理負責人、組長、專案經理可更新處理狀態；新增由 Edge Function 負責
create policy alerts_select on public.ai_alerts for select to authenticated
  using (public.is_authorized());
create policy alerts_update on public.ai_alerts for update to authenticated
  using (public.is_leader_or_pm() or handler_id = public.current_member_id())
  with check (public.is_leader_or_pm() or handler_id = public.current_member_id());

create policy ai_runs_select on public.ai_runs for select to authenticated
  using (public.is_leader_or_pm());

-- (h) 組員資料：所有人可讀；只有專案經理可新增／修改（含 LINE 綁定）
create policy members_select on public.members for select to authenticated
  using (public.is_authorized());
create policy members_write on public.members for all to authenticated
  using (public.is_pm()) with check (public.is_pm());

-- (i) 帳號：自己可讀自己；專案經理可讀寫全部
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_pm());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_pm()) with check (public.is_pm());

-- (j) 系統紀錄：只有專案經理可讀，寫入由 trigger 或 Edge Function 負責
create policy audit_select on public.audit_log for select to authenticated using (public.is_pm());
create policy notif_select on public.notifications for select to authenticated
  using (public.is_pm() or recipient_id = public.current_member_id());
create policy imports_select on public.imports for select to authenticated using (public.is_leader_or_pm());
create policy imports_insert on public.imports for insert to authenticated with check (public.is_leader_or_pm());
create policy backups_select on public.backups for select to authenticated using (public.is_pm());
create policy sync_select on public.sync_status for select to authenticated using (public.is_pm());

-- (k) 系統設定：所有人可讀，只有專案經理可改
create policy settings_select on public.system_settings for select to authenticated using (public.is_authorized());
create policy settings_write on public.system_settings for all to authenticated
  using (public.is_pm()) with check (public.is_pm());
create policy options_select on public.option_lists for select to authenticated using (public.is_authorized());
create policy options_write on public.option_lists for all to authenticated
  using (public.is_pm()) with check (public.is_pm());

-- =====================================================================
-- 11. View：取代試算表的計算欄位與總覽表
--     security_invoker = on：View 會套用查詢者本身的 RLS
-- =====================================================================

-- 10 組員資訊的統計欄位（工作負荷）
create view public.v_member_workload with (security_invoker = on) as
select
  m.member_id, m.name, m.project_role, m.department, m.status, m.weekly_hours,
  coalesce(a.week_hours, 0)                                         as allocated_hours_this_week,
  round(coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0), 4)   as workload_rate,
  m.weekly_hours - coalesce(a.week_hours, 0)                        as available_hours,
  coalesce(t.total, 0)       as task_count,
  coalesce(t.in_progress, 0) as in_progress_count,
  coalesce(t.done, 0)        as done_count,
  coalesce(t.overdue, 0)     as overdue_count,
  case
    when coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0)
         >= (select value::numeric from public.system_settings where key = '工作負荷紅色門檻') then '紅'
    when coalesce(a.week_hours, 0) / nullif(m.weekly_hours, 0)
         >= (select value::numeric from public.system_settings where key = '工作負荷黃色門檻') then '黃'
    else '綠'
  end as workload_light,
  m.last_report_at
from public.members m
left join (
  select member_id, sum(allocated_hours) as week_hours
  from public.hour_allocations
  where is_deleted = false
    and week_start = date_trunc('week', current_date)::date
    and coalesce(status, '') <> '已取消'
  group by member_id
) a on a.member_id = m.member_id
left join (
  select owner_id,
         count(*) as total,
         count(*) filter (where status = '進行中') as in_progress,
         count(*) filter (where status = '完成') as done,
         count(*) filter (where status not in ('完成','取消') and planned_end < current_date) as overdue
  from public.tasks
  where is_deleted = false
  group by owner_id
) t on t.owner_id = m.member_id
where m.is_deleted = false;

-- 08 問題追蹤：即時計算逾期天數
create view public.v_issues with (security_invoker = on) as
select i.*,
  case
    when i.status = '已解決' or i.due_date is null then 0
    else greatest(current_date - i.due_date, 0)
  end as overdue_days
from public.issues i
where i.is_deleted = false;

-- 31 活動績效與預算總覽
create view public.v_campaign_summary with (security_invoker = on) as
select
  c.campaign_id, c.name, c.status, c.owner_id, c.planned_start, c.planned_end,
  c.approved_budget,
  coalesce(e.actual, 0)                                       as actual_spend,
  coalesce(e.committed, 0)                                    as committed_spend,
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
  select campaign_id, sum(actual_amount) as actual, sum(committed_amount) as committed
  from public.expenses where is_deleted = false group by campaign_id
) e on e.campaign_id = c.campaign_id
left join (
  select campaign_id, sum(impressions) as impressions, sum(clicks) as clicks,
         sum(conversions) as conversions, sum(revenue) as revenue, sum(ad_spend) as ad_spend
  from public.metrics where is_deleted = false group by campaign_id
) p on p.campaign_id = c.campaign_id
left join (
  select campaign_id, count(*) as task_count,
         count(*) filter (where status not in ('完成','取消') and planned_end < current_date) as overdue,
         avg(actual_progress) as avg_progress
  from public.tasks where is_deleted = false group by campaign_id
) t on t.campaign_id = c.campaign_id
where c.is_deleted = false;

-- 02 專案總覽的計算指標（整體進度、預算、逾期、風險、健康燈號）
create view public.v_project_overview with (security_invoker = on) as
select
  pj.project_id, pj.name, pj.owner_name, pj.status, pj.start_date,
  pj.planned_end_date, pj.forecast_end_date, pj.total_budget,
  round(avg(t.actual_progress), 4)   as overall_actual_progress,
  round(avg(t.planned_progress), 4)  as overall_planned_progress,
  round(avg(t.actual_progress) - avg(t.planned_progress), 4) as progress_gap,
  (select coalesce(sum(e.actual_amount), 0) from public.expenses e
     join public.campaigns c2 on c2.campaign_id = e.campaign_id
    where c2.project_id = pj.project_id and e.is_deleted = false)  as used_budget,
  count(t.*) filter (where t.status not in ('完成','取消'))          as open_tasks,
  count(t.*) filter (where t.status not in ('完成','取消') and t.planned_end < current_date) as overdue_tasks,
  (select count(*) from public.risks r
     join public.campaigns c3 on c3.campaign_id = r.campaign_id
    where c3.project_id = pj.project_id and r.is_deleted = false
      and r.status <> '已結案' and r.risk_level = '高')              as high_risks,
  (select count(*) from public.issues i
     join public.tasks t2 on t2.task_id = i.task_id
     join public.campaigns c4 on c4.campaign_id = t2.campaign_id
    where c4.project_id = pj.project_id and i.is_deleted = false
      and i.status <> '已解決')                                      as open_issues
from public.projects pj
left join public.campaigns c on c.project_id = pj.project_id and c.is_deleted = false
left join public.tasks t on t.campaign_id = c.campaign_id and t.is_deleted = false
where pj.is_deleted = false
group by pj.project_id;

-- 30 模擬資料品質檢核
create view public.v_data_quality with (security_invoker = on) as
select '任務負責人不存在' as check_item, count(*) as problem_count
  from public.tasks t left join public.members m on m.member_id = t.owner_id
 where t.is_deleted = false and t.owner_id is not null and m.member_id is null
union all
select '任務預計完成早於開始', count(*) from public.tasks
 where is_deleted = false and planned_end < planned_start
union all
select '進度超出 0～100%', count(*) from public.tasks
 where is_deleted = false and (actual_progress < 0 or actual_progress > 1)
union all
select '已完成但無實際完成日', count(*) from public.tasks
 where is_deleted = false and status = '完成' and actual_end is null
union all
select '活動支出超過核定預算', count(*) from public.v_campaign_summary
 where budget_usage_rate > 1
union all
select '組員未建立登入帳號', count(*) from public.members m
 where m.is_deleted = false and m.status = '在職'
   and not exists (select 1 from public.profiles p where p.member_id = m.member_id);

-- =====================================================================
-- 12. 權限：讓前端（authenticated）可以使用上面的函式與 View
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.v_member_workload, public.v_issues, public.v_campaign_summary,
               public.v_project_overview, public.v_data_quality to authenticated;
grant execute on function public.current_member_id(), public.current_app_role(),
  public.is_pm(), public.is_leader_or_pm(), public.is_authorized(),
  public.can_edit_task(text), public.mark_password_changed(),
  public.touch_last_login(), public.get_my_profile() to authenticated;

-- 未登入者（anon）不給任何資料表權限
revoke all on all tables in schema public from anon;
