-- SportKids production database. Run with: supabase db push
-- This file contains no passwords, API keys, or real player data.

create extension if not exists pgcrypto;

do $$ begin
  create type public.member_role as enum ('owner', 'coach');
exception when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'coach',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid unique references public.profiles(id) on delete set null,
  full_name text not null check (char_length(full_name) between 1 and 80),
  birth_date date,
  position text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parent_players (
  parent_id uuid not null references public.profiles(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (parent_id, player_id)
);

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  assessment_date date not null default current_date,
  period_year smallint not null default (extract(year from current_date)::smallint),
  period_month smallint not null check (period_month between 1 and 12),
  period_week smallint not null check (period_week between 1 and 4),
  created_by uuid not null references public.profiles(id) on delete restrict,
  coach_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (player_id, period_year, period_month, period_week)
);

create table if not exists public.assessment_scores (
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  skill_id text not null check (skill_id in ('technique','tactics','physical','coordination','psychology','thinking','discipline','leadership')),
  score smallint not null check (score between 0 and 100),
  primary key (assessment_id, skill_id)
);

create table if not exists public.criterion_scores (
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  criterion_group text not null check (criterion_group in ('technical','physical','tactical','psychological','influence','discipline')),
  criterion_name text not null check (char_length(criterion_name) between 1 and 120),
  score smallint not null check (score between 0 and 100),
  primary key (assessment_id, criterion_group, criterion_name)
);

