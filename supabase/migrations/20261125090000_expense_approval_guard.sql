-- =====================================================================
-- 支出審核權限：核准／駁回只能由專案經理執行
-- 原本 expenses 的 RLS 讓「組長」也能更新所有欄位，包含自己核准自己的申請。
-- 前端的「預算與支出」頁已分流，這裡用 trigger 在資料庫層強制執行。
-- auth.uid() 為 null（SQL Editor／service role 匯入）時不限制。
-- =====================================================================

create or replace function public.tg_guard_expense_review()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null or public.is_pm() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- 非專案經理新增時，一律視為待審核，不能直接寫入核准結果
    new.review_status := '待審核';
    new.approved_amount := 0;
    new.approver_id := null;
    new.approved_date := null;
    return new;
  end if;

  -- UPDATE：審核欄位不得由非專案經理變更
  if new.approved_amount is distinct from old.approved_amount
     or new.approver_id is distinct from old.approver_id
     or new.approved_date is distinct from old.approved_date then
    raise exception '只有專案經理可以核准或修改核准金額' using errcode = '42501';
  end if;

  if new.review_status is distinct from old.review_status then
    -- 只允許「已駁回 → 待審核」（修改後重新送審）
    if not (old.review_status = '已駁回' and new.review_status = '待審核') then
      raise exception '只有專案經理可以變更審核狀態' using errcode = '42501';
    end if;
  end if;

  -- 已核准的支出：非專案經理不得改項目、活動、申請金額或刪除
  if old.review_status = '已核准' and (
       new.item is distinct from old.item
    or new.campaign_id is distinct from old.campaign_id
    or new.requested_amount is distinct from old.requested_amount
    or new.is_deleted is distinct from old.is_deleted) then
    raise exception '支出已核准，只有專案經理可以修改項目、活動、金額或刪除' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_expense_review on public.expenses;
create trigger guard_expense_review before insert or update on public.expenses
  for each row execute function public.tg_guard_expense_review();

-- approvals 是審核軌跡，不應被改寫：只允許新增，不允許一般使用者更新或刪除
drop policy if exists approvals_update on public.approvals;
drop policy if exists approvals_delete on public.approvals;
