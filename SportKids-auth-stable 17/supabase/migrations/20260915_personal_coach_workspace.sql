-- Run this once after the two earlier SportKids migrations.
-- Each signed-in coach receives a private workspace automatically.

create or replace function public.ensure_coach_workspace()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Потрібен вхід до акаунта';
  end if;

  insert into public.profiles (id, full_name)
  values (auth.uid(), '')
  on conflict (id) do nothing;

  select organization_id into workspace_id
  from public.organization_members
  where user_id = auth.uid()
  order by created_at
  limit 1;

  if workspace_id is null then
    insert into public.organizations (name, owner_id)
    values ('Кабінет тренера', auth.uid())
    returning id into workspace_id;
  end if;

  return workspace_id;
end;
$$;

grant execute on function public.ensure_coach_workspace() to authenticated;
