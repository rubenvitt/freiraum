-- E2: Töpfe, Zuweisungen, Monatsabschluss, Aufteilungen, Regeln und Vorschläge.
-- Beträge sind ganze Cent (bigint). Monate werden als `date` am Monatsersten gespeichert.
-- Rechenregeln (Übertrag, Überziehung, „Noch ohne Aufgabe“): ADR 0003.

create table pots (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete restrict,
  name          text not null check (length(trim(name)) between 1 and 100),
  kind          text not null check (kind in ('monatlich', 'ruecklage', 'ziel', 'erst_ich')),
  -- Gruppe zur Ordnung, frei benannt
  group_name    text check (group_name is null or length(trim(group_name)) between 1 and 100),
  -- monatlich: Monatsbetrag (optional); ruecklage: Jahresbetrag; ziel: Zielbetrag;
  -- erst_ich: fester Monatsbetrag (alternativ zu percent_bp)
  amount_cents  bigint check (amount_cents is null or amount_cents > 0),
  -- nur erst_ich: Anteil der Einnahmen des Monats in Basispunkten (1 = 0,01 %)
  percent_bp    integer check (percent_bp is null or percent_bp between 1 and 10000),
  -- nur ziel: Monat, in dem der Zielbetrag erreicht sein soll (Monatserster)
  target_month  date check (target_month is null or extract(day from target_month) = 1),
  sort_order    integer not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (kind = 'erst_ich' or percent_bp is null),
  check (kind = 'ziel' or target_month is null),
  check (kind not in ('ruecklage', 'ziel') or amount_cents is not null),
  check (kind <> 'erst_ich' or ((amount_cents is null) <> (percent_bp is null)))
);
create index pots_household_id_idx on pots (household_id, sort_order);
create unique index pots_name_idx on pots (household_id, lower(name)) where archived_at is null;

-- Zuweisung: Betrag für Topf und Monat. `automatik` = von der Erst-ich-Automatik gesetzt;
-- eine Person, die selbst zuweist, übernimmt den Wert (`manuell`), danach rührt ihn die
-- Automatik nicht mehr an.
create table pot_assignments (
  pot_id        uuid not null references pots (id) on delete cascade,
  month         date not null check (extract(day from month) = 1),
  amount_cents  bigint not null,
  source        text not null check (source in ('manuell', 'automatik')),
  updated_by    uuid references persons (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (pot_id, month)
);

-- Monatsabschluss je Haushalt. Abgeschlossene Monate nehmen keine Zuweisungen mehr an.
create table month_closings (
  household_id  uuid not null references households (id) on delete cascade,
  month         date not null check (extract(day from month) = 1),
  closed_by     uuid references persons (id) on delete set null,
  closed_at     timestamptz not null default now(),
  -- Stand des Monats beim Abschluss (Zusammenfassung und Töpfe), zum Nachlesen
  snapshot      jsonb not null,
  primary key (household_id, month)
);

-- Status-Spur einer Buchung: importiert (ohne Aufteilung) → vorgeschlagen (Aufteilung aus Regel
-- oder LLM, zählt schon im Budget) → bestaetigt (von einer Person bestätigt oder korrigiert).
alter table transactions
  add column confirmed_by    uuid references persons (id) on delete set null,
  add column confirmed_at    timestamptz,
  -- wann ein LLM zuletzt um einen Vorschlag gebeten wurde (auch ohne Ergebnis)
  add column llm_checked_at  timestamptz;

-- Aufteilung: ordnet eine Buchung Töpfen zu. `einnahme` fließt in „Noch ohne Aufgabe“,
-- `umbuchung` ist neutral (zwischen eigenen Konten desselben Haushalts).
create table transaction_splits (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references transactions (id) on delete cascade,
  kind            text not null check (kind in ('topf', 'einnahme', 'umbuchung')),
  pot_id          uuid references pots (id) on delete restrict,
  amount_cents    bigint not null check (amount_cents <> 0),
  check ((kind = 'topf') = (pot_id is not null))
);
create index transaction_splits_transaction_id_idx on transaction_splits (transaction_id);
create index transaction_splits_pot_id_idx on transaction_splits (pot_id);

-- Invarianten der Aufteilung, geprüft am Ende der Transaktion:
-- Summe = Buchungsbetrag, und jeder Topf gehört zum Haushalt des Kontos.
create function check_transaction_splits() returns trigger language plpgsql as $$
declare
  tid uuid := coalesce(new.transaction_id, old.transaction_id);
  total bigint;
  n integer;
  amount bigint;
  foreign_pots integer;
begin
  select coalesce(sum(s.amount_cents), 0), count(*) into total, n
    from transaction_splits s where s.transaction_id = tid;
  select t.amount_cents into amount from transactions t where t.id = tid;
  if amount is null then
    return null; -- Buchung wurde gelöscht
  end if;
  if n > 0 and total <> amount then
    raise exception 'Summe der Aufteilungen (%) ungleich Buchungsbetrag (%)', total, amount
      using errcode = 'check_violation';
  end if;
  select count(*) into foreign_pots
    from transaction_splits s
    join transactions t on t.id = s.transaction_id
    join accounts a on a.id = t.account_id
    join pots p on p.id = s.pot_id
   where s.transaction_id = tid and p.household_id <> a.household_id;
  if foreign_pots > 0 then
    raise exception 'Topf gehört nicht zum Haushalt des Kontos'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;
create constraint trigger transaction_splits_invariants
  after insert or update or delete on transaction_splits
  deferrable initially deferred
  for each row execute function check_transaction_splits();

-- Kategorisierungsregel: Muster → Ziel. Mindestens ein Merkmal ist gesetzt.
create table category_rules (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references households (id) on delete cascade,
  -- Merkmale (alle gesetzten müssen passen)
  account_id          uuid references accounts (id) on delete cascade,
  direction           text check (direction in ('eingang', 'ausgang')),
  counterparty_iban   text,
  counterparty_name   text,      -- normalisiert, Vergleich ohne Groß-/Kleinschreibung
  purpose_contains    text,      -- normalisiert, Teilstring ohne Groß-/Kleinschreibung
  min_amount_cents    bigint,
  max_amount_cents    bigint,
  -- Ziel
  kind                text not null check (kind in ('topf', 'einnahme', 'umbuchung')),
  pot_id              uuid references pots (id) on delete cascade,
  -- Herkunft: aus einer Korrektur entstanden oder von Hand angelegt
  origin              text not null check (origin in ('korrektur', 'manuell')),
  created_by          uuid references persons (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((kind = 'topf') = (pot_id is not null)),
  check (coalesce(account_id::text, direction, counterparty_iban, counterparty_name,
                  purpose_contains, min_amount_cents::text, max_amount_cents::text) is not null),
  check (min_amount_cents is null or max_amount_cents is null
         or min_amount_cents <= max_amount_cents)
);
create index category_rules_household_id_idx on category_rules (household_id);

-- Aktueller Vorschlag zu einer Buchung (höchstens einer).
create table transaction_suggestions (
  transaction_id  uuid primary key references transactions (id) on delete cascade,
  source          text not null check (source in ('regel', 'llm')),
  kind            text not null check (kind in ('topf', 'einnahme', 'umbuchung')),
  pot_id          uuid references pots (id) on delete cascade,
  confidence_pct  integer not null check (confidence_pct between 0 and 100),
  reason          text not null check (length(reason) between 1 and 300),
  rule_id         uuid references category_rules (id) on delete set null,
  created_at      timestamptz not null default now(),
  check ((kind = 'topf') = (pot_id is not null))
);
