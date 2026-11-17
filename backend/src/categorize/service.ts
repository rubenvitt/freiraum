/**
 * Kategorisierung mit wenig Pflege: Regeln greifen zuerst, ohne Treffer schlägt ein LLM vor
 * (falls angebunden). Vorschläge legen gleich eine Aufteilung an (Status `vorgeschlagen`), damit
 * das Budget stimmt, bevor jemand bestätigt. Eine Korrektur wird zur Regel.
 *
 * Zugriff: nur Mitglieder des Haushalts, zu dem das Konto gehört. Töpfe kommen aus dem Haushalt
 * des Kontos; ein privates Konto darf zusätzlich Töpfe des gemeinsamen Haushalts verwenden, in
 * dem die Inhaberin Mitglied ist (daraus entsteht ein Ausgleich, ADR 0006). Umgekehrt darf ein
 * Mitglied eine Buchung des gemeinsamen Kontos dem eigenen privaten Topf zuordnen (daraus
 * entsteht eine Schuld ans Gemeinsame, FREI-18), nie dem Topf der anderen Person und nie per
 * Regel. Die Datenbank prüft das zusätzlich.
 *
 * Überweisungen zwischen eigenen Konten erkennt der Abgleich über die IBAN (Umbuchung,
 * Einzahlung ins Gemeinsame, Erstattung), nach den Regeln und vor dem LLM. Solche Buchungen
 * gehen deshalb nie an ein Modell.
 */
import type { TransactionSql } from 'postgres'
import { monthOf } from '../budget/months.js'
import type { BudgetService } from '../budget/service.js'
import { cents } from '../db/cents.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { type IsoDate, todayUtc } from '../ledger/dates.js'
import type { LlmCategorizer, LlmOption, LlmSuggestion } from './llm.js'
import {
  bestRule,
  criteriaFromCorrection,
  describeCriteria,
  directionOf,
  type HouseholdKind,
  type MatchableTransaction,
  type Rule,
  type RuleCriteria,
  requiredDirection,
  type SplitKind,
  type Target,
  targetFits,
  usualDirection,
} from './rules.js'

type Sql = Db | TransactionSql

export interface Split {
  kind: SplitKind
  potId: string | null
  /** nur bei `einzahlung` und `ausgleich` auf gemeinsamen Konten */
  personId: string | null
  /** nur bei `umbuchung`: Gegenkonto im selben Haushalt */
  counterAccountId: string | null
  amountCents: number
}

export interface Suggestion {
  source: 'regel' | 'abgleich' | 'llm'
  kind: SplitKind
  potId: string | null
  personId: string | null
  counterAccountId: string | null
  confidencePct: number
  reason: string
  ruleId: string | null
}

export interface Categorization {
  splits: Split[]
  suggestion: Suggestion | null
}

export type RuleInput = Partial<RuleCriteria> &
  Omit<Target, 'personId' | 'counterAccountId'> & {
    personId?: string | null | undefined
    counterAccountId?: string | null | undefined
  }

/** Aufteilungen und Vorschläge zu Buchungen laden (für Listen). */
export async function loadCategorizations(
  sql: Sql,
  transactionIds: string[],
): Promise<Map<string, Categorization>> {
  const result = new Map<string, Categorization>(
    transactionIds.map((id) => [id, { splits: [], suggestion: null }]),
  )
  if (transactionIds.length === 0) return result
  const splits = await sql<
    {
      transaction_id: string
      kind: SplitKind
      pot_id: string | null
      person_id: string | null
      counter_account_id: string | null
      amount_cents: string
    }[]
  >`
    select transaction_id, kind, pot_id, person_id, counter_account_id, amount_cents
    from transaction_splits
    where transaction_id = any(${transactionIds}::uuid[])
    order by transaction_id, abs(amount_cents) desc, id
  `
  for (const s of splits) {
    result.get(s.transaction_id)?.splits.push({
      kind: s.kind,
      potId: s.pot_id,
      personId: s.person_id,
      counterAccountId: s.counter_account_id,
      amountCents: cents(s.amount_cents),
    })
  }
  const suggestions = await sql<
    {
      transaction_id: string
      source: 'regel' | 'abgleich' | 'llm'
      kind: SplitKind
      pot_id: string | null
      person_id: string | null
      counter_account_id: string | null
      confidence_pct: number
      reason: string
      rule_id: string | null
    }[]
  >`
    select transaction_id, source, kind, pot_id, person_id, counter_account_id, confidence_pct,
      reason, rule_id
    from transaction_suggestions where transaction_id = any(${transactionIds}::uuid[])
  `
  for (const s of suggestions) {
    const entry = result.get(s.transaction_id)
    if (entry) {
      entry.suggestion = {
        source: s.source,
        kind: s.kind,
        potId: s.pot_id,
        personId: s.person_id,
        counterAccountId: s.counter_account_id,
        confidencePct: s.confidence_pct,
        reason: s.reason,
        ruleId: s.rule_id,
      }
    }
  }
  return result
}

interface RuleRow {
  id: string
  household_id: string
  account_id: string | null
  direction: 'eingang' | 'ausgang' | null
  counterparty_iban: string | null
  counterparty_name: string | null
  purpose_contains: string | null
  min_amount_cents: string | null
  max_amount_cents: string | null
  kind: SplitKind
  pot_id: string | null
  person_id: string | null
  counter_account_id: string | null
  origin: 'korrektur' | 'manuell'
  created_at: Date
  updated_at: Date
}

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  householdId: r.household_id,
  accountId: r.account_id,
  direction: r.direction,
  counterpartyIban: r.counterparty_iban,
  counterpartyName: r.counterparty_name,
  purposeContains: r.purpose_contains,
  minAmountCents: r.min_amount_cents === null ? null : cents(r.min_amount_cents),
  maxAmountCents: r.max_amount_cents === null ? null : cents(r.max_amount_cents),
  kind: r.kind,
  potId: r.pot_id,
  personId: r.person_id,
  counterAccountId: r.counter_account_id,
  origin: r.origin,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface TxRow {
  id: string
  account_id: string
  household_id: string
  household_kind: HouseholdKind
  owner_person_id: string | null
  booking_date: string
  amount_cents: string
  counterparty_name: string | null
  counterparty_iban: string | null
  purpose: string | null
  status: 'importiert' | 'vorgeschlagen' | 'bestaetigt'
  /** Buchungstag ab dem Budgetbeginn des Haushalts (nur aus `loadTransactions`). */
  in_budget?: boolean
}