create table if not exists public.player_tests (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  category text not null check (char_length(category) between 1 and 80),
  test_name text not null check (char_length(test_name) between 1 and 160),
  result_value text not null check (char_length(result_value) between 1 and 40),
  unit text not null check (char_length(unit) between 1 and 40),
  measured_on date not null default current_date,
  note text not null default '',
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.player_goals (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  specific_action text not null,
  measurement text not null default '',
  achievable_reason text not null default '',
  relevant_reason text not null default '',
  target_date date,
  status text not null default 'active' check (status in ('active','completed','archived')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.challenge_completions (
  player_id uuid not null references public.players(id) on delete cascade,
  challenge_id text not null check (char_length(challenge_id) between 1 and 80),
  completed_on date not null default current_date,
  note text not null default '',
  verified_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (player_id, challenge_id)
);

create index if not exists assessments_player_date_idx on public.assessments(player_id, assessment_date desc);
create index if not exists tests_player_date_idx on public.player_tests(player_id, measured_on desc);
create index if not exists goals_player_status_idx on public.player_goals(player_id, status);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.create_profile_for_new_user();

create or replace function public.add_organization_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.organization_members (organization_id, user_id, role)
  values (new.id, new.owner_id, 'owner') on conflict do nothing;
  return new;
end; $$;

drop trigger if exists add_organization_owner on public.organizations;
create trigger add_organization_owner after insert on public.organizations
for each row execute procedure public.add_organization_owner();

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
drop trigger if exists players_updated_at on public.players;
create trigger players_updated_at before update on public.players for each row execute procedure public.set_updated_at();
drop trigger if exists assessments_updated_at on public.assessments;
create trigger assessments_updated_at before update on public.assessments for each row execute procedure public.set_updated_at();
drop trigger if exists goals_updated_at on public.player_goals;
create trigger goals_updated_at before update on public.player_goals for each row execute procedure public.set_updated_at();

-- Security helpers. Parents can view linked children, players themselves, and club coaches.
create or replace function public.can_manage_organization(target_organization uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_members m
    where m.organization_id = target_organization and m.user_id = auth.uid() and m.role in ('owner','coach'));
$$;

create or replace function public.is_organization_owner(target_organization uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organization_members m
    where m.organization_id = target_organization and m.user_id = auth.uid() and m.role = 'owner');
$$;

create or replace function public.can_view_player(target_player uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.players p where p.id = target_player and p.user_id = auth.uid())
      or exists (select 1 from public.parent_players pp where pp.player_id = target_player and pp.parent_id = auth.uid())
      or exists (select 1 from public.players p join public.organization_members m on m.organization_id = p.organization_id
                 where p.id = target_player and m.user_id = auth.uid());
$$;

create or replace function public.can_manage_player(target_player uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.players p where p.id = target_player and public.can_manage_organization(p.organization_id));
$$;

create or replace function public.can_edit_player_progress(target_player uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.players p where p.id = target_player and p.user_id = auth.uid())
      or public.can_manage_player(target_player);
$$;

create or replace function public.can_view_assessment(target_assessment uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.assessments a where a.id = target_assessment and public.can_view_player(a.player_id));
$$;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.players enable row level security;
alter table public.parent_players enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_scores enable row level security;
alter table public.criterion_scores enable row level security;
alter table public.player_tests enable row level security;
alter table public.player_goals enable row level security;
alter table public.challenge_completions enable row level security;

create policy "profile owner reads own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profile owner updates own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members read organization" on public.organizations for select to authenticated using (public.can_manage_organization(id));
create policy "user creates own organization" on public.organizations for insert to authenticated with check (owner_id = auth.uid());
create policy "owner updates organization" on public.organizations for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "members read membership" on public.organization_members for select to authenticated using (user_id = auth.uid() or public.can_manage_organization(organization_id));
create policy "owners manage membership" on public.organization_members for all to authenticated using (public.is_organization_owner(organization_id)) with check (public.is_organization_owner(organization_id));

create policy "authorized users view player" on public.players for select to authenticated using (public.can_view_player(id));
create policy "coaches create player" on public.players for insert to authenticated with check (public.can_manage_organization(organization_id));
create policy "coaches edit player" on public.players for update to authenticated using (public.can_manage_player(id)) with check (public.can_manage_organization(organization_id));
create policy "coaches delete player" on public.players for delete to authenticated using (public.can_manage_player(id));

create policy "parents or coaches view links" on public.parent_players for select to authenticated using (parent_id = auth.uid() or public.can_manage_player(player_id));
create policy "coaches manage parent links" on public.parent_players for all to authenticated using (public.can_manage_player(player_id)) with check (public.can_manage_player(player_id));

create policy "authorized users view assessments" on public.assessments for select to authenticated using (public.can_view_player(player_id));
create policy "coaches manage assessments" on public.assessments for all to authenticated using (public.can_manage_player(player_id)) with check (public.can_manage_player(player_id) and created_by = auth.uid());
create policy "authorized users view score" on public.assessment_scores for select to authenticated using (public.can_view_assessment(assessment_id));
create policy "coaches manage scores" on public.assessment_scores for all to authenticated using (exists (select 1 from public.assessments a where a.id = assessment_id and public.can_manage_player(a.player_id))) with check (exists (select 1 from public.assessments a where a.id = assessment_id and public.can_manage_player(a.player_id)));
create policy "authorized users view criterion score" on public.criterion_scores for select to authenticated using (public.can_view_assessment(assessment_id));
create policy "coaches manage criterion scores" on public.criterion_scores for all to authenticated using (exists (select 1 from public.assessments a where a.id = assessment_id and public.can_manage_player(a.player_id))) with check (exists (select 1 from public.assessments a where a.id = assessment_id and public.can_manage_player(a.player_id)));

create policy "authorized users view tests" on public.player_tests for select to authenticated using (public.can_view_player(player_id));
create policy "coaches manage tests" on public.player_tests for all to authenticated using (public.can_manage_player(player_id)) with check (public.can_manage_player(player_id) and recorded_by = auth.uid());

create policy "authorized users view goals" on public.player_goals for select to authenticated using (public.can_view_player(player_id));
create policy "player or coach manages own progress" on public.player_goals for all to authenticated using (public.can_edit_player_progress(player_id)) with check (public.can_edit_player_progress(player_id) and created_by = auth.uid());
create policy "authorized users view challenges" on public.challenge_completions for select to authenticated using (public.can_view_player(player_id));
create policy "player or coach manages challenges" on public.challenge_completions for all to authenticated using (public.can_edit_player_progress(player_id)) with check (public.can_edit_player_progress(player_id));

-- Private photo bucket. Files must use the path: {player-id}/avatar.jpg
insert into storage.buckets (id, name, public) values ('player-photos', 'player-photos', false) on conflict (id) do update set public = false;
create policy "authorized users view player photo" on storage.objects for select to authenticated using (bucket_id = 'player-photos' and public.can_view_player((storage.foldername(name))[1]::uuid));
create policy "player or coach uploads player photo" on storage.objects for insert to authenticated with check (bucket_id = 'player-photos' and public.can_edit_player_progress((storage.foldername(name))[1]::uuid));
create policy "player or coach updates player photo" on storage.objects for update to authenticated using (bucket_id = 'player-photos' and public.can_edit_player_progress((storage.foldername(name))[1]::uuid));
create policy "player or coach deletes player photo" on storage.objects for delete to authenticated using (bucket_id = 'player-photos' and public.can_edit_player_progress((storage.foldername(name))[1]::uuid));

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
