-- FREI-13: Budgetbeginn und Anfangsbestand je Haushalt (ADR 0003, „Budgetbeginn“).
-- Beträge sind ganze Cent (bigint). Monate werden als `date` am Monatsersten gespeichert.

-- Startmonat des Budgets. Buchungen davor zählen nicht im Budget (Import, Serienerkennung und
-- Auswertungen behalten sie). Neue Haushalte starten im laufenden Monat, damit ein Import mit
-- voller Historie nicht alle alten Einnahmen in „Noch ohne Aufgabe“ spült.
alter table households
  add column budget_start_month date not null default (date_trunc('month', current_date))::date
    check (extract(day from budget_start_month) = 1);

-- Bekannter Kontostand eines Kontos: Stand am Ende von `balance_date`, also einschließlich aller
-- Buchungen bis zu diesem Tag. Daraus wird der Anfangsbestand zum Budgetbeginn abgeleitet
-- (Stand − Buchungen ab Budgetbeginn bis zum Stichtag). Quelle: von Hand oder vom Anbieter.
alter table accounts
  add column balance_cents       bigint,
  add column balance_date        date,
  add column balance_source      text check (balance_source in ('manuell', 'anbieter')),
  add column balance_updated_at  timestamptz,
  add check (
    (balance_cents is null) = (balance_date is null)
    and (balance_cents is null) = (balance_source is null)
    and (balance_cents is null) = (balance_updated_at is null)
  );