const toMatchable = (t: TxRow): MatchableTransaction => ({
  accountId: t.account_id,
  amountCents: cents(t.amount_cents),
  counterpartyName: t.counterparty_name,
  counterpartyIban: t.counterparty_iban,
  purpose: t.purpose,
})

const transactionNotFound = () =>
  new ApiError(404, 'buchung_nicht_gefunden', 'Diese Buchung gibt es nicht.')

const sameTarget = (a: Target, b: Target) =>
  a.kind === b.kind &&
  a.potId === b.potId &&
  a.personId === b.personId &&
  a.counterAccountId === b.counterAccountId

interface HouseholdInfo {
  id: string
  kind: HouseholdKind
  ownerPersonId: string | null
}

const householdOf = (t: TxRow): HouseholdInfo => ({
  id: t.household_id,
  kind: t.household_kind,
  ownerPersonId: t.owner_person_id,
})

const KIND_LABEL: Record<SplitKind, string> = {
  topf: 'Topf',
  einnahme: 'Einnahme',
  umbuchung: 'Umbuchung',
  einzahlung: 'Einzahlung',
  ausgleich: 'Ausgleich',
}

/** Abbruch eines LLM-Laufs nach so vielen fehlgeschlagenen Anfragen (Netzwerk, Zeit) in Folge. */
export const LLM_MAX_FAILURES_IN_ROW = 3
/** Buchungen je LLM-Anfrage. */
export const LLM_BATCH_SIZE = 20
/** Höchstens so viele LLM-Anfragen gleichzeitig. */
export const LLM_CONCURRENCY = 3
/** Buchungen je Nachholen (alle 15 Minuten). */
export const LLM_RETRY_LIMIT = 1_000

/**
 * IBANs aus Freitext entfernen, bevor er an das Modell geht. Verwendungszwecke enthalten oft
 * die IBAN der Gegenseite („IBAN: DE…“), das Modell braucht sie nicht.
 */
export function maskIbans(text: string | null): string | null {
  if (text === null) return null
  // Länderkürzel, Prüfziffern, dann Vierergruppen (mit oder ohne Leerzeichen) und ein Rest.
  return text.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (match) =>
    /\d{6}/.test(match.replace(/ /g, '')) ? '[IBAN]' : match,
  )
}

export class CategorizationService {
  constructor(
    private readonly db: Db,
    private readonly budget: BudgetService,
    private readonly llm: LlmCategorizer | null = null,
  ) {}

  // --- Hilfen ------------------------------------------------------------------

  private async loadTransactions(sql: Sql, ids: string[]): Promise<TxRow[]> {
    if (ids.length === 0) return []
    return sql<TxRow[]>`
      select t.id, t.account_id, a.household_id, h.kind as household_kind, h.owner_person_id,
             t.booking_date::text, t.amount_cents, t.counterparty_name, t.counterparty_iban,
             t.purpose, t.status, t.booking_date >= h.budget_start_month as in_budget
      from transactions t
      join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      where t.id = any(${ids}::uuid[])
    `
  }

  /**
   * Buchung sperren, sofern die Person Zugriff hat; sonst 404. Vorher werden alle Konten des
   * Haushalts in fester Reihenfolge gesperrt: Korrekturen schreiben Vorschläge auch in andere
   * Konten, und Importe sperren ihr Konto, bevor sie den Haushalt sperren.
   */
  private async lockAccessibleTransaction(
    tx: TransactionSql,
    personId: string,
    transactionId: string,
  ): Promise<TxRow> {
    const [access] = await tx<{ household_id: string }[]>`
      select a.household_id from transactions t
      join accounts a on a.id = t.account_id
      join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
      where t.id = ${transactionId}
    `
    if (!access) throw transactionNotFound()
    await this.lockHouseholdAccounts(tx, access.household_id)
    const [row] = await tx<TxRow[]>`
      select t.id, t.account_id, a.household_id, h.kind as household_kind, h.owner_person_id,
             t.booking_date::text, t.amount_cents, t.counterparty_name, t.counterparty_iban,
             t.purpose, t.status
      from transactions t join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      where t.id = ${transactionId}
      for update of t
    `
    if (!row) throw transactionNotFound()
    return row
  }

  private async lockHouseholdAccounts(tx: TransactionSql, householdId: string): Promise<void> {
    await tx`select id from accounts where household_id = ${householdId} order by id for update`
  }

  private async activeRules(sql: Sql, householdId: string): Promise<Rule[]> {
    const rows = await sql<RuleRow[]>`
      select r.* from category_rules r
      left join pots p on p.id = r.pot_id
      where r.household_id = ${householdId} and (r.pot_id is null or p.archived_at is null)
    `
    return rows.map(toRule)
  }

  private async household(sql: Sql, householdId: string): Promise<HouseholdInfo> {
    const [row] = await sql<{ id: string; kind: HouseholdKind; owner_person_id: string | null }[]>`
      select id, kind, owner_person_id from households where id = ${householdId}
    `
    if (!row) throw new ApiError(404, 'haushalt_nicht_gefunden', 'Diesen Haushalt gibt es nicht.')
    return { id: row.id, kind: row.kind, ownerPersonId: row.owner_person_id }
  }

