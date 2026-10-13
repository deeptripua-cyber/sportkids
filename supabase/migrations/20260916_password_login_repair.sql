-- Repair permissions for the simple SportKids trainer/player login flow.
-- This does not delete or change any player data.
-- Run once in Supabase SQL Editor after 20260916_player_logins.sql.

alter table public.player_accounts enable row level security;

drop policy if exists "coach reads own players" on public.player_accounts;
drop policy if exists "player reads own profile" on public.player_accounts;
drop policy if exists "coach adds players" on public.player_accounts;
drop policy if exists "coach edits players" on public.player_accounts;
drop policy if exists "coach deletes players" on public.player_accounts;

create policy "coach reads own players"
  on public.player_accounts for select to authenticated
  using (coach_id = (select auth.uid()));

create policy "player reads own profile"
  on public.player_accounts for select to authenticated
  using (player_user_id = (select auth.uid()));

create policy "coach adds players"
  on public.player_accounts for insert to authenticated
  with check (coach_id = (select auth.uid()));

create policy "coach edits players"
  on public.player_accounts for update to authenticated
  using (coach_id = (select auth.uid()))
  with check (coach_id = (select auth.uid()));

create policy "coach deletes players"
  on public.player_accounts for delete to authenticated
  using (coach_id = (select auth.uid()));

grant select, insert, update, delete on public.player_accounts to authenticated;

create index if not exists player_accounts_coach_id_idx on public.player_accounts (coach_id);
create index if not exists player_accounts_player_user_id_idx on public.player_accounts (player_user_id);
