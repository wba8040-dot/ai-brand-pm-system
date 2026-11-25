-- =====================================================================
-- 安全強化（2026-11-26 安全審查）
--   1. 邀請碼：失敗次數節流（15 分鐘內失敗 10 次即鎖定）、個人邀請碼不再開放直接呼叫
--   2. 專案邀請碼核准：一律建立為「組員」，不得沿用舊成員資料中的「專案經理／組長」
--   3. 函式 EXECUTE 權限：收回 public／anon；trigger 函式不開放給任何 API 角色
--   4. 資料表權限：收回 anon 全部權限，以及 authenticated 的 TRUNCATE／REFERENCES／TRIGGER
--   5. 支出審核：非專案經理不得鎖定欄位（committed_amount、expense_id）、
--      不得在核准前登錄實際支出／付款；approvals 的「審核結果」只能由專案經理寫入，
--      且審核者、審核時間由資料庫填寫，不可偽造
--   6. tg_auto_code：不再允許寫入其他公司的流水號，且前端自帶的編號只允許安全字元
--
-- 本檔只新增／取代函式與權限，不刪除任何資料，可重複執行。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 邀請碼失敗次數節流
--    （失敗要「回傳空結果」而不是丟例外，否則交易回復、失敗紀錄也會一起消失）
-- ---------------------------------------------------------------------
create table if not exists public.join_code_attempts (
  attempt_id   bigint generated always as identity primary key,
  user_id      uuid not null,
  attempted_at timestamptz not null default now()
);
create index if not exists join_code_attempts_user_time on public.join_code_attempts (user_id, attempted_at desc);
alter table public.join_code_attempts enable row level security;   -- 不建立任何 policy：API 不能直接存取
revoke all on table public.join_code_attempts from public, anon, authenticated;

create or replace function public.join_code_throttle()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if (select count(*) from public.join_code_attempts
       where user_id = auth.uid() and attempted_at > now() - interval '15 minutes') >= 10 then
    raise exception '邀請碼嘗試次數過多，請 15 分鐘後再試';
  end if;
end;
$$;

create or replace function public.join_code_fail()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.join_code_attempts
   where user_id = auth.uid() and attempted_at < now() - interval '1 day';
  insert into public.join_code_attempts (user_id) values (auth.uid());
end;
$$;
revoke all on function public.join_code_throttle(), public.join_code_fail() from public, anon, authenticated;

-- 預覽：錯誤時回傳空結果（前端已把「沒有資料」視為邀請碼錯誤）
create or replace function public.preview_join_code(p_code text)
returns table (kind text, org_name text, project_name text)
language plpgsql security definer set search_path = public
as $$
declare
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_email text;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  perform public.join_code_throttle();
  select lower(email) into v_email from auth.users where id = auth.uid();

  return query
    select 'personal'::text, o.name, null::text
      from public.invitations i join public.organizations o on o.org_id = i.org_id and o.status = 'active'
     where upper(i.invite_code) = v_code and lower(i.email) = v_email
       and i.status = '待接受' and i.expires_at > now()
     limit 1;
  if found then return; end if;

  return query
    select 'project'::text, o.name, p.name
      from public.project_invites pi
      join public.projects p on p.org_id = pi.org_id and p.project_id = pi.project_id and not p.is_deleted
      join public.organizations o on o.org_id = pi.org_id and o.status = 'active'
     where pi.invite_code = v_code and pi.is_enabled
     limit 1;
  if found then return; end if;

  perform public.join_code_fail();
  return;
end;
$$;

-- 加入：邀請碼錯誤時回傳空結果並記錄失敗（前端需處理空結果）
create or replace function public.join_with_code(p_code text, p_name text default null, p_department text default null)
returns table (status text, org_name text, project_name text)
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_email text;
  v_pi    public.project_invites%rowtype;
  v_org   text;
  v_prj   text;
