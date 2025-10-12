create table if not exists bot_plans (
  id bigserial primary key,
  bot_slug text not null,
  plan_name text not null,
  price_cents int not null check (price_cents >= 50),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_bot_plans_slug_name
  on bot_plans(bot_slug, plan_name);

do $$
begin
  if not exists (
    select 1
      from pg_proc
     where proname = 'trg_set_updated_at'
       and pg_function_is_visible(oid)
  ) then
    create or replace function trg_set_updated_at()
    returns trigger as $body$
    begin
      new.updated_at = now();
      return new;
    end
    $body$
    language plpgsql;
  end if;
end$$;

drop trigger if exists set_updated_at_on_bot_plans on bot_plans;
create trigger set_updated_at_on_bot_plans
before update on bot_plans
for each row execute function trg_set_updated_at();
