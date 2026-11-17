-- FREI-19: Freigabe „sparquote“. Die andere Person sieht die Sparquote des Monats als
-- Prozentwert, ohne Beträge (ADR 0005, ADR 0006).

alter table shares drop constraint shares_scope_check;
alter table shares add constraint shares_scope_check
  check (scope in ('erst_ich', 'ruecklagen', 'einzahlung_soll', 'budget', 'sparquote'));
