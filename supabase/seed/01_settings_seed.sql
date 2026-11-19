-- =====================================================================
-- 初始設定資料（來源：02 專案總覽、12 系統設定）
-- 在 SQL Editor 執行完 migration 之後再執行本檔
-- =====================================================================
set timezone to 'Asia/Taipei';

-- 02 專案總覽
insert into public.projects
  (project_id, name, owner_name, objective, start_date, planned_end_date,
   forecast_end_date, status, total_budget, schema_version, notes, created_by)
values
  ('PRJ-001',
   '品牌行銷成長專案｜2026秋冬整合行銷（模擬）',
   '林浚泓（模擬專案經理）',
   '【模擬】品牌曝光、會員招募、雙11轉換、KOL口碑與再行銷整合；所有數據僅供系統壓力測試',
   '2026-08-20', '2026-12-15', '2026-12-15', '進行中', 1200000,
   'schema-2.0-supabase',
   '全表模擬案例；不可作為實際行銷績效',
   'SYSTEM')
on conflict (project_id) do nothing;

-- 12 系統設定：參數（百分比統一存成小數）
insert into public.system_settings (key, value, description) values
  ('進度落後黃色門檻',     '0.10', '實際進度落後預計進度超過此比例 → 黃燈'),
  ('進度落後紅色門檻',     '0.20', '實際進度落後預計進度超過此比例 → 紅燈'),
  ('風險中級最低分',       '6',    '風險分數（機率×影響）達此分數 → 中'),
  ('風險高級最低分',       '15',   '風險分數達此分數 → 高'),
  ('未更新提醒天數',       '3',    '任務超過幾天未更新就提醒'),
  ('預算使用警戒比例',     '0.90', '活動支出達核定預算此比例 → 預警'),
  ('預警檢查間隔（小時）', '24',   'AI 預警自動檢查間隔'),
  ('工作負荷黃色門檻',     '0.8',  '本週分配工時 ÷ 可投入工時'),
  ('工作負荷紅色門檻',     '1',    '本週分配工時 ÷ 可投入工時'),
  ('未回報提醒天數',       '3',    '組員超過幾天未回報進度就提醒'),
  ('LINE每日摘要時間',     '21:00','每日預警摘要推播時間（只推給專案經理）')
on conflict (key) do update set value = excluded.value, description = excluded.description;

-- 12 系統設定：下拉選單
insert into public.option_lists (category, value, sort_order)
select category, value, ord
from (values
  ('專案狀態',     array['未開始','進行中','暫停','完成']),
  ('任務狀態',     array['未開始','進行中','阻塞','完成','取消']),
  ('優先級',       array['高','中','低']),
  ('風險類型',     array['進度','成本','人力','技術','品質','外部']),
  ('風險狀態',     array['待處理','處理中','已結案']),
  ('問題狀態',     array['待處理','處理中','已解決']),
  ('問題嚴重程度', array['高','中','低']),
  ('驗收狀態',     array['未驗收','驗收中','通過','未通過']),
  ('通知狀態',     array['待發送','成功','失敗']),
  ('預警處理狀態', array['待處理','處理中','已結案']),
  ('是否選項',     array['是','否']),
  ('專案角色',     array['專案經理','組長','組員','顧問','約聘']),
  ('人員狀態',     array['在職','暫停參與','已離開','被壓榨']),
  ('技能等級',     array['初階','中階','高階','專家']),
  ('工時分配狀態', array['已規劃','已確認','已取消'])
) as s(category, vals),
lateral unnest(vals) with ordinality as u(value, ord)
on conflict (category, value) do nothing;
