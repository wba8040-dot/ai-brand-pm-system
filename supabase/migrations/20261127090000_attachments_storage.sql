-- =====================================================================
-- 附件上傳：Supabase Storage 私有 bucket「attachments」
-- 檔案路徑：{org_id}/{business_type}/{business_id}/{uuid}.{副檔名}
--   第一層資料夾一定是公司 ID，RLS 靠它隔離公司，不會讀到別家公司的檔案。
-- 權限：專案經理、組長可上傳與下載；只有專案經理可刪除。
-- 上限 10 MB；只收 PDF、圖片、Office 文件與 CSV／文字檔。
-- 此檔可重複執行。
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false, 10485760,
  array[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp',
    'text/csv', 'text/plain',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists attachments_obj_select on storage.objects;
drop policy if exists attachments_obj_insert on storage.objects;
drop policy if exists attachments_obj_delete on storage.objects;

create policy attachments_obj_select on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.is_leader_or_pm()
  );

create policy attachments_obj_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.is_leader_or_pm()
  );

create policy attachments_obj_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.is_pm()
  );