begin
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where user_id = v_uid) then
    raise exception '此帳號已加入公司';
  end if;
  perform public.join_code_throttle();
  select lower(email) into v_email from auth.users where id = v_uid;

  -- (1) 個人邀請碼：沿用原本流程
  if exists (select 1 from public.invitations i
              where upper(i.invite_code) = v_code and lower(i.email) = v_email
                and i.status = '待接受' and i.expires_at > now()) then
    return query select '已加入'::text, public.claim_invitation(v_code), null::text;
    return;
  end if;

  -- (2) 專案共用碼
  select pi.* into v_pi from public.project_invites pi
    join public.projects p on p.org_id = pi.org_id and p.project_id = pi.project_id and not p.is_deleted
    join public.organizations o on o.org_id = pi.org_id and o.status = 'active'
   where pi.invite_code = v_code and pi.is_enabled;
  if not found then
    perform public.join_code_fail();
    return;
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception '請填寫你的姓名';
  end if;
  if length(btrim(p_name)) > 40 or length(coalesce(btrim(p_department), '')) > 40 then
    raise exception '姓名或部門太長（最多 40 字）';
  end if;
  if exists (select 1 from public.join_requests r where r.user_id = v_uid and r.status = '待審核') then
    raise exception '你已有一張審核中的申請，請等待專案經理核准，或先取消原申請';
  end if;

  insert into public.join_requests (org_id, project_id, user_id, email, name, department)
  values (v_pi.org_id, v_pi.project_id, v_uid, v_email, btrim(p_name), nullif(btrim(p_department), ''));

  select o.name into v_org from public.organizations o where o.org_id = v_pi.org_id;
  select p.name into v_prj from public.projects p where p.org_id = v_pi.org_id and p.project_id = v_pi.project_id;
  return query select '待審核'::text, v_org, v_prj;
end;
$$;

-- claim_invitation 只供 join_with_code 內部呼叫（失敗會丟例外，無法節流），不再開放 API 直接呼叫
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

  select i.* into v_inv from public.invitations i
    join public.organizations o on o.org_id = i.org_id and o.status = 'active'
   where lower(i.email) = v_email and i.status = '待接受'
     and upper(i.invite_code) = upper(btrim(p_code)) and i.expires_at > now()
   limit 1
   for update of i;
  if not found then
    raise exception '邀請碼錯誤、已過期，或與登入的 Email 不符';
  end if;
  if exists (select 1 from public.profiles p where p.org_id = v_inv.org_id and p.member_id = v_inv.member_id) then
    raise exception '這個成員資料已被其他帳號使用，請向專案經理確認';
  end if;

  insert into public.profiles (org_id, user_id, member_id, email, role, auth_status, must_change_password, created_by)
  values (v_inv.org_id, v_uid, v_inv.member_id, v_email, v_inv.role, '已授權', false, 'SYSTEM');

  update public.invitations set status = '已接受', accepted_at = now()
   where invitation_id = v_inv.invitation_id;

  select name into v_name from public.organizations where org_id = v_inv.org_id;
  return v_name;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. 專案邀請碼核准：一律「組員」
--    原本會沿用同 Email 舊成員資料的 project_role，若舊資料是專案經理，
--    用專案共用碼申請的人就會被核准成專案經理。
-- ---------------------------------------------------------------------
create or replace function public.decide_join_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid := public.current_org_id();
  v_me  text := public.current_member_id();
  v_r   public.join_requests%rowtype;
  v_mid text;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以審核申請' using errcode = '42501';
  end if;
  select * into v_r from public.join_requests r
   where r.request_id = p_request_id and r.org_id = v_org
   for update;
  if not found then
    raise exception '找不到這張申請';
  end if;
  if v_r.status <> '待審核' then
    raise exception '這張申請已經處理過了（%）', v_r.status;
  end if;

  if not coalesce(p_approve, false) then
    update public.join_requests r set status = '已拒絕', decided_by = v_me, decided_at = now(),
           decision_note = v_note
     where r.request_id = p_request_id;
    return null;
  end if;

  if exists (select 1 from public.profiles p where p.user_id = v_r.user_id) then
    update public.join_requests r set status = '已取消', decided_by = v_me, decided_at = now(),
           decision_note = '此帳號已加入其他公司'
     where r.request_id = p_request_id;
    raise exception '此帳號已經加入公司（可能用了其他邀請），申請已自動取消';
  end if;

  -- 同公司已有同 Email、尚未綁帳號的組員資料就沿用（角色一律降為「組員」）
  select m.member_id into v_mid from public.members m
   where m.org_id = v_org and lower(m.email) = lower(v_r.email)
     and not exists (select 1 from public.profiles p where p.org_id = m.org_id and p.member_id = m.member_id)
   limit 1;

  if v_mid is null then
    insert into public.members (org_id, name, project_role, department, email, join_date, status, created_by)
    values (v_org, v_r.name, '組員', v_r.department, v_r.email, current_date, '在職', v_me)
    returning members.member_id into v_mid;
  else
    update public.members m set is_deleted = false, status = '在職', project_role = '組員',
           department = coalesce(m.department, v_r.department)
     where m.org_id = v_org and m.member_id = v_mid;
  end if;

  insert into public.profiles (org_id, user_id, member_id, email, role, auth_status, must_change_password,
                               authorized_by, authorized_at, created_by)
  values (v_org, v_r.user_id, v_mid, v_r.email, '組員', '已授權', false, v_me, now(), v_me);

  insert into public.project_members (org_id, project_id, member_id, added_by)
  values (v_org, v_r.project_id, v_mid, v_me)
  on conflict do nothing;

  update public.invitations i set status = '已取消'
   where lower(i.email) = lower(v_r.email) and i.status = '待接受';

  update public.join_requests r set status = '已核准', member_id = v_mid, decided_by = v_me, decided_at = now(),
         decision_note = v_note
   where r.request_id = p_request_id;
  return v_mid;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. 自動編號：禁止碰別家公司的流水號；前端自帶的編號只允許安全字元
