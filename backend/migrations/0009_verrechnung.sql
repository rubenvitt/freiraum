-- FREI-28: Ausgleich mit der Einzahlung verrechnen. Statt 50 € zurückzuüberweisen und 500 €
-- einzuzahlen, zahlt man 450 € ein und verrechnet 50 €. Begründung und Rechenregeln: ADR 0006,
-- Abschnitt „Verrechnen mit der Einzahlung“.
--
-- Ein von Hand verbuchter Ausgleich hat jetzt eine Art:
-- `zahlung`     = Geld außerhalb der Konten erhalten (z. B. bar). Ohne Wirkung aufs Budget, wie
--                 bisher; nur für die eigene Forderung, also immer positiv.
-- `verrechnung` = mit der Einzahlung verrechnet. Zählt wie eine Einzahlung: im Gemeinsamen als
--                 Eingang, im privaten Haushalt der Person als Minderung von „Noch ohne Aufgabe“
--                 und im Ist der Einzahlungsregel.
--
-- Vorzeichen von `amount_cents`: positiv = das Gemeinsame erstattet der Person eine Forderung
-- (die Einzahlung zählt um den Betrag höher), negativ = die Person zahlt dem Gemeinsamen eine
-- Schuld zurück (die Einzahlung zählt um den Betrag niedriger). Negativ nur bei `verrechnung`.

alter table settlements
  add column kind text not null default 'zahlung' check (kind in ('zahlung', 'verrechnung')),
  drop constraint settlements_amount_cents_check,
  add constraint settlements_amount_cents_check
    check (amount_cents <> 0 and (kind = 'verrechnung' or amount_cents > 0));

-- Die Budgetrechnung des privaten Haushalts sucht Verrechnungen nach Person.
create index settlements_verrechnung_person_idx on settlements (person_id)
  where kind = 'verrechnung';
