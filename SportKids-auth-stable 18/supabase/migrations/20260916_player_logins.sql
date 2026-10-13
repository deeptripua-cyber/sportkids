-- Player logins without player email addresses.
-- Run once in Supabase SQL Editor. Email confirmation must stay disabled for player accounts.

create table if not exists public.player_accounts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references auth.users(id) on delete cascade,
  player_user_id uuid unique references auth.users(id) on delete set null,
  username text unique,
  full_name text not null default '',
  age smallint check (age between 5 and 23),
  position text,
  app_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.player_accounts enable row level security;

create policy "coach reads own players" on public.player_accounts for select to authenticated using (coach_id = auth.uid());
create policy "player reads own profile" on public.player_accounts for select to authenticated using (player_user_id = auth.uid());
create policy "coach adds players" on public.player_accounts for insert to authenticated with check (coach_id = auth.uid());
create policy "coach edits players" on public.player_accounts for update to authenticated using (coach_id = auth.uid()) with check (coach_id = auth.uid());
create policy "coach deletes players" on public.player_accounts for delete to authenticated using (coach_id = auth.uid());

create or replace function public.player_accounts_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists player_accounts_updated_at on public.player_accounts;
create trigger player_accounts_updated_at before update on public.player_accounts
for each row execute procedure public.player_accounts_updated_at();

grant select, insert, update, delete on public.player_accounts to authenticated;