--    （編號會被放進 HTML 屬性，限制字元可擋掉儲存型 XSS）
-- ---------------------------------------------------------------------
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
  -- 從網站操作時，只能替自己公司產生編號（SQL Editor／service role 的 auth.uid() 為 null，不受限）
  -- （create_organization 建立第一筆成員資料時，帳號還沒有 profile，current_org_id() 為 null，不在此限）
  if auth.uid() is not null and public.current_org_id() is not null
     and new.org_id is distinct from public.current_org_id() then
    raise exception '不可為其他公司建立資料' using errcode = '42501';
  end if;

  v_cur := to_jsonb(new) ->> v_col;
  if v_cur is not null and btrim(v_cur) <> '' then
    if auth.uid() is not null and v_cur !~ '^[A-Za-z0-9._-]{1,50}$' then
      raise exception '編號只能包含英數字、「.」「_」「-」，最長 50 字' using errcode = '22023';
    end if;
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

-- ---------------------------------------------------------------------
-- 5a. 支出審核 trigger（取代 20261125090000 的版本，補洞）
--   * committed_amount、expense_id：非專案經理不得設定／變更
--   * 尚未核准的支出：非專案經理不得登錄實際支出或付款金額（避免未經核准先花錢）
--   * 已核准的支出：另鎖定申請人
-- ---------------------------------------------------------------------
create or replace function public.tg_guard_expense_review()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if auth.uid() is null or public.is_pm() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- 非專案經理新增時，一律視為待審核，不能直接寫入核准結果
    new.review_status := '待審核';
    new.approved_amount := 0;
    new.committed_amount := 0;
    new.approver_id := null;
    new.approved_date := null;
    if coalesce(new.actual_amount, 0) > 0 or coalesce(new.paid_amount, 0) > 0 then
      raise exception '支出尚未核准，不能登錄實際支出或付款金額' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE：審核相關欄位不得由非專案經理變更
  if new.approved_amount is distinct from old.approved_amount
     or new.committed_amount is distinct from old.committed_amount
     or new.approver_id is distinct from old.approver_id
     or new.approved_date is distinct from old.approved_date then
    raise exception '只有專案經理可以核准或修改核准金額' using errcode = '42501';
  end if;
  if new.expense_id is distinct from old.expense_id then
    raise exception '不可變更支出編號' using errcode = '42501';
  end if;

  if new.review_status is distinct from old.review_status then
    -- 只允許「已駁回 → 待審核」（修改後重新送審）
    if not (old.review_status = '已駁回' and new.review_status = '待審核') then
      raise exception '只有專案經理可以變更審核狀態' using errcode = '42501';
    end if;
  end if;

  -- 未核准前不得增加實際支出／付款
  if new.review_status is distinct from '已核准'
     and (coalesce(new.actual_amount, 0) > coalesce(old.actual_amount, 0)
          or coalesce(new.paid_amount, 0) > coalesce(old.paid_amount, 0)) then
    raise exception '支出尚未核准，不能登錄實際支出或付款金額' using errcode = '42501';
  end if;

  -- 已核准的支出：非專案經理不得改項目、活動、申請人、申請金額或刪除
  if old.review_status = '已核准' and (
       new.item is distinct from old.item
    or new.campaign_id is distinct from old.campaign_id
    or new.applicant_id is distinct from old.applicant_id
    or new.requested_amount is distinct from old.requested_amount
    or new.is_deleted is distinct from old.is_deleted) then
    raise exception '支出已核准，只有專案經理可以修改項目、活動、金額或刪除' using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5b. approvals：審核結果只能由專案經理寫入（支出類）
