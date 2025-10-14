-- cria tabela de jobs para downsells
create table if not exists public.bot_downsell_jobs (
  id bigserial primary key,
  bot_slug text not null,
  downsell_id bigint not null references public.bot_downsells(id) on delete cascade,
  telegram_id bigint not null,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'pending', -- pending | processing | sent | failed
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_bot_downsell_jobs_unique
  on public.bot_downsell_jobs (downsell_id, telegram_id);

create index if not exists ix_bot_downsell_jobs_due
  on public.bot_downsell_jobs (status, scheduled_at);

-- trigger simples de updated_at
create or replace function public.trg_touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bot_downsell_jobs_touch on public.bot_downsell_jobs;
create trigger trg_bot_downsell_jobs_touch
before update on public.bot_downsell_jobs
for each row execute procedure public.trg_touch_updated_at();
