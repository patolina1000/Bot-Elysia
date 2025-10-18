create table if not exists bot_settings (
  bot_slug text primary key,
  pix_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'trg_set_updated_at') then
    create or replace function trg_set_updated_at()
    returns trigger as $body$
    begin
      new.updated_at = now();
      return new;
    end;
    $body$
    language plpgsql;
  end if;
end;
$$;

drop trigger if exists set_updated_at_on_bot_settings on bot_settings;
create trigger set_updated_at_on_bot_settings
before update on bot_settings
for each row execute function trg_set_updated_at();
