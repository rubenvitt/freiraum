-- E4: Paar-Modell. Einzahlungen ins Gemeinsame, Ausgleich privat bezahlter gemeinsamer Ausgaben,
-- Einzahlungsregeln und Freigaben. Rechenregeln und Begründungen: ADR 0006.

-- Neue Arten der Aufteilung:
-- `einzahlung` = Geld vom privaten ins gemeinsame Konto. Privat ein Ausgang, der „Noch ohne
--   Aufgabe“ mindert; gemeinsam ein Eingang, der wie eine Einnahme zählt.
-- `ausgleich` = Erstattung einer privat bezahlten gemeinsamen Ausgabe, vom gemeinsamen aufs
--   private Konto. Auf beiden Seiten ohne Wirkung aufs Budget (die Ausgabe zählt schon im
--   gemeinsamen Topf).
-- Auf gemeinsamen Konten nennt `person_id`, von wem bzw. an wen das Geld geht. Auf privaten
-- Konten ist das immer der Inhaber, dort bleibt `person_id` leer.

alter table transaction_splits
  drop constraint transaction_splits_kind_check,
  add constraint transaction_splits_kind_check
    check (kind in ('topf', 'einnahme', 'umbuchung', 'einzahlung', 'ausgleich')),
  add column person_id uuid references persons (id) on delete restrict,
  add constraint transaction_splits_person_check
    check (person_id is null or kind in ('einzahlung', 'ausgleich'));
create index transaction_splits_person_id_idx on transaction_splits (person_id)
  where person_id is not null;

alter table category_rules
  drop constraint category_rules_kind_check,
  add constraint category_rules_kind_check
    check (kind in ('topf', 'einnahme', 'umbuchung', 'einzahlung', 'ausgleich')),
  add column person_id uuid references persons (id) on delete cascade,
  add constraint category_rules_person_check
    check (person_id is null or kind in ('einzahlung', 'ausgleich'));

-- `abgleich` = erkannte Überweisung zwischen eigenen Konten (über die IBAN).
alter table transaction_suggestions
  drop constraint transaction_suggestions_source_check,
  add constraint transaction_suggestions_source_check
    check (source in ('regel', 'abgleich', 'llm')),
  drop constraint transaction_suggestions_kind_check,
  add constraint transaction_suggestions_kind_check
    check (kind in ('topf', 'einnahme', 'umbuchung', 'einzahlung', 'ausgleich')),
  add column person_id uuid references persons (id) on delete cascade,
  add constraint transaction_suggestions_person_check
    check (person_id is null or kind in ('einzahlung', 'ausgleich'));

-- Invarianten der Aufteilung, geprüft am Ende der Transaktion (ersetzt die Fassung aus 0003):
-- 1. Summe = Buchungsbetrag.
-- 2. Ein Topf gehört zum Haushalt des Kontos, oder das Konto ist privat und der Topf gehört
--    zu einem gemeinsamen Haushalt, in dem der Kontoinhaber Mitglied ist (Ausgleich).
-- 3. Einzahlung und Ausgleich gibt es nur zwischen einem privaten und einem gemeinsamen
--    Haushalt, mit fester Richtung; auf gemeinsamen Konten mit einem Mitglied als Person.
create or replace function check_transaction_splits() returns trigger language plpgsql as $$
declare
  tid uuid := coalesce(new.transaction_id, old.transaction_id);
  total bigint;
  n integer;
  amount bigint;
  hh_kind text;
  hh_owner uuid;
  hh_id uuid;
  bad integer;
