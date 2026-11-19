-- =====================================================================
-- 測試帳號只能由「系統管理者」在資料庫設定，網站上任何人（包含專案經理）都不能改
-- 設定方式（在 Supabase SQL Editor 執行）：
--   update public.profiles set is_test_account = true  where lower(email) = lower('測試帳號Email');
--   update public.profiles set is_test_account = false where lower(email) = lower('測試帳號Email');
-- =====================================================================
create or replace function public.tg_lock_test_flag()
returns trigger language plpgsql
as $$
begin
  -- auth.uid() 有值 = 從網站操作；SQL Editor 執行時為空值
  if auth.uid() is not null and new.is_test_account is distinct from old.is_test_account then
    raise exception '測試帳號只能由系統管理者在資料庫設定' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists lock_test_flag on public.profiles;
create trigger lock_test_flag before update on public.profiles
  for each row execute function public.tg_lock_test_flag();
