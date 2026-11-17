-- FREI-18: Umgekehrter Ausgleich. Das gemeinsame Konto zahlt etwas Privates (z. B. mit der Karte
-- des gemeinsamen Kontos), und die Buchung wird einem privaten Topf eines Mitglieds zugeordnet.
-- Der private Topf trägt die Ausgabe; die Person schuldet dem Gemeinsamen den Betrag. Begründung
-- und Rechenregeln: ADR 0006, Abschnitt „Umgekehrter Ausgleich“.
--
-- Damit hat `ausgleich` keine feste Richtung mehr: Vom gemeinsamen aufs private Konto erstattet
-- das Gemeinsame eine Forderung, vom privaten aufs gemeinsame zahlt die Person eine Schuld
-- zurück. Beides bleibt ohne Wirkung aufs Budget. `einzahlung` behält ihre feste Richtung.

-- Invarianten der Aufteilung, geprüft am Ende der Transaktion (ersetzt die Fassung aus 0005):
-- 1. Summe = Buchungsbetrag.
-- 2. Ein Topf gehört zum Haushalt des Kontos, oder
--    a) das Konto ist privat und der Topf gehört zu einem gemeinsamen Haushalt, in dem der
--       Kontoinhaber Mitglied ist (Ausgleich), oder
--    b) das Konto ist gemeinsam und der Topf gehört zum privaten Haushalt eines Mitglieds
--       (umgekehrter Ausgleich). Dass nur die Inhaberin selbst ihren Topf wählt, prüft der Dienst.
-- 3. Einzahlung und Ausgleich gibt es nur zwischen einem privaten und einem gemeinsamen
--    Haushalt; auf gemeinsamen Konten mit einem Mitglied als Person. Die Einzahlung hat eine
--    feste Richtung (privat Ausgang, gemeinsam Eingang), der Ausgleich nicht.
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
       select 1 from household_members m where m.household_id = hp.id and m.person_id = hh_owner))
     and not (hh_kind = 'gemeinsam' and hp.kind = 'privat' and exists (
       select 1 from household_members m
        where m.household_id = hh_id and m.person_id = hp.owner_person_id));
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
         and (s.kind = 'ausgleich' or s.amount_cents < 0)
         and exists (select 1 from household_members m join households h on h.id = m.household_id
                      where m.person_id = hh_owner and h.kind = 'gemeinsam')
       else
         s.person_id is not null
         and (s.kind = 'ausgleich' or s.amount_cents > 0)
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
