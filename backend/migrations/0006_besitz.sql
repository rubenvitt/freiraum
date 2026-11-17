-- E5: Besitz („Vermögenswert ohne Gewinn = Verbindlichkeit“). Ein Besitz (Auto, Wohnung,
-- Fahrrad …) gehört einem Haushalt; seine laufenden Kosten kommen aus den verknüpften Töpfen.
-- Rechenregeln: ADR 0005.

create table assets (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 100),
  -- aktueller Wert in Cent (optional, von Hand gepflegt)
  value_cents   bigint check (value_cents is null or value_cents >= 0),
  sort_order    integer not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index assets_household_id_idx on assets (household_id, sort_order);
create unique index assets_name_idx on assets (household_id, lower(name)) where archived_at is null;

-- Ein Topf gehört höchstens zu einem Besitz, und nur zu einem aus demselben Haushalt.
create table asset_pots (
  asset_id  uuid not null references assets (id) on delete cascade,
  pot_id    uuid not null unique references pots (id) on delete cascade,
  primary key (asset_id, pot_id)
);

create function check_asset_pot_household() returns trigger language plpgsql as $$
begin
  if (select household_id from assets where id = new.asset_id)
     is distinct from (select household_id from pots where id = new.pot_id) then
    raise exception 'Topf gehört nicht zum Haushalt des Besitzes' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger asset_pots_household
  before insert or update on asset_pots for each row execute function check_asset_pot_household();
