-- =====================================================================
-- 測試帳號：可自行切換角色（專案經理／組長／組員），方便測試各層級畫面與權限
-- 只有專案經理能把某個帳號設為測試帳號（成員與帳號 → 編輯）
-- ⚠️ 測試帳號可以把自己切成專案經理，正式使用前請取消測試帳號設定
-- =====================================================================

alter table public.profiles
  add column if not exists is_test_account boolean not null default false;

-- 保留「至少一位專案經理」的保護，但測試帳號切換角色時略過
create or replace function public.tg_guard_last_pm()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(current_setting('app.test_switch', true), '') <> 'on'
     and old.role = '專案經理' and old.auth_status = '已授權'
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

-- 測試帳號切換自己的角色
-- 前端：supabase.rpc('set_my_test_role', { p_role: '組員' })
create or replace function public.set_my_test_role(p_role text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_is_test boolean;
begin
  select is_test_account into v_is_test
    from public.profiles
   where user_id = auth.uid() and auth_status = '已授權';
  if not coalesce(v_is_test, false) then
    raise exception '此帳號不是測試帳號，不能切換角色' using errcode = '42501';
  end if;
  if p_role not in ('專案經理','組長','組員') then
    raise exception '角色不正確';
  end if;
  perform set_config('app.test_switch', 'on', true);
  update public.profiles set role = p_role where user_id = auth.uid();
  return p_role;
end;
$$;

-- 個人資料加上 is_test_account
drop function if exists public.get_my_profile();
create function public.get_my_profile()
returns table (org_id uuid, org_name text, primary_color text, logo_url text,
               member_id text, name text, email text, role text, auth_status text,
               department text, must_change_password boolean, line_bound boolean,
               is_test_account boolean)
language sql stable security definer set search_path = public
as $$
  select o.org_id, o.name, o.primary_color, o.logo_url,
         p.member_id, m.name, p.email, p.role, p.auth_status,
         m.department, p.must_change_password, (m.line_user_id is not null),
         p.is_test_account
  from public.profiles p
  join public.organizations o on o.org_id = p.org_id
  join public.members m on m.org_id = p.org_id and m.member_id = p.member_id
  where p.user_id = auth.uid()
$$;

grant execute on function public.get_my_profile(), public.set_my_test_role(text) to authenticated;