  /**
   * Ziel prüfen und die Person vereinheitlichen. Ein Topf ist aktiv und gehört
   * - zum Haushalt,
   * - bei privaten Haushalten zu einem gemeinsamen, in dem die Inhaberin Mitglied ist, oder
   * - bei gemeinsamen Haushalten zum privaten Haushalt von `actorId` (umgekehrter Ausgleich).
   *   Für Regeln (`actorId` null) nie: Eine Regel träfe auch die Käufe der anderen Person.
   * Einzahlung und Ausgleich gibt es nur zwischen privatem und gemeinsamem Haushalt, die
   * Einzahlung mit fester Richtung (`amountCents`, falls bekannt); im Gemeinsamen mit einem
   * Mitglied als Person.
   * Ein Gegenkonto gibt es nur bei einer Umbuchung, aus demselben Haushalt und nicht das Konto
   * der Buchung (`accountId`, falls bekannt).
   */
  private async checkTarget(
    sql: Sql,
    household: HouseholdInfo,
    target: Target,
    amountCents: number | null,
    actorId: string | null,
    accountId: string | null = null,
  ): Promise<Target> {
    const fail = (code: string, message: string) => new ApiError(422, code, message)
    if ((target.kind === 'topf') !== (target.potId !== null)) {
      throw fail('ziel_ungueltig', 'Ein Topf ist genau bei der Art „topf“ anzugeben.')
    }
    if (target.counterAccountId !== null) {
      if (target.kind !== 'umbuchung') {
        throw fail('ziel_ungueltig', 'Ein Gegenkonto gibt es nur bei einer Umbuchung.')
      }
      const [counter] = await sql`
        select 1 from accounts where id = ${target.counterAccountId}
          and household_id = ${household.id}
      `
      if (!counter) {
        throw fail('gegenkonto_ungueltig', 'Das Gegenkonto gehört nicht zu diesem Haushalt.')
      }
      if (target.counterAccountId === accountId) {
        throw fail('gegenkonto_ungueltig', 'Das Gegenkonto ist das Konto der Buchung selbst.')
      }
    }
    const paired = target.kind === 'einzahlung' || target.kind === 'ausgleich'
    if (!paired && target.personId !== null) {
      throw fail('ziel_ungueltig', 'Eine Person gibt es nur bei Einzahlung und Ausgleich.')
    }
    if (target.potId !== null) {
      const [pot] = await sql<
        {
          household_id: string
          archived_at: Date | null
          owner_person_id: string | null
          shared_member: boolean
          member_private: boolean
        }[]
      >`
        select p.household_id, p.archived_at, h.owner_person_id,
          (h.kind = 'gemeinsam' and exists (
             select 1 from household_members m
             where m.household_id = h.id and m.person_id = ${household.ownerPersonId}))
            as shared_member,
          (h.kind = 'privat' and exists (
             select 1 from household_members m
             where m.household_id = ${household.id} and m.person_id = h.owner_person_id))
            as member_private
        from pots p join households h on h.id = p.household_id
        where p.id = ${target.potId}
      `
      const fromShared = household.kind === 'gemeinsam' && pot?.member_private === true
      if (fromShared && actorId === null) {
        throw fail(
          'regel_privater_topf',
          'Eine Regel im gemeinsamen Haushalt kann keinen privaten Topf belasten.',
        )
      }
      const allowed =
        pot !== undefined &&
        (pot.household_id === household.id ||
          (household.kind === 'privat' && pot.shared_member) ||
          (fromShared && pot.owner_person_id === actorId))
      if (!pot || !allowed) {
        throw fail('topf_anderer_haushalt', 'Der Topf gehört nicht zum Haushalt dieses Kontos.')
      }
      if (pot.archived_at !== null) {
        throw fail('topf_archiviert', 'Dieser Topf ist archiviert.')
      }
      return target
    }
    if (!paired) return target
    if (amountCents !== null && !targetFits(target, household.kind, amountCents)) {
      const expected = requiredDirection(target.kind, household.kind)
      throw fail(
        'richtung_unpassend',
        `${KIND_LABEL[target.kind]} ist in diesem Haushalt immer ein ${
          expected === 'eingang' ? 'Eingang' : 'Ausgang'
        }.`,
      )
    }
    if (household.kind === 'privat') {
      if (target.personId !== null && target.personId !== household.ownerPersonId) {
        throw fail('person_ungueltig', 'Auf einem privaten Konto zählt immer die Inhaberin.')
      }
      const [shared] = await sql`
        select 1 from household_members m join households h on h.id = m.household_id
        where m.person_id = ${household.ownerPersonId} and h.kind = 'gemeinsam'
      `
      if (!shared) {
        throw fail('kein_gemeinsamer_haushalt', 'Es gibt noch keinen gemeinsamen Haushalt.')
      }
      return { ...target, personId: null }
    }
    if (target.personId === null) {
      throw fail('person_fehlt', 'Bitte angeben, von wem bzw. an wen das Geld geht.')
    }
    const [member] = await sql`
      select 1 from household_members
      where household_id = ${household.id} and person_id = ${target.personId}
    `
    if (!member) throw fail('person_ungueltig', 'Diese Person gehört nicht zum Haushalt.')
    return target
  }

  /**
   * Einzelfälle, aus denen keine Regel entsteht (FREI-18): eine Buchung des gemeinsamen Kontos
   * in einem privaten Topf (eine Regel träfe auch die Käufe der anderen Person) und ein Ausgleich
   * gegen die übliche Richtung (eine Regel machte aus künftigen Einzahlungen Rückzahlungen).
   */
  private async isOneOff(sql: Sql, household: HouseholdInfo, split: Split): Promise<boolean> {
    if (split.kind === 'ausgleich') {
      return directionOf(split.amountCents) !== usualDirection(split.kind, household.kind)
    }
    if (split.potId === null || household.kind !== 'gemeinsam') return false
    const [other] = await sql`
      select 1 from pots where id = ${split.potId} and household_id <> ${household.id}
    `
    return other !== undefined
  }

