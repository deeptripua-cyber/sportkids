-- Run once in Supabase SQL Editor.
-- Lets a coach or the linked player save ONLY their own challenge checkbox.
-- Scores, tests, goals and player profile fields remain coach-managed.

create or replace function public.set_challenge_completion(
  p_player_account_id uuid,
  p_challenge_id text,
  p_completed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_challenges jsonb;
begin
  if auth.uid() is null then
    raise exception 'Потрібен вхід до акаунта';
  end if;

  if coalesce(trim(p_challenge_id), '') = '' then
    raise exception 'Не вказано завдання';
  end if;

  update public.player_accounts
  set app_state = jsonb_set(
    coalesce(app_state, '{}'::jsonb),
    array['challenges'],
    coalesce(app_state->'challenges', '{}'::jsonb)
      || jsonb_build_object(p_challenge_id, p_completed),
    true
  )
  where id = p_player_account_id
    and (coach_id = (select auth.uid()) or player_user_id = (select auth.uid()))
  returning app_state->'challenges' into saved_challenges;

  if not found then
    raise exception 'Профіль недоступний';
  end if;

  return coalesce(saved_challenges, '{}'::jsonb);
end;
$$;

revoke all on function public.set_challenge_completion(uuid, text, boolean) from public;
grant execute on function public.set_challenge_completion(uuid, text, boolean) to authenticated;
