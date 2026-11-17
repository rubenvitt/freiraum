-- E1: Haushalte, Konten, Buchungen, Importläufe, wiederkehrende Serien.
-- Beträge sind ganze Cent (bigint), Währung EUR. Buchungstage sind `date` (Kalendertag der Bank).

-- Haushalt: `privat` gehört genau einer Person, `gemeinsam` beiden.
create table households (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('privat', 'gemeinsam')),
  name             text not null check (length(trim(name)) between 1 and 100),
  -- nur bei `privat`: die Person, der der Haushalt gehört (je Person genau einer)
  owner_person_id  uuid unique references persons (id) on delete cascade,
  created_at       timestamptz not null default now(),
  check ((kind = 'privat') = (owner_person_id is not null))
);
-- Es gibt höchstens einen gemeinsamen Haushalt.
create unique index households_one_shared_idx on households ((true)) where kind = 'gemeinsam';

create table household_members (
  household_id  uuid not null references households (id) on delete cascade,
  person_id     uuid not null references persons (id) on delete cascade,
  primary key (household_id, person_id)
);
create index household_members_person_id_idx on household_members (person_id);

-- Jede Person bekommt beim Anlegen ihren privaten Haushalt.
create function create_private_household() returns trigger language plpgsql as $$
declare
  hid uuid;
begin
  insert into households (kind, name, owner_person_id)
  values ('privat', new.display_name, new.id)
  returning id into hid;
  insert into household_members (household_id, person_id) values (hid, new.id);
  return new;
end
$$;
create trigger persons_private_household
  after insert on persons for each row execute function create_private_household();

-- Bestehende Personen aus E0 nachziehen.
with created as (
  insert into households (kind, name, owner_person_id)
  select 'privat', p.display_name, p.id from persons p
  returning id, owner_person_id
)
insert into household_members (household_id, person_id)
select id, owner_person_id from created;

create table accounts (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete restrict,
  name          text not null check (length(trim(name)) between 1 and 100),
  source        text not null check (source in ('bank', 'bar', 'manuell')),
  iban          text check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  currency      text not null default 'EUR' check (currency = 'EUR'),
  created_at    timestamptz not null default now()
);
create index accounts_household_id_idx on accounts (household_id);

create table import_runs (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts (id) on delete cascade,
  -- wer den Import ausgelöst hat; null = Server (z. B. zeitgesteuerter Abruf beim Anbieter)
  person_id   uuid references persons (id) on delete set null,
  received    integer not null check (received >= 0),
  imported    integer not null check (imported >= 0),
  skipped     integer not null check (skipped >= 0),
  created_at  timestamptz not null default now(),
  check (imported + skipped = received)
);
create index import_runs_account_id_idx on import_runs (account_id, created_at);

create table recurring_series (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts (id) on delete cascade,
  -- stabiler Schlüssel aus Richtung, Gegenpartei und ggf. Betrag; bleibt über Neuberechnungen gleich
  series_key            text not null,
  counterparty          text not null,
  direction             text not null check (direction in ('eingang', 'ausgang')),
  cadence               text not null check (cadence in (
                          'woechentlich', 'zweiwoechentlich', 'monatlich',
                          'quartalsweise', 'halbjaehrlich', 'jaehrlich')),
  typical_amount_cents  bigint not null,
  min_amount_cents      bigint not null,
  max_amount_cents      bigint not null,
  occurrences           integer not null check (occurrences >= 2),
  first_date            date not null,
  last_date             date not null,
  next_expected_date    date not null,
  state                 text not null check (state in ('aktiv', 'beendet')),
  updated_at            timestamptz not null default now(),
  unique (account_id, series_key),
  check (min_amount_cents <= typical_amount_cents and typical_amount_cents <= max_amount_cents),
  check (first_date <= last_date and last_date < next_expected_date)
);

create table transactions (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references accounts (id) on delete cascade,
  -- Idempotenzschlüssel: `id:<Quell-ID der Bank>` oder `hash:<sha256>:<Vorkommen>`
  import_key           text not null,
  source_id            text,
  booking_date         date not null,
  value_date           date,
  amount_cents         bigint not null,
  currency             text not null default 'EUR' check (currency = 'EUR'),
  counterparty_name    text,
  counterparty_iban    text,
  purpose              text,
  status               text not null default 'importiert'
                         check (status in ('importiert', 'vorgeschlagen', 'bestaetigt')),
  import_run_id        uuid references import_runs (id) on delete set null,
  recurring_series_id  uuid references recurring_series (id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (account_id, import_key)
);
create index transactions_account_date_idx on transactions (account_id, booking_date desc);
create index transactions_recurring_series_id_idx on transactions (recurring_series_id);