  /**
   * Abgleich: Ist die Gegenpartei ein eigenes Konto (gleiche IBAN)? Dann Umbuchung (gleicher
   * Haushalt), Einzahlung ins Gemeinsame oder Erstattung (Ausgleich). Die Begründung nennt nie
   * ein privates Konto der anderen Person, nur ihren Namen.
   */
  private async detectTransfer(sql: Sql, t: TxRow): Promise<(Target & { reason: string }) | null> {
    const amount = cents(t.amount_cents)
    if (!t.counterparty_iban || amount === 0) return null
    const candidates = await sql<
      {
        account_id: string
        household_id: string
        kind: HouseholdKind
        owner_person_id: string | null
        owner_name: string | null
        related: boolean
      }[]
    >`
      select a.id as account_id, a.household_id, h.kind, h.owner_person_id, p.display_name as owner_name,
        exists (
          select 1 from household_members m
          where (h.kind = 'gemeinsam' and m.household_id = h.id
                 and m.person_id = ${t.owner_person_id})
             or (h.kind = 'privat' and m.household_id = ${t.household_id}
                 and m.person_id = h.owner_person_id)
        ) as related
      from accounts a
      join households h on h.id = a.household_id
      left join persons p on p.id = h.owner_person_id
      where a.iban = ${t.counterparty_iban} and a.id <> ${t.account_id}
      order by a.created_at
    `
    for (const c of candidates) {
      if (c.household_id === t.household_id) {
        return {
          kind: 'umbuchung',
          potId: null,
          personId: null,
          counterAccountId: c.account_id,
          reason: 'Abgleich: Überweisung zwischen eigenen Konten dieses Haushalts',
        }
      }
      if (!c.related) continue
      if (t.household_kind === 'privat' && c.kind === 'gemeinsam') {
        return amount < 0
          ? {
              kind: 'einzahlung',
              potId: null,
              personId: null,
              counterAccountId: null,
              reason: 'Abgleich: Überweisung aufs gemeinsame Konto',
            }
          : {
              kind: 'ausgleich',
              potId: null,
              personId: null,
              counterAccountId: null,
              reason: 'Abgleich: Erstattung vom gemeinsamen Konto',
            }
      }
      if (t.household_kind === 'gemeinsam' && c.kind === 'privat' && c.owner_person_id) {
        return amount > 0
          ? {
              kind: 'einzahlung',
              potId: null,
              personId: c.owner_person_id,
              counterAccountId: null,
              reason: `Abgleich: Einzahlung von ${c.owner_name}`,
            }
          : {
              kind: 'ausgleich',
              potId: null,
              personId: c.owner_person_id,
              counterAccountId: null,
              reason: `Abgleich: Erstattung an ${c.owner_name}`,
            }
      }
    }
    return null
  }

  private async replaceSplits(
    tx: TransactionSql,
    transactionId: string,
    splits: Split[],
  ): Promise<void> {
    await tx`delete from transaction_splits where transaction_id = ${transactionId}`
    if (splits.length === 0) return
    await tx`
      insert into transaction_splits ${tx(
        splits.map((s) => ({
          transaction_id: transactionId,
          kind: s.kind,
          pot_id: s.potId,
          person_id: s.personId,
          counter_account_id: s.counterAccountId,
          amount_cents: s.amountCents,
        })),
      )}
    `
  }

  /** Erst-ich für alle berührten Haushalt-Monate neu rechnen. */
  private async refreshErstIch(
    tx: TransactionSql,
    touched: Iterable<{ householdId: string; bookingDate: string }>,
    asOf: IsoDate,
  ): Promise<void> {
    const keys = new Set<string>()
    for (const t of touched) keys.add(`${t.householdId}|${monthOf(t.bookingDate)}`)
    for (const key of [...keys].sort()) {
      const [householdId, month] = key.split('|') as [string, string]
      await this.budget.runErstIch(tx, householdId, month, asOf)
    }
  }

  // --- Regeln anwenden ---------------------------------------------------------

  /**
   * Regeln auf noch nicht bestätigte Buchungen anwenden. Ein Treffer ersetzt Aufteilung und
   * Vorschlag; ohne Treffer bleibt ein vorhandener LLM-Vorschlag stehen, ein veralteter
   * Regelvorschlag wird entfernt. Erwartet eine offene Transaktion (Konto bereits gesperrt
   * oder nicht nötig, weil die Buchungen frisch sind).
   *
   * Buchungen über 0 Cent (etwa ein Kontoabschluss ohne Entgelt) haben nichts zuzuordnen: Sie
   * gelten ohne Aufteilung gleich als bestätigt, damit sie den Monatsabschluss nicht aufhalten.
   * Eine Aufteilung über 0 Cent ließe die Datenbank ohnehin nicht zu.
   */
  async applyRules(tx: TransactionSql, transactionIds: string[], asOf: IsoDate): Promise<number> {
    // Vor dem Budgetbeginn braucht es keine Vorschläge.
    const open = (await this.loadTransactions(tx, transactionIds)).filter(
      (t) => t.status !== 'bestaetigt' && t.in_budget === true,
    )
    const zero = open.filter((t) => cents(t.amount_cents) === 0).map((t) => t.id)
    if (zero.length > 0) {
      await tx`delete from transaction_suggestions where transaction_id = any(${zero}::uuid[])`
      await tx`
        update transactions set status = 'bestaetigt', confirmed_by = null, confirmed_at = now()
        where id = any(${zero}::uuid[])
      `
    }
    const rows = open.filter((t) => cents(t.amount_cents) !== 0)
    const rulesByHousehold = new Map<string, Rule[]>()
    const touched: TxRow[] = []
    let suggested = 0
    for (const t of rows) {
      let rules = rulesByHousehold.get(t.household_id)
      if (!rules) {
        rules = await this.activeRules(tx, t.household_id)
        rulesByHousehold.set(t.household_id, rules)
      }
      // Nur Regeln, deren Ziel zur Richtung passt (Einzahlung und Ausgleich haben eine feste).
      const amount = cents(t.amount_cents)
      const rule = bestRule(
        rules.filter((r) => targetFits(r, t.household_kind, amount)),
        toMatchable(t),
      )
      const transfer = rule ? null : await this.detectTransfer(tx, t)
      if (!rule && !transfer) {
        const [stale] = await tx<{ n: number }[]>`
          with removed as (
            delete from transaction_suggestions
            where transaction_id = ${t.id} and source in ('regel', 'abgleich') returning 1
          )
          select count(*)::int as n from removed
        `
        if (stale && stale.n > 0) {
          await this.replaceSplits(tx, t.id, [])
          await tx`update transactions set status = 'importiert' where id = ${t.id}`
          touched.push(t)
        }
        continue
      }
      // Ein Gegenkonto, das das Konto der Buchung selbst ist, fällt weg (Regel ohne Kontomerkmal).
      const counter = (rule ?? (transfer as Target)).counterAccountId
      const target: Target = rule
        ? {
            kind: rule.kind,
            potId: rule.potId,
            personId: rule.personId,
            counterAccountId: counter === t.account_id ? null : counter,
          }
        : {
            kind: (transfer as Target).kind,
            potId: null,
            personId: (transfer as Target).personId,
            counterAccountId: counter,
          }
      const source = rule ? 'regel' : 'abgleich'
      const reason = (rule ? `Regel: ${describeCriteria(rule)}` : (transfer?.reason ?? '')).slice(
        0,
        300,
      )
      await this.replaceSplits(tx, t.id, [{ ...target, amountCents: amount }])
      await tx`
        insert into transaction_suggestions
          (transaction_id, source, kind, pot_id, person_id, counter_account_id, confidence_pct,
           reason, rule_id)
        values (${t.id}, ${source}, ${target.kind}, ${target.potId}, ${target.personId},
                ${target.counterAccountId}, 100, ${reason}, ${rule?.id ?? null})
        on conflict (transaction_id) do update set
          source = excluded.source, kind = excluded.kind, pot_id = excluded.pot_id,
          person_id = excluded.person_id, counter_account_id = excluded.counter_account_id,
          confidence_pct = excluded.confidence_pct,
          reason = excluded.reason, rule_id = excluded.rule_id, created_at = now()
      `
      await tx`update transactions set status = 'vorgeschlagen' where id = ${t.id}`
      touched.push(t)
      suggested++
    }
    await this.refreshErstIch(
      tx,
      touched.map((t) => ({ householdId: t.household_id, bookingDate: t.booking_date })),
      asOf,
    )
    return suggested
  }