--   * 非專案經理：只能新增「待審核」紀錄，審核者／審核時間／駁回原因一律清空
--   * 專案經理：審核者、審核時間由資料庫填寫；結果必須與支出目前的審核狀態一致
--   * 一般使用者不能更新或刪除審核紀錄；只有組長以上看得到審核紀錄
-- ---------------------------------------------------------------------
create or replace function public.tg_guard_approval_insert()
returns trigger
language plpgsql set search_path = public
as $$
declare v_status text;
begin
  if auth.uid() is null or new.business_type is distinct from '支出' then
    return new;
  end if;

  if not public.is_pm() then
    new.result := '待審核';
    new.reviewer_id := null;
    new.reviewed_at := null;
    new.reject_reason := null;
    new.review_version := null;
    new.submitter_id := public.current_member_id();
    return new;
  end if;

  if coalesce(new.result, '待審核') not in ('待審核', '已核准', '已駁回') then
    raise exception '審核結果只能是待審核、已核准或已駁回' using errcode = '22023';
  end if;
  if new.result in ('已核准', '已駁回') then
    select e.review_status into v_status from public.expenses e
     where e.org_id = new.org_id and e.expense_id = new.business_id;
    if v_status is distinct from new.result then
      raise exception '審核紀錄與支出目前的審核狀態不一致' using errcode = '22023';
    end if;
    new.reviewer_id := public.current_member_id();
    new.reviewed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists guard_approval_insert on public.approvals;
create trigger guard_approval_insert before insert on public.approvals
  for each row execute function public.tg_guard_approval_insert();

drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals for select to authenticated
  using (org_id = public.current_org_id() and public.is_leader_or_pm());
revoke update, delete on public.approvals from authenticated;

-- ---------------------------------------------------------------------
-- 3. 函式 EXECUTE 權限
--    Postgres／Supabase 預設會把新函式的 EXECUTE 開放給 public 與 anon，這裡全部收回，
--    只留 authenticated（RLS policy 以呼叫者身分執行輔助函式，所以輔助函式要保留）。
-- ---------------------------------------------------------------------
revoke all on function
  public.current_org_id(), public.current_member_id(), public.current_app_role(),
  public.is_pm(), public.is_leader_or_pm(), public.is_authorized(), public.can_edit_task(text),
  public.create_organization(text, text, text, text),
  public.invite_member(text, text, text, text, text, numeric),
  public.mark_password_changed(), public.touch_last_login(), public.get_my_profile(),
  public.set_my_test_role(text),
  public.preview_join_code(text), public.join_with_code(text, text, text)
from public, anon;
grant execute on function
  public.current_org_id(), public.current_member_id(), public.current_app_role(),
  public.is_pm(), public.is_leader_or_pm(), public.is_authorized(), public.can_edit_task(text),
  public.create_organization(text, text, text, text),
  public.invite_member(text, text, text, text, text, numeric),
  public.mark_password_changed(), public.touch_last_login(), public.get_my_profile(),
  public.set_my_test_role(text),
  public.preview_join_code(text), public.join_with_code(text, text, text)
to authenticated;

-- claim_invitation 只給 join_with_code 內部使用
revoke all on function public.claim_invitation(text) from public, anon, authenticated;

-- trigger 函式不需要任何 API 角色的 EXECUTE（trigger 觸發時不檢查）
revoke all on function
  public.tg_auto_code(), public.tg_touch_row(), public.tg_touch_profile(), public.tg_audit(),
  public.tg_guard_task_member_edit(), public.tg_guard_last_pm(), public.tg_guard_org(),
  public.tg_lock_test_flag(), public.tg_guard_expense_review(), public.tg_guard_approval_insert()
from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. 資料表權限（RLS 之外的第二道防線；TRUNCATE 不受 RLS 管制）
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
-- 這三張表只能透過 RPC 寫入（project_members 保留專案經理刪除）
revoke insert, update on public.project_invites, public.join_requests, public.project_members from authenticated;
