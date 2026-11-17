-- FREI-24: Bargeldbestand. Eine Umbuchung kann ihr Gegenkonto nennen (`counter_account_id`), etwa
-- eine Abhebung vom Girokonto ins Bargeldkonto. Daraus ergibt sich je Bargeldkonto, wie viel
-- abgehobenes Bargeld noch nicht als Ausgabe erfasst ist. Rechenregel: ADR 0004.
--
-- Das Gegenkonto gehört zum selben Haushalt und ist nicht das Konto der Buchung selbst. Ohne
-- Gegenkonto bleibt eine Umbuchung wie bisher (z. B. aufs Sparkonto, das nicht angelegt ist).

alter table transaction_splits
  add column counter_account_id uuid references accounts (id) on delete set null,
  add constraint transaction_splits_counter_account_check
    check (counter_account_id is null or kind = 'umbuchung');
create index transaction_splits_counter_account_id_idx on transaction_splits (counter_account_id)
  where counter_account_id is not null;

alter table category_rules
  add column counter_account_id uuid references accounts (id) on delete set null,
  add constraint category_rules_counter_account_check
    check (counter_account_id is null or kind = 'umbuchung');

alter table transaction_suggestions
  add column counter_account_id uuid references accounts (id) on delete set null,
  add constraint transaction_suggestions_counter_account_check
    check (counter_account_id is null or kind = 'umbuchung');

-- Gegenkonto einer Aufteilung: gleicher Haushalt wie das Konto der Buchung, nicht dasselbe Konto.
create function check_split_counter_account() returns trigger language plpgsql as $$
declare
  bad integer;
begin
  if new.counter_account_id is null then
    return null;
  end if;
  select count(*) into bad
    from transactions t
    join accounts a on a.id = t.account_id
    join accounts c on c.id = new.counter_account_id
   where t.id = new.transaction_id
     and (c.id = a.id or c.household_id <> a.household_id);
  if bad > 0 then
    raise exception 'Gegenkonto gehört nicht zum Haushalt des Kontos oder ist das Konto selbst'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;
create constraint trigger transaction_splits_counter_account
  after insert or update on transaction_splits
  deferrable initially deferred
  for each row execute function check_split_counter_account();