  // --- LLM ---------------------------------------------------------------------

  /** Schwanz der Warteschlange: LLM-Läufe nacheinander, damit keine Buchung doppelt gefragt wird. */
  private llmQueue: Promise<unknown> = Promise.resolve()

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.llmQueue.then(run)
    this.llmQueue = next.catch(() => {})
    return next
  }

  /**
   * LLM-Vorschläge im Hintergrund holen (nach dem Import): kehrt sofort zurück, der Lauf reiht
   * sich hinter laufende ein. Fehler landen im Log; was ungefragt bleibt, holt
   * `retryLlmSuggestions` nach.
   */
  queueLlmSuggestions(transactionIds: string[], asOf: IsoDate = todayUtc()): void {
    if (!this.llm || transactionIds.length === 0) return
    this.exclusive(() => this.runLlm(transactionIds, asOf)).catch((err) => {
      console.error('LLM-Vorschläge fehlgeschlagen', err instanceof Error ? err.message : err)
    })
  }

  /** Wartet, bis alle eingereihten LLM-Läufe fertig sind (Tests, Herunterfahren). */
  async llmIdle(): Promise<void> {
    let tail: Promise<unknown>
    do {
      tail = this.llmQueue
      await tail
    } while (tail !== this.llmQueue)
  }

  /** LLM-Vorschläge für diese Buchungen holen und darauf warten. */
  suggestWithLlm(transactionIds: string[], asOf: IsoDate = todayUtc()): Promise<number> {
    if (!this.llm || transactionIds.length === 0) return Promise.resolve(0)
    return this.exclusive(() => this.runLlm(transactionIds, asOf))
  }

  /**
   * Buchungen nachholen, die noch nicht gefragt werden konnten (Modell nicht erreichbar, Server
   * neu gestartet). Nur jüngst importierte, damit das Einschalten des LLM nicht die ganze
   * Historie abfragt.
   */
  retryLlmSuggestions(
    options: { limit?: number; withinDays?: number } = {},
    asOf: IsoDate = todayUtc(),
  ): Promise<number> {
    if (!this.llm) return Promise.resolve(0)
    return this.exclusive(async () => {
      // Buchungen vor dem Budgetbeginn fragt runLlm nicht; hier gar nicht erst auswählen,
      // sonst belegen sie dauerhaft die Plätze eines Durchgangs.
      const rows = await this.db<{ id: string }[]>`
        select t.id from transactions t
        join accounts a on a.id = t.account_id
        join households h on h.id = a.household_id
        where t.status = 'importiert' and t.llm_checked_at is null and t.amount_cents <> 0
          and t.booking_date >= h.budget_start_month
          and t.created_at > now() - make_interval(days => ${options.withinDays ?? 7})
        order by t.created_at, t.id
        limit ${options.limit ?? LLM_RETRY_LIMIT}
      `
      return this.runLlm(
        rows.map((r) => r.id),
        asOf,
      )
    })
  }

  /**
   * Ein LLM-Lauf für Buchungen ohne Aufteilung, die noch nie gefragt wurden. Läuft außerhalb
   * jeder Import-Transaktion (Netzwerk). Die Buchungen gehen gebündelt hinaus (`LLM_BATCH_SIZE`
   * je Anfrage, nur Buchungen eines Haushalts zusammen, höchstens `LLM_CONCURRENCY` Anfragen
   * gleichzeitig).
   *
   * Eine Buchung bleibt unverändert („importiert“), wenn das Modell nichts Brauchbares liefert;
   * sie wartet dann auf eine Person. Scheitert eine Anfrage (Fehler, Zeitüberschreitung), bleiben
   * ihre Buchungen ungefragt und kommen beim Nachholen wieder dran. Nach mehreren gescheiterten
   * Anfragen in Folge bricht der Lauf ab, damit ein Ausfall nicht jede Anfrage abwartet.
   */
  private async runLlm(transactionIds: string[], asOf: IsoDate): Promise<number> {
    const llm = this.llm
    if (!llm || transactionIds.length === 0) return 0
    const pending = await this.db<TxRow[]>`
      select t.id, t.account_id, a.household_id, h.kind as household_kind, h.owner_person_id,
             t.booking_date::text, t.amount_cents, t.counterparty_name, t.counterparty_iban,
             t.purpose, t.status
      from transactions t
      join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      where t.id = any(${transactionIds}::uuid[])
        and t.status = 'importiert' and t.llm_checked_at is null and t.amount_cents <> 0
        and t.booking_date >= h.budget_start_month
      order by a.household_id, t.booking_date, t.id
    `
    // Stapel je Haushalt: Optionen (Töpfe) gelten nur für diesen Haushalt.
    const batches: { householdId: string; rows: TxRow[] }[] = []
    for (const t of pending) {
      const last = batches.at(-1)
      if (last && last.householdId === t.household_id && last.rows.length < LLM_BATCH_SIZE) {
        last.rows.push(t)
      } else {
        batches.push({ householdId: t.household_id, rows: [t] })
      }
    }

    const optionsByHousehold = new Map<string, Promise<LlmOption[]>>()
    const optionsFor = (householdId: string) => {
      let options = optionsByHousehold.get(householdId)
      if (!options) {
        options = this.llmOptions(householdId)
        optionsByHousehold.set(householdId, options)
      }
      return options
    }

    let suggested = 0
    let failuresInRow = 0
    let unanswered = 0
    let next = 0
    const worker = async () => {
      while (next < batches.length && failuresInRow < LLM_MAX_FAILURES_IN_ROW) {
        const batch = batches[next++]
        if (!batch) break
        const options = await optionsFor(batch.householdId)
        let results: (LlmSuggestion | null)[]
        try {
          results = await llm.suggest({
            transactions: batch.rows.map((t) => ({
              bookingDate: t.booking_date,
              amountCents: cents(t.amount_cents),
              counterpartyName: maskIbans(t.counterparty_name),
              purpose: maskIbans(t.purpose),
            })),
            options,
          })
          failuresInRow = 0
        } catch (err) {
          console.error('LLM-Vorschlag fehlgeschlagen', err instanceof Error ? err.message : err)
          failuresInRow++
          unanswered += batch.rows.length
          continue
        }
        suggested += await this.saveLlmResults(
          batch.householdId,
          batch.rows,
          results,
          options,
          asOf,
        )
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, () => worker()),
    )
    for (const batch of batches.slice(next)) unanswered += batch.rows.length
    if (unanswered > 0) console.error(`LLM: ${unanswered} Buchungen später nachholen`)
    return suggested
  }

  /** Antworten eines Stapels speichern; alle Buchungen des Stapels gelten danach als gefragt. */
  private async saveLlmResults(
    householdId: string,
    rows: TxRow[],
    results: (LlmSuggestion | null)[],
    options: LlmOption[],
    asOf: IsoDate,
  ): Promise<number> {
    const isValid = (r: LlmSuggestion | null | undefined): r is LlmSuggestion =>
      r != null &&
      options.some((o) => o.kind === r.kind && o.potId === r.potId) &&
      Number.isInteger(r.confidencePct) &&
      r.confidencePct >= 0 &&
      r.confidencePct <= 100 &&
      r.reason.trim().length > 0
    return this.db.begin(async (tx) => {
      // Reihenfolge wie bei Korrekturen: erst alle Konten des Haushalts, dann die Buchungen.
      await this.lockHouseholdAccounts(tx, householdId)
      const ids = rows.map((t) => t.id)
      const current = await tx<{ id: string; status: string }[]>`
        select id, status from transactions where id = any(${ids}::uuid[]) order by id for update
      `
      await tx`update transactions set llm_checked_at = now() where id = any(${ids}::uuid[])`
      const stillOpen = new Set(current.filter((c) => c.status === 'importiert').map((c) => c.id))
      const touched: TxRow[] = []
      for (const [index, t] of rows.entries()) {
        const result = results[index]
        if (!isValid(result) || !stillOpen.has(t.id)) continue
        await this.replaceSplits(tx, t.id, [
          {
            kind: result.kind,
            potId: result.potId,
            personId: null,
            counterAccountId: null,
            amountCents: cents(t.amount_cents),
          },
        ])
        await tx`
          insert into transaction_suggestions
            (transaction_id, source, kind, pot_id, confidence_pct, reason)
          values (${t.id}, 'llm', ${result.kind}, ${result.potId}, ${result.confidencePct},
                  ${result.reason.trim().replace(/\s+/g, ' ').slice(0, 300)})
          on conflict (transaction_id) do update set
            source = excluded.source, kind = excluded.kind, pot_id = excluded.pot_id,
            confidence_pct = excluded.confidence_pct, reason = excluded.reason,
            person_id = null, counter_account_id = null, rule_id = null, created_at = now()
        `
        await tx`update transactions set status = 'vorgeschlagen' where id = ${t.id}`
        touched.push(t)
      }
      await this.refreshErstIch(
        tx,
        touched.map((t) => ({ householdId: t.household_id, bookingDate: t.booking_date })),
        asOf,
      )
      return touched.length
    })
  }

  private async llmOptions(householdId: string): Promise<LlmOption[]> {
    const pots = await this.db<{ id: string; name: string; group_name: string | null }[]>`
      select id, name, group_name from pots
      where household_id = ${householdId} and archived_at is null
      order by sort_order, created_at
    `
    return [
      { kind: 'einnahme', potId: null, label: 'Einnahme (Noch ohne Aufgabe)', groupName: null },
      {
        kind: 'umbuchung',
        potId: null,
        label: 'Umbuchung zwischen eigenen Konten',
        groupName: null,
      },
      ...pots.map((p) => ({
        kind: 'topf' as const,
        potId: p.id,
        label: p.name,
        groupName: p.group_name,
      })),
    ]
  }

  // --- Bestätigen und korrigieren ----------------------------------------------

  /** Vorschlag mit einem Tipp übernehmen. */
  async confirm(
    personId: string,
    transactionId: string,
  ): Promise<{ transactionId: string; status: 'bestaetigt' }> {
    return this.db.begin(async (tx) => {
      const t = await this.lockAccessibleTransaction(tx, personId, transactionId)
      if (t.status === 'importiert') {
        throw new ApiError(
          409,
          'kein_vorschlag',
          'Zu dieser Buchung gibt es keinen Vorschlag, bitte selbst zuordnen.',
        )
      }
      if (t.status === 'vorgeschlagen') {
        await tx`
          update transactions set status = 'bestaetigt', confirmed_by = ${personId},
            confirmed_at = now()
          where id = ${t.id}
        `
      }
      return { transactionId: t.id, status: 'bestaetigt' as const }
    })
  }

  /**
   * Aufteilung festlegen und damit bestätigen. Weicht eine einfache Zuordnung vom Vorschlag ab
   * (oder gab es keinen), entsteht eine Regel für die Gegenpartei, und die übrigen offenen
   * Buchungen des Haushalts werden neu vorgeschlagen.
   */
  async setSplits(
    personId: string,
    transactionId: string,
    splits: Split[],
    options: { learn: boolean } = { learn: true },
    asOf: IsoDate = todayUtc(),
  ): Promise<{ rule: Rule | null; resuggested: number }> {
    return this.db.begin(async (tx) => {
      const t = await this.lockAccessibleTransaction(tx, personId, transactionId)
      const amount = cents(t.amount_cents)
      if (splits.length === 0) {
        throw new ApiError(422, 'aufteilung_leer', 'Mindestens eine Aufteilung ist nötig.')
      }
      if (splits.some((s) => s.amountCents === 0)) {
        throw new ApiError(422, 'aufteilung_null', 'Eine Aufteilung über 0 Cent ist nicht möglich.')
      }
      const total = splits.reduce((sum, s) => sum + s.amountCents, 0)
      if (total !== amount) {
        throw new ApiError(
          422,
          'aufteilung_summe',
          `Die Aufteilungen ergeben ${total} Cent, die Buchung hat ${amount} Cent.`,
        )
      }
      const household = householdOf(t)
      const checked: Split[] = []
      for (const s of splits) {
        checked.push({
          ...(await this.checkTarget(tx, household, s, s.amountCents, personId, t.account_id)),
          amountCents: s.amountCents,
        })
      }

      const before = (await loadCategorizations(tx, [t.id])).get(t.id)
      await this.replaceSplits(tx, t.id, checked)
      await tx`
        update transactions set status = 'bestaetigt', confirmed_by = ${personId},
          confirmed_at = now()
        where id = ${t.id}
      `

      let rule: Rule | null = null
      let resuggested = 0
      const [only] = checked
      const corrected =
        checked.length === 1 &&
        only !== undefined &&
        (!before?.suggestion || !sameTarget(before.suggestion, only)) &&
        !(await this.isOneOff(tx, household, only))
      const criteria = corrected && options.learn ? criteriaFromCorrection(toMatchable(t)) : null
      if (criteria && only) {
        rule = await this.upsertRule(tx, t.household_id, personId, criteria, only, 'korrektur')
        const open = await tx<{ id: string }[]>`
          select t.id from transactions t join accounts a on a.id = t.account_id
          where a.household_id = ${t.household_id} and t.status <> 'bestaetigt'
        `
        resuggested = await this.applyRules(
          tx,
          open.map((o) => o.id),
          asOf,
        )
      }
      await this.refreshErstIch(
        tx,
        [{ householdId: t.household_id, bookingDate: t.booking_date }],
        asOf,
      )
      return { rule, resuggested }
    })
  }

  // --- Regeln verwalten --------------------------------------------------------

  private async upsertRule(
    tx: TransactionSql,
    householdId: string,
    personId: string,
    criteria: RuleCriteria,
    target: Target,
    origin: 'korrektur' | 'manuell',
  ): Promise<Rule> {
    // Gleiche Merkmale: bestehende Regel umlenken statt eine zweite anzulegen.
    const [existing] = await tx<RuleRow[]>`
      select * from category_rules
      where household_id = ${householdId}
        and account_id is not distinct from ${criteria.accountId}
        and direction is not distinct from ${criteria.direction}
        and counterparty_iban is not distinct from ${criteria.counterpartyIban}
        and lower(counterparty_name) is not distinct from lower(${criteria.counterpartyName})
        and lower(purpose_contains) is not distinct from lower(${criteria.purposeContains})
        and min_amount_cents is not distinct from ${criteria.minAmountCents}
        and max_amount_cents is not distinct from ${criteria.maxAmountCents}
      limit 1
    `
    const [row] = existing
      ? await tx<RuleRow[]>`
          update category_rules set kind = ${target.kind}, pot_id = ${target.potId},
            person_id = ${target.personId}, counter_account_id = ${target.counterAccountId},
            origin = ${origin}, updated_at = now()
          where id = ${existing.id}
          returning *
        `
      : await tx<RuleRow[]>`
          insert into category_rules (
            household_id, account_id, direction, counterparty_iban, counterparty_name,
            purpose_contains, min_amount_cents, max_amount_cents, kind, pot_id, person_id,
            counter_account_id, origin, created_by
          ) values (
            ${householdId}, ${criteria.accountId}, ${criteria.direction},
            ${criteria.counterpartyIban}, ${criteria.counterpartyName},
            ${criteria.purposeContains}, ${criteria.minAmountCents}, ${criteria.maxAmountCents},
            ${target.kind}, ${target.potId}, ${target.personId}, ${target.counterAccountId},
            ${origin}, ${personId}
          )
          returning *
        `
    if (!row) throw new Error('Regel konnte nicht gespeichert werden')
    return toRule(row)
  }

  async listRules(personId: string, householdId: string): Promise<Rule[]> {
    await this.budget.householdAccess(this.db, personId, householdId)
    const rows = await this.db<RuleRow[]>`
      select * from category_rules where household_id = ${householdId}
      order by updated_at desc, id
    `
    return rows.map(toRule)
  }

  /** Regel von Hand anlegen und gleich auf offene Buchungen anwenden. */
  async createRule(
    personId: string,
    householdId: string,
    input: RuleInput,
    asOf: IsoDate = todayUtc(),
  ): Promise<{ rule: Rule; resuggested: number }> {
    const criteria: RuleCriteria = {
      accountId: input.accountId ?? null,
      direction: input.direction ?? null,
      counterpartyIban: input.counterpartyIban ?? null,
      counterpartyName: input.counterpartyName?.replace(/\s+/g, ' ').trim() || null,
      purposeContains: input.purposeContains?.replace(/\s+/g, ' ').trim() || null,
      minAmountCents: input.minAmountCents ?? null,
      maxAmountCents: input.maxAmountCents ?? null,
    }
    if (Object.values(criteria).every((v) => v === null)) {
      throw new ApiError(422, 'regel_ohne_merkmal', 'Eine Regel braucht mindestens ein Merkmal.')
    }
    if (
      criteria.minAmountCents !== null &&
      criteria.maxAmountCents !== null &&
      criteria.minAmountCents > criteria.maxAmountCents
    ) {
      throw new ApiError(422, 'regel_betrag', 'Der Mindestbetrag liegt über dem Höchstbetrag.')
    }
    return this.db.begin(async (tx) => {
      await this.budget.householdAccess(tx, personId, householdId)
      const household = await this.household(tx, householdId)
      const target = await this.checkTarget(
        tx,
        household,
        {
          kind: input.kind,
          potId: input.potId,
          personId: input.personId ?? null,
          counterAccountId: input.counterAccountId ?? null,
        },
        null,
        null,
        criteria.accountId,
      )
      // Die Einzahlung hat eine feste Richtung; die Regel bekommt sie als Merkmal. Ein Ausgleich
      // ohne eigene Richtung bekommt die übliche (Erstattung ans Private).
      const required = requiredDirection(target.kind, household.kind)
      if (required !== null && criteria.direction !== null && criteria.direction !== required) {
        throw new ApiError(
          422,
          'richtung_unpassend',
          `${KIND_LABEL[target.kind]} ist in diesem Haushalt immer ein ${
            required === 'eingang' ? 'Eingang' : 'Ausgang'
          }.`,
        )
      }
      criteria.direction ??= usualDirection(target.kind, household.kind)
      if (criteria.accountId !== null) {
        const [account] = await tx`
          select 1 from accounts where id = ${criteria.accountId} and household_id = ${householdId}
        `
        if (!account) {
          throw new ApiError(
            422,
            'konto_anderer_haushalt',
            'Das Konto gehört nicht zu diesem Haushalt.',
          )
        }
      }
      // Konten zuerst sperren (Reihenfolge Konto → Haushalt), dann Regel anlegen.
      await this.lockHouseholdAccounts(tx, householdId)
      const open = await tx<{ id: string }[]>`
        select t.id from transactions t join accounts a on a.id = t.account_id
        where a.household_id = ${householdId} and t.status <> 'bestaetigt'
      `
      const rule = await this.upsertRule(tx, householdId, personId, criteria, target, 'manuell')
      const resuggested = await this.applyRules(
        tx,
        open.map((o) => o.id),
        asOf,
      )
      return { rule, resuggested }
    })
  }

  async deleteRule(personId: string, ruleId: string): Promise<void> {
    const [row] = await this.db`
      delete from category_rules r
      using household_members m
      where r.id = ${ruleId} and m.household_id = r.household_id and m.person_id = ${personId}
      returning r.id
    `
    if (!row) throw new ApiError(404, 'regel_nicht_gefunden', 'Diese Regel gibt es nicht.')
  }

  // --- Barausgaben ------------------------------------------------------------

  /**
   * Barausgabe erfassen: legt eine bestätigte Buchung im Bargeldkonto an, gleich einem Topf
   * zugeordnet. Idempotent über `clientId` (die App erzeugt sie einmal je Eingabe, damit ein
   * erneuter Versuch nach einem Netzfehler nichts doppelt anlegt). Lernt keine Regel.
   */
  async recordCashExpense(
    personId: string,
    accountId: string,
    input: {
      clientId: string
      bookingDate: IsoDate
      amountCents: number
      description?: string | undefined
      potId: string
    },
  ): Promise<{ transactionId: string; created: boolean }> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ApiError(422, 'betrag_ungueltig', 'Der Betrag muss größer als 0 sein.')
    }
    return this.db.begin(async (tx) => {
      const [account] = await tx<{ household_id: string; source: string }[]>`
        select a.household_id, a.source from accounts a
        join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
        where a.id = ${accountId}
      `
      if (!account) {
        throw new ApiError(404, 'konto_nicht_gefunden', 'Dieses Konto gibt es nicht.')
      }
      if (account.source !== 'bar') {
        throw new ApiError(
          422,
          'kein_bargeldkonto',
          'Barausgaben lassen sich nur in einem Bargeldkonto erfassen.',
        )
      }
      await this.lockHouseholdAccounts(tx, account.household_id)

      const importKey = `app:${input.clientId}`
      const [existing] = await tx<{ id: string }[]>`
        select id from transactions where account_id = ${accountId} and import_key = ${importKey}
      `
      if (existing) return { transactionId: existing.id, created: false }

      // Wie bei Bankbuchungen darf ein privates Bargeldkonto auch einen gemeinsamen Topf
      // verwenden (Ausgleich, ADR 0006) und ein gemeinsames den eigenen privaten (FREI-18).
      const target = await this.checkTarget(
        tx,
        await this.household(tx, account.household_id),
        { kind: 'topf', potId: input.potId, personId: null, counterAccountId: null },
        -input.amountCents,
        personId,
      )
      const description = input.description?.trim() || null
      const [row] = await tx<{ id: string }[]>`
        insert into transactions (account_id, import_key, booking_date, amount_cents,
          counterparty_name, status, confirmed_by, confirmed_at)
        values (${accountId}, ${importKey}, ${input.bookingDate}, ${-input.amountCents},
          ${description}, 'bestaetigt', ${personId}, now())
        returning id
      `
      if (!row) throw new Error('Barausgabe konnte nicht angelegt werden')
      // Eine Ausgabe ändert keine Einnahmen, deshalb läuft die Erst-ich-Automatik hier nicht.
      await this.replaceSplits(tx, row.id, [{ ...target, amountCents: -input.amountCents }])
      return { transactionId: row.id, created: true }
    })
  }

  // --- Offene Buchungen --------------------------------------------------------

  /** Buchungen, die auf Bestätigung warten, aus allen eigenen Haushalten (oder einem). */
  async pendingTransactionIds(
    personId: string,
    filter: { householdId?: string | undefined; limit: number },
  ): Promise<string[]> {
    const rows = await this.db<{ id: string }[]>`
      select t.id from transactions t
      join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
      where t.status <> 'bestaetigt' and t.booking_date >= h.budget_start_month
        ${filter.householdId ? this.db`and a.household_id = ${filter.householdId}` : this.db``}
      order by t.booking_date desc, t.created_at desc, t.id
      limit ${filter.limit}
    `
    return rows.map((r) => r.id)
  }
}
