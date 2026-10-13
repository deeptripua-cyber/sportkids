-- Run this once AFTER 20260915_sportkids.sql.
-- Keeps the current SportKids interface data in the player's protected record
-- while the normalized reporting tables are used for future integrations.

alter table public.players
  add column if not exists app_state jsonb not null default '{}'::jsonb;
