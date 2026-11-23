-- =====================================================================
-- 專案共用邀請碼（一個專案一個碼）＋ 加入申請（經理核准）
--   * project_invites   ：每個專案一組長期有效的邀請碼，可停用、可換新碼
--   * join_requests     ：員工用專案碼申請加入，專案經理核准後才建立帳號
--   * project_members   ：記錄成員屬於哪些專案（目前資料可見範圍仍為全公司）
--   * 原本「一人一碼」(invitations / claim_invitation) 完整保留
-- 前端 RPC：
--   preview_join_code(p_code)                    → 顯示即將加入的公司／專案
--   join_with_code(p_code, p_name, p_department) → 個人碼直接加入；專案碼送出申請
--   get_my_join_request() / cancel_my_join_request()
--   list_project_invites() / rotate_project_invite(p_project_id) / set_project_invite_enabled(p_project_id, p_enabled)
--   list_join_requests() / decide_join_request(p_request_id, p_approve, p_note)
-- =====================================================================

-- ---------- 產生不易混淆的 8 碼（排除 0 O 1 I L） ----------
create or replace function public.gen_join_code()
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code  text;
  v_bytes bytea;
  i int;
begin
  loop
    v_bytes := extensions.gen_random_bytes(8);
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % length(v_alpha)) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.project_invites where invite_code = v_code)
          and not exists (select 1 from public.invitations where upper(invite_code) = v_code);
  end loop;
  return v_code;
end;
$$;

-- ---------- 資料表 ----------
create table public.project_invites (
  org_id       uuid not null references public.organizations(org_id) on delete cascade,
  project_id   text not null,
  invite_code  text not null,
  is_enabled   boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   text,
  rotated_at   timestamptz,
  primary key (org_id, project_id),
  foreign key (org_id, project_id) references public.projects(org_id, project_id) on delete cascade
);
create unique index project_invites_code on public.project_invites (invite_code);

create table public.join_requests (
  request_id   uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(org_id) on delete cascade,
  project_id   text not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  email        text not null,
  name         text not null,
  department   text,
  status       text not null default '待審核' check (status in ('待審核','已核准','已拒絕','已取消')),
  member_id    text,            -- 核准後建立的組員ID
  decided_by   text,
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz not null default now(),
  foreign key (org_id, project_id) references public.projects(org_id, project_id) on delete cascade
);
-- 一個帳號同時只能有一張待審核申請
create unique index join_requests_one_pending on public.join_requests (user_id) where status = '待審核';
create index join_requests_org_status on public.join_requests (org_id, status);

create table public.project_members (
  org_id      uuid not null references public.organizations(org_id) on delete cascade,
  project_id  text not null,
  member_id   text not null,
  joined_at   timestamptz not null default now(),
  added_by    text,
  primary key (org_id, project_id, member_id),
  foreign key (org_id, project_id) references public.projects(org_id, project_id) on delete cascade,
  foreign key (org_id, member_id) references public.members(org_id, member_id) on delete cascade
);

alter table public.project_invites enable row level security;
alter table public.join_requests   enable row level security;
alter table public.project_members enable row level security;

-- 邀請碼與申請只有專案經理看得到；寫入一律透過 RPC
create policy pinv_select on public.project_invites for select to authenticated
  using (org_id = public.current_org_id() and public.is_pm());
create policy jreq_select on public.join_requests for select to authenticated
  using (user_id = auth.uid() or (org_id = public.current_org_id() and public.is_pm()));
create policy pmem_select on public.project_members for select to authenticated
  using (org_id = public.current_org_id());
create policy pmem_delete on public.project_members for delete to authenticated
  using (org_id = public.current_org_id() and public.is_pm());

grant select on public.project_invites, public.join_requests, public.project_members to authenticated;
grant delete on public.project_members to authenticated;

-- ---------- 新專案自動產生邀請碼 ----------
create or replace function public.tg_project_invite()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.project_invites (org_id, project_id, invite_code, created_by)
  values (new.org_id, new.project_id, public.gen_join_code(), new.created_by)
  on conflict do nothing;
  return new;