begin
  select coalesce(sum(s.amount_cents), 0), count(*) into total, n
    from transaction_splits s where s.transaction_id = tid;
  select t.amount_cents, h.kind, h.owner_person_id, h.id into amount, hh_kind, hh_owner, hh_id
    from transactions t
    join accounts a on a.id = t.account_id
    join households h on h.id = a.household_id
   where t.id = tid;
  if amount is null then
    return null; -- Buchung wurde gelöscht
  end if;
  if n > 0 and total <> amount then
    raise exception 'Summe der Aufteilungen (%) ungleich Buchungsbetrag (%)', total, amount
      using errcode = 'check_violation';
  end if;

  select count(*) into bad
    from transaction_splits s
    join pots p on p.id = s.pot_id
    join households hp on hp.id = p.household_id
   where s.transaction_id = tid and p.household_id <> hh_id
     and not (hh_kind = 'privat' and hp.kind = 'gemeinsam' and exists (
       select 1 from household_members m where m.household_id = hp.id and m.person_id = hh_owner));
  if bad > 0 then
    raise exception 'Topf gehört nicht zum Haushalt des Kontos'
      using errcode = 'check_violation';
  end if;

  select count(*) into bad
    from transaction_splits s
   where s.transaction_id = tid and s.kind in ('einzahlung', 'ausgleich')
     and not case hh_kind
       when 'privat' then
         s.person_id is null
         and (s.kind = 'einzahlung') = (s.amount_cents < 0)
         and exists (select 1 from household_members m join households h on h.id = m.household_id
                      where m.person_id = hh_owner and h.kind = 'gemeinsam')
       else
         s.person_id is not null
         and (s.kind = 'einzahlung') = (s.amount_cents > 0)
         and exists (select 1 from household_members m
                      where m.household_id = hh_id and m.person_id = s.person_id)
     end;
  if bad > 0 then
    raise exception 'Einzahlung oder Ausgleich passt nicht zu Konto, Richtung oder Person'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

-- Einzahlungsregel: wie viel eine Person ab einem Monat ins Gemeinsame gibt, fest oder als
-- Anteil ihrer Einnahmen im privaten Haushalt (Netto). Es gilt die jüngste Regel mit
-- `valid_from` ≤ Monat; so bleibt die Historie nachvollziehbar.
create table contribution_rules (
  household_id  uuid not null references households (id) on delete cascade,
  person_id     uuid not null references persons (id) on delete cascade,
  valid_from    date not null check (extract(day from valid_from) = 1),
  kind          text not null check (kind in ('fest', 'prozent')),
  -- fest: Monatsbetrag (0 = Pause)
  amount_cents  bigint check (amount_cents is null or amount_cents >= 0),
  -- prozent: Anteil der Einnahmen des Monats in Basispunkten (1 = 0,01 %)
  percent_bp    integer check (percent_bp is null or percent_bp between 1 and 10000),
  updated_by    uuid references persons (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (household_id, person_id, valid_from),
  check ((kind = 'fest') = (amount_cents is not null)),
  check ((kind = 'prozent') = (percent_bp is not null))
);

-- Ausgleich von Hand verbucht (z. B. bar übergeben): mindert, was das Gemeinsame der Person
-- schuldet. Erstattungen per Überweisung ergeben sich aus den Aufteilungen (`ausgleich`).
create table settlements (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  person_id     uuid not null references persons (id) on delete cascade,
  amount_cents  bigint not null check (amount_cents > 0),
  settled_on    date not null,
  note          text check (note is null or length(note) between 1 and 300),
  created_by    uuid references persons (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index settlements_household_id_idx on settlements (household_id, person_id);

-- Freigabe: Person `owner` gibt Person `grantee` eine Kennzahl oder Sicht auf ihren privaten
-- Haushalt frei. Ohne Freigabe sieht `grantee` nichts daraus. Geprüft wird bei jeder Anfrage.
create table shares (
  owner_person_id    uuid not null references persons (id) on delete cascade,
  grantee_person_id  uuid not null references persons (id) on delete cascade,
  scope              text not null
                       check (scope in ('erst_ich', 'ruecklagen', 'einzahlung_soll', 'budget')),
  created_at         timestamptz not null default now(),
  primary key (owner_person_id, grantee_person_id, scope),
  check (owner_person_id <> grantee_person_id)
);
create index shares_grantee_idx on shares (grantee_person_id);
