-- =====================================================================
-- 個人資料自助修改（「個人資料」頁面使用）
-- 版本：20261120090000
--
-- 本檔只做「新增」：
--   1. members 新增 avatar_path（大頭貼在 Storage 的路徑）、notify_prefs（通知偏好）
--   2. 新增函式 update_my_profile：使用者只能修改「自己」的姓名、聯絡電話、專長、技能等級、
--      通知偏好與大頭貼；角色、直屬組長、部門、Email、員工編號仍只有專案經理能改
--   3. Storage：建立 avatars 儲存空間（公開讀取），並限制只能上傳／刪除自己資料夾內的檔案
--
-- 不會刪除或覆寫任何既有資料表或資料；可以重複執行（皆使用 if not exists／or replace／on conflict）。
-- 修改紀錄：members 原本就有 touch_row（版本號、更新人）與 audit_row（異動紀錄）觸發器，
--           透過本函式的修改也會自動寫入 audit_log。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 新欄位
-- ---------------------------------------------------------------------
alter table public.members add column if not exists avatar_path text;            -- 大頭貼路徑：{org_id}/{member_id}/{時間}.jpg
alter table public.members add column if not exists notify_prefs jsonb not null
  default '{"line_alert": true, "email_alert": false, "daily_summary": true, "due_reminder": true}'::jsonb;  -- 通知偏好

comment on column public.members.avatar_path  is '大頭貼在 Storage（avatars）的路徑';
comment on column public.members.notify_prefs is '通知偏好：line_alert／email_alert／daily_summary／due_reminder（true/false）';

-- ---------------------------------------------------------------------
-- 2. 修改自己的個人資料
--    參數為 null 代表「不變更」；空字串代表「清除」（姓名不可清除）
-- ---------------------------------------------------------------------
create or replace function public.update_my_profile(
  p_name         text  default null,
  p_contact      text  default null,
  p_skills       text  default null,
  p_skill_level  text  default null,
  p_notify_prefs jsonb default null,
  p_avatar_path  text  default null
)
returns table (member_id text, name text, contact text, skills text, skill_level text,
               notify_prefs jsonb, avatar_path text, version integer)
language plpgsql security definer set search_path = public
as $$
declare
  v_org   uuid := public.current_org_id();
  v_mid   text := public.current_member_id();
  v_prefs jsonb;
begin
  if v_org is null or v_mid is null then
    raise exception '尚未登入，或帳號尚未授權' using errcode = '42501';
  end if;

  -- 姓名：1～40 字
  if p_name is not null then
    p_name := btrim(p_name);
    if char_length(p_name) < 1 or char_length(p_name) > 40 then
      raise exception '姓名需為 1～40 個字' using errcode = '22023';
    end if;
  end if;

  -- 聯絡電話：只允許數字、空白與 + - ( ) #，6～30 字（空字串＝清除）
  if p_contact is not null then
    p_contact := btrim(p_contact);
    if p_contact <> '' and (p_contact !~ '^[0-9+()#[:space:]-]+$' or char_length(p_contact) not between 6 and 30) then
      raise exception '聯絡電話只能包含數字、空白與 + - ( ) #，長度 6～30' using errcode = '22023';
    end if;
  end if;

  -- 專長：最多 300 字
  if p_skills is not null then
    p_skills := btrim(p_skills);
    if char_length(p_skills) > 300 then
      raise exception '專長最多 300 個字' using errcode = '22023';
    end if;
  end if;

  -- 技能等級：必須是公司「技能等級」選單中啟用的值（空字串＝清除）
  if p_skill_level is not null and p_skill_level <> '' then
    if not exists (
      select 1 from public.option_lists o
      where o.org_id = v_org and o.category = '技能等級' and o.value = p_skill_level and o.is_active
    ) then
      raise exception '技能等級不在公司設定的選單中' using errcode = '22023';
    end if;
  end if;

  -- 通知偏好：只接受允許的鍵，且值必須是 true/false；其他鍵直接忽略
  if p_notify_prefs is not null then
    if jsonb_typeof(p_notify_prefs) <> 'object' then
      raise exception '通知偏好格式錯誤' using errcode = '22023';
    end if;
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_prefs
    from jsonb_each(p_notify_prefs) as e(key, value)
    where e.key in ('line_alert', 'email_alert', 'daily_summary', 'due_reminder')
      and jsonb_typeof(e.value) = 'boolean';
  end if;

  -- 大頭貼：只能指向自己資料夾內的檔案（空字串＝移除）
  if p_avatar_path is not null and p_avatar_path <> '' then
    if position(v_org::text || '/' || v_mid || '/' in p_avatar_path) <> 1
       or p_avatar_path !~ '^[0-9a-f-]+/[^/]+/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
       or p_avatar_path like '%..%' then
      raise exception '大頭貼路徑不正確' using errcode = '22023';
    end if;
  end if;

  return query
  update public.members m set
    name         = coalesce(p_name, m.name),
    contact      = case when p_contact     is null then m.contact     else nullif(p_contact, '')     end,
    skills       = case when p_skills      is null then m.skills      else nullif(p_skills, '')      end,
    skill_level  = case when p_skill_level is null then m.skill_level else nullif(p_skill_level, '') end,
    notify_prefs = case when v_prefs       is null then m.notify_prefs else m.notify_prefs || v_prefs end,
    avatar_path  = case when p_avatar_path is null then m.avatar_path else nullif(p_avatar_path, '') end
  where m.org_id = v_org and m.member_id = v_mid and m.is_deleted = false
  returning m.member_id, m.name, m.contact, m.skills, m.skill_level, m.notify_prefs, m.avatar_path, m.version;

  if not found then
    raise exception '找不到你的成員資料' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_my_profile(text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.update_my_profile(text, text, text, text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 大頭貼儲存空間（Supabase Storage）
--    公開讀取：知道網址即可看到照片（大頭貼屬於低敏感資料；路徑含公司 UUID，不易被猜到）
--    上傳／讀取清單／刪除：只能操作「自己公司／自己員工編號」資料夾，單檔 512 KB、只收圖片
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists avatars_insert_own on storage.objects;   -- 只移除本檔自己建立的同名規則，方便重複執行
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (storage.foldername(name))[2] = public.current_member_id()
  );

-- Storage 的刪除 API 會先查詢檔案，所以刪除自己的舊頭像也需要「讀自己資料夾」的權限
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (storage.foldername(name))[2] = public.current_member_id()
  );

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (storage.foldername(name))[2] = public.current_member_id()
  );