end;
$$;
create trigger z_project_invite after insert on public.projects
  for each row execute function public.tg_project_invite();

-- 既有專案補上邀請碼
insert into public.project_invites (org_id, project_id, invite_code, created_by)
select p.org_id, p.project_id, public.gen_join_code(), 'SYSTEM'
  from public.projects p
 where not exists (select 1 from public.project_invites i where i.org_id = p.org_id and i.project_id = p.project_id);

-- ---------- 員工端 ----------
-- 預覽邀請碼：回傳公司／專案名稱（不洩漏其他資訊）
create or replace function public.preview_join_code(p_code text)
returns table (kind text, org_name text, project_name text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_email text;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
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

  raise exception '邀請碼錯誤或已失效，請向專案經理確認';
end;
$$;

-- 用邀請碼加入：個人碼（綁 Email）直接加入；專案碼送出加入申請
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
    raise exception '邀請碼錯誤或已失效，請向專案經理確認';
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

-- 自己最近一張申請（待審核，或 14 天內被拒絕的）
create or replace function public.get_my_join_request()
returns table (request_id uuid, status text, org_name text, project_name text,
               name text, created_at timestamptz, decided_at timestamptz, decision_note text)
language sql stable security definer set search_path = public
as $$
  select r.request_id, r.status, o.name, p.name, r.name, r.created_at, r.decided_at, r.decision_note
    from public.join_requests r
    join public.organizations o on o.org_id = r.org_id
    left join public.projects p on p.org_id = r.org_id and p.project_id = r.project_id
   where r.user_id = auth.uid()
     and (r.status = '待審核' or (r.status = '已拒絕' and r.decided_at > now() - interval '14 days'))
   order by r.created_at desc
   limit 1
$$;

create or replace function public.cancel_my_join_request()
returns void
language sql security definer set search_path = public
as $$
  update public.join_requests set status = '已取消', decided_at = now()
   where user_id = auth.uid() and status = '待審核'
$$;

-- ---------- 專案經理端 ----------
create or replace function public.list_project_invites()
returns table (project_id text, project_name text, project_status text, invite_code text,
               is_enabled boolean, rotated_at timestamptz, pending_count integer, member_count integer)
language plpgsql security definer set search_path = public
as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以查看邀請碼' using errcode = '42501';
  end if;
  -- 補齊缺少的邀請碼
  insert into public.project_invites (org_id, project_id, invite_code, created_by)
  select p.org_id, p.project_id, public.gen_join_code(), public.current_member_id()
    from public.projects p
   where p.org_id = v_org and not p.is_deleted
     and not exists (select 1 from public.project_invites i where i.org_id = p.org_id and i.project_id = p.project_id);

  return query
    select p.project_id, p.name, p.status, i.invite_code, i.is_enabled, i.rotated_at,
           (select count(*)::int from public.join_requests r
             where r.org_id = v_org and r.project_id = p.project_id and r.status = '待審核'),
           (select count(*)::int from public.project_members m
             where m.org_id = v_org and m.project_id = p.project_id)
      from public.projects p
      join public.project_invites i on i.org_id = p.org_id and i.project_id = p.project_id
     where p.org_id = v_org and not p.is_deleted
     order by p.project_id;
end;
$$;

create or replace function public.rotate_project_invite(p_project_id text)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_code text;
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以更換邀請碼' using errcode = '42501';
  end if;
  update public.project_invites set invite_code = public.gen_join_code(), rotated_at = now(), is_enabled = true
   where org_id = public.current_org_id() and project_id = p_project_id
  returning invite_code into v_code;
  if v_code is null then
    raise exception '找不到這個專案';
  end if;
  return v_code;
end;
$$;

create or replace function public.set_project_invite_enabled(p_project_id text, p_enabled boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以設定邀請碼' using errcode = '42501';
  end if;
  update public.project_invites set is_enabled = coalesce(p_enabled, false)
   where org_id = public.current_org_id() and project_id = p_project_id;
  if not found then
    raise exception '找不到這個專案';
  end if;
end;
$$;

create or replace function public.list_join_requests()
returns table (request_id uuid, project_id text, project_name text, name text, email text,
               department text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_pm() then
    raise exception '只有專案經理可以審核申請' using errcode = '42501';
  end if;
  return query
    select r.request_id, r.project_id, p.name, r.name, r.email, r.department, r.created_at
      from public.join_requests r
      left join public.projects p on p.org_id = r.org_id and p.project_id = r.project_id
     where r.org_id = public.current_org_id() and r.status = '待審核'
     order by r.created_at;
end;
$$;

-- 核准：建立組員＋帳號（一律「組員」，之後可在成員管理調整）＋加入專案
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
           decision_note = nullif(btrim(coalesce(p_note, '')), '')
     where r.request_id = p_request_id;
    return null;
  end if;

  if exists (select 1 from public.profiles p where p.user_id = v_r.user_id) then
    update public.join_requests r set status = '已取消', decided_by = v_me, decided_at = now(),
           decision_note = '此帳號已加入其他公司'
     where r.request_id = p_request_id;
    raise exception '此帳號已經加入公司（可能用了其他邀請），申請已自動取消';
  end if;

  -- 同公司已有同 Email、尚未綁帳號的組員資料就沿用
  select m.member_id into v_mid from public.members m
   where m.org_id = v_org and lower(m.email) = lower(v_r.email)
     and not exists (select 1 from public.profiles p where p.org_id = m.org_id and p.member_id = m.member_id)
   limit 1;

  if v_mid is null then
    insert into public.members (org_id, name, project_role, department, email, join_date, status, created_by)
    values (v_org, v_r.name, '組員', v_r.department, v_r.email, current_date, '在職', v_me)
    returning members.member_id into v_mid;
  else
    update public.members m set is_deleted = false, status = '在職',
           department = coalesce(m.department, v_r.department)
     where m.org_id = v_org and m.member_id = v_mid;
  end if;

  insert into public.profiles (org_id, user_id, member_id, email, role, auth_status, must_change_password,
                               authorized_by, authorized_at, created_by)
  values (v_org, v_r.user_id, v_mid, v_r.email,
          coalesce((select project_role from public.members where org_id = v_org and member_id = v_mid
                     and project_role in ('專案經理','組長','組員')), '組員'),
          '已授權', false, v_me, now(), v_me);

  insert into public.project_members (org_id, project_id, member_id, added_by)
  values (v_org, v_r.project_id, v_mid, v_me)
  on conflict do nothing;

  -- 這個 Email 若還有未接受的個人邀請，一併關閉
  update public.invitations i set status = '已取消'
   where lower(i.email) = lower(v_r.email) and i.status = '待接受';

  update public.join_requests r set status = '已核准', member_id = v_mid, decided_by = v_me, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where r.request_id = p_request_id;
  return v_mid;
end;
$$;

-- 個人邀請碼加入時，若有指定專案以外的申請中紀錄，一併取消
create or replace function public.tg_profile_cancel_requests()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  update public.join_requests set status = '已取消', decided_at = now(),
         decision_note = coalesce(decision_note, '已用其他方式加入公司')
   where user_id = new.user_id and status = '待審核';
  return new;
end;
$$;
create trigger z_cancel_requests after insert on public.profiles
  for each row execute function public.tg_profile_cancel_requests();

-- ---------- 權限 ----------
revoke all on function public.gen_join_code(), public.tg_project_invite(), public.tg_profile_cancel_requests() from public, anon, authenticated;
revoke all on function public.preview_join_code(text), public.join_with_code(text, text, text),
  public.get_my_join_request(), public.cancel_my_join_request(), public.list_project_invites(),
  public.rotate_project_invite(text), public.set_project_invite_enabled(text, boolean),
  public.list_join_requests(), public.decide_join_request(uuid, boolean, text) from public, anon;
grant execute on function public.preview_join_code(text), public.join_with_code(text, text, text),
  public.get_my_join_request(), public.cancel_my_join_request(), public.list_project_invites(),
  public.rotate_project_invite(text), public.set_project_invite_enabled(text, boolean),
  public.list_join_requests(), public.decide_join_request(uuid, boolean, text) to authenticated;
