/**
 * Haushalte, Konten, Buchungsimport und wiederkehrende Serien.
 *
 * Zugriff wird hier durchgesetzt, nicht in der Oberfläche: Eine Person sieht nur Konten aus
 * Haushalten, deren Mitglied sie ist. Fremde Konten sind „nicht gefunden“ (404), damit nicht
 * einmal ihre Existenz durchsickert.
 */
import type { TransactionSql } from 'postgres'
import { type Categorization, loadCategorizations } from '../categorize/service.js'
import { cents } from '../db/cents.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { type IsoDate, todayUtc } from './dates.js'
import { type IncomingTransaction, importKeys, normalizeText } from './import-key.js'
import { type Cadence, type DetectedSeries, detectRecurring } from './recurring.js'

export type HouseholdKind = 'privat' | 'gemeinsam'
export type AccountSource = 'bank' | 'bar' | 'manuell'
export type TransactionStatus = 'importiert' | 'vorgeschlagen' | 'bestaetigt'

export interface Household {
  id: string
  kind: HouseholdKind
  name: string
  members: { id: string; displayName: string }[]
}

export interface Account {
  id: string
  householdId: string
  name: string
  source: AccountSource
  iban: string | null
  currency: 'EUR'
  createdAt: Date
  lastImportAt: Date | null
  /** Bekannter Kontostand am Ende von `date` (Grundlage des Anfangsbestands, ADR 0003). */
  balance: { cents: number; date: IsoDate; source: 'manuell' | 'anbieter' } | null
}

export interface Transaction {
  id: string
  accountId: string
  sourceId: string | null
  bookingDate: IsoDate
  valueDate: IsoDate | null
  amountCents: number
  currency: 'EUR'
  counterpartyName: string | null
  counterpartyIban: string | null
  purpose: string | null
  status: TransactionStatus
  recurringSeriesId: string | null
  splits: Categorization['splits']
  suggestion: Categorization['suggestion']
}

export interface RecurringSeries {
  id: string
  accountId: string
  counterparty: string
  direction: 'eingang' | 'ausgang'
  cadence: Cadence
  typicalAmountCents: number
  minAmountCents: number
  maxAmountCents: number
  occurrences: number
  firstDate: IsoDate
  lastDate: IsoDate
  nextExpectedDate: IsoDate
  state: 'aktiv' | 'beendet'
}

/**
 * Was nach einem Import mit den neuen Buchungen geschieht (Kategorisierung, Erst-ich).
 * `inTransaction` läuft in der Import-Transaktion, `afterCommit` danach (z. B. LLM-Aufrufe,
 * die nicht in einer offenen Transaktion warten sollen). Gilt für jeden Import, auch den
 * zeitgesteuerten Abruf beim Anbieter.
 */
export interface ImportHooks {
  inTransaction?(tx: TransactionSql, transactionIds: string[], asOf: IsoDate): Promise<void>
  afterCommit?(transactionIds: string[], asOf: IsoDate): Promise<void>
}

export interface ImportResult {
  importId: string
  received: number
  imported: number
  skipped: number
  recurring: { active: number; ended: number }
}

/** Obergrenze je Import; größere Historien in mehreren Aufrufen schicken. */
export const MAX_IMPORT_SIZE = 10_000
/** Zeilen je INSERT (PostgreSQL erlaubt höchstens 65 535 Parameter je Anweisung). */
const INSERT_CHUNK = 1_000

const accountNotFound = () =>
  new ApiError(404, 'konto_nicht_gefunden', 'Dieses Konto gibt es nicht.')

export function normalizeIban(value: string | undefined | null): string | null {
  const iban = (value ?? '').replace(/\s+/g, '').toUpperCase()
  return iban || null
}

interface AccountRow {
  id: string
  household_id: string
  name: string
  source: AccountSource
  iban: string | null
  currency: 'EUR'
  created_at: Date
  last_import_at: Date | null
  balance_cents: string | null
  balance_day: string | null
  balance_source: 'manuell' | 'anbieter' | null
}

const ACCOUNT_BALANCE = 'balance_date::text as balance_day'

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  source: r.source,
  iban: r.iban,
  currency: r.currency,
  createdAt: r.created_at,
  lastImportAt: r.last_import_at,
  balance:
    r.balance_cents === null || r.balance_day === null || r.balance_source === null
      ? null
      : { cents: cents(r.balance_cents), date: r.balance_day, source: r.balance_source },
})

interface SeriesRow {
  id: string
  account_id: string
  counterparty: string
  direction: 'eingang' | 'ausgang'
  cadence: Cadence
  typical_amount_cents: string
  min_amount_cents: string
  max_amount_cents: string
  occurrences: number
  first_date: string
  last_date: string
  next_expected_date: string
  state: 'aktiv' | 'beendet'
}

const toSeries = (r: SeriesRow): RecurringSeries => ({
  id: r.id,
  accountId: r.account_id,
  counterparty: r.counterparty,
  direction: r.direction,
  cadence: r.cadence,
  typicalAmountCents: cents(r.typical_amount_cents),
  minAmountCents: cents(r.min_amount_cents),
  maxAmountCents: cents(r.max_amount_cents),
  occurrences: r.occurrences,
  firstDate: r.first_date,
  lastDate: r.last_date,
  nextExpectedDate: r.next_expected_date,
  state: r.state,
})

export class LedgerService {
  constructor(
    private readonly db: Db,
    private readonly hooks: ImportHooks = {},
  ) {}

  // --- Haushalte ---------------------------------------------------------------

  async listHouseholds(personId: string): Promise<Household[]> {
    const rows = await this.db<
      { id: string; kind: HouseholdKind; name: string; members: Household['members'] }[]
    >`
      select h.id, h.kind, h.name,
        (select coalesce(json_agg(json_build_object('id', p.id, 'displayName', p.display_name)
                         order by p.created_at), '[]')
           from household_members m2 join persons p on p.id = m2.person_id
          where m2.household_id = h.id) as members
      from households h
      join household_members m on m.household_id = h.id and m.person_id = ${personId}
      order by (h.kind = 'gemeinsam'), h.created_at
    `
    return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, members: r.members }))
  }

  /** Gemeinsamen Haushalt anlegen (nur per Kommandozeile). Es gibt höchstens einen. */
  async createSharedHousehold(name: string, personIds: string[]): Promise<Household> {
    if (new Set(personIds).size !== 2) {
      throw new Error('Ein gemeinsamer Haushalt braucht genau zwei verschiedene Personen.')
    }
    const id = await this.db.begin(async (tx) => {
      const [h] = await tx<{ id: string }[]>`
        insert into households (kind, name) values ('gemeinsam', ${name.trim()}) returning id
      `
      if (!h) throw new Error('Haushalt konnte nicht angelegt werden')
      await tx`
        insert into household_members ${tx(personIds.map((p) => ({ household_id: h.id, person_id: p })))}
      `
      return h.id
    })
    const [household] = (await this.listHouseholds(personIds[0] as string)).filter(
      (h) => h.id === id,
    )
    if (!household) throw new Error('Haushalt nicht gefunden')
    return household
  }

  // --- Konten ------------------------------------------------------------------

  async createAccount(
    personId: string,
    input: { householdId: string; name: string; source: AccountSource; iban?: string | undefined },
  ): Promise<Account> {
    const [member] = await this.db`
      select 1 from household_members
      where household_id = ${input.householdId} and person_id = ${personId}
    `
    if (!member) {
      throw new ApiError(404, 'haushalt_nicht_gefunden', 'Diesen Haushalt gibt es nicht.')
    }
    const iban = normalizeIban(input.iban)
    if (iban && input.source === 'bar') {
      throw new ApiError(422, 'iban_bei_bargeld', 'Ein Bargeldkonto hat keine IBAN.')
    }
    const [row] = await this.db<AccountRow[]>`
      insert into accounts (household_id, name, source, iban)
      values (${input.householdId}, ${input.name.trim()}, ${input.source}, ${iban})
      returning *, ${this.db.unsafe(ACCOUNT_BALANCE)}, null::timestamptz as last_import_at
    `
    if (!row) throw new Error('Konto konnte nicht angelegt werden')
    return toAccount(row)
  }

  async listAccounts(personId: string): Promise<Account[]> {
    const rows = await this.db<AccountRow[]>`
      select a.*, ${this.db.unsafe(`a.${ACCOUNT_BALANCE}`)}, (select max(r.created_at) from import_runs r where r.account_id = a.id)
               as last_import_at
      from accounts a
      join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
      order by a.created_at
    `
    return rows.map(toAccount)
  }

  /** Konto, sofern die Person Zugriff hat; sonst 404. */
  private async accessibleAccount(
    sql: Db | TransactionSql,
    personId: string,
    accountId: string,
    lock = false,
  ): Promise<{ id: string; source: AccountSource }> {
    const [row] = lock
      ? await sql<{ id: string; source: AccountSource }[]>`
          select a.id, a.source from accounts a
          join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
          where a.id = ${accountId}
          for update of a
        `
      : await sql<{ id: string; source: AccountSource }[]>`
          select a.id, a.source from accounts a
          join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
          where a.id = ${accountId}
        `
    if (!row) throw accountNotFound()
    return row
  }

  // --- Import ------------------------------------------------------------------

  /**
   * Buchungen idempotent übernehmen. Bereits bekannte Buchungen (gleicher Schlüssel, siehe
   * `importKeys`) werden übersprungen, nicht verändert. Danach werden die wiederkehrenden
   * Serien des Kontos neu berechnet.
   */
  async importTransactions(
    personId: string,
    accountId: string,
    transactions: IncomingTransaction[],
    asOf: IsoDate = todayUtc(),
  ): Promise<ImportResult> {
    if (transactions.length > MAX_IMPORT_SIZE) {
      throw new ApiError(
        422,
        'import_zu_gross',
        `Höchstens ${MAX_IMPORT_SIZE} Buchungen je Import, bitte aufteilen.`,
      )
    }
    const { result, newIds } = await this.db.begin(async (tx) => {
      // Sperre je Konto: parallele Importe desselben Kontos laufen nacheinander.
      const account = await this.accessibleAccount(tx, personId, accountId, true)
      if (account.source === 'bar') {
        throw new ApiError(
          422,
          'import_bei_bargeld',
          'In ein Bargeldkonto wird nicht importiert, Barausgaben werden erfasst.',
        )
      }
      const imported = await this.importLocked(tx, accountId, personId, transactions, asOf)
      if (imported.newIds.length > 0) {
        await this.hooks.inTransaction?.(tx, imported.newIds, asOf)
      }
      return imported
    })
    if (newIds.length > 0 && this.hooks.afterCommit) {
      try {
        await this.hooks.afterCommit(newIds, asOf)
      } catch (err) {
        // Der Import ist gespeichert; Vorschläge lassen sich später nachholen.
        console.error(
          'Nachlauf des Imports fehlgeschlagen',
          err instanceof Error ? err.message : err,
        )
      }
    }
    return result
  }

  private async importLocked(
    tx: TransactionSql,
    accountId: string,
    personId: string | null,
    transactions: IncomingTransaction[],
    asOf: IsoDate,
  ): Promise<{ result: ImportResult; newIds: string[] }> {
    const received = transactions.length
    const [run] = await tx<{ id: string }[]>`
      insert into import_runs (account_id, person_id, received, imported, skipped)
      values (${accountId}, ${personId}, ${received}, 0, ${received})
      returning id
    `
    if (!run) throw new Error('Importlauf konnte nicht angelegt werden')

    const keys = importKeys(accountId, transactions)
    const rows = transactions.map((t, i) => ({
      account_id: accountId,
      import_key: keys[i] as string,
      source_id: normalizeText(t.sourceId) || null,
      booking_date: t.bookingDate,
      value_date: t.valueDate ?? null,
      amount_cents: t.amountCents,
      counterparty_name: normalizeText(t.counterpartyName) || null,
      counterparty_iban: normalizeIban(t.counterpartyIban),
      purpose: normalizeText(t.purpose) || null,
      import_run_id: run.id,
    }))

    const newIds: string[] = []
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const inserted = await tx<{ id: string }[]>`
        insert into transactions ${tx(rows.slice(i, i + INSERT_CHUNK))}
        on conflict (account_id, import_key) do nothing
        returning id
      `
      newIds.push(...inserted.map((r) => r.id))
    }
    const imported = newIds.length
    await tx`
      update import_runs set imported = ${imported}, skipped = ${received - imported}
      where id = ${run.id}
    `
    const recurring = await this.refreshRecurring(tx, accountId, asOf)
    return {
      result: { importId: run.id, received, imported, skipped: received - imported, recurring },
      newIds,
    }
  }

  // --- Buchungen ---------------------------------------------------------------

  async listTransactions(
    personId: string,
    accountId: string,
    filter: { from?: IsoDate | undefined; to?: IsoDate | undefined; limit: number },
  ): Promise<Transaction[]> {
    await this.accessibleAccount(this.db, personId, accountId)
    const ids = await this.db<{ id: string }[]>`
      select id from transactions
      where account_id = ${accountId}
        ${filter.from ? this.db`and booking_date >= ${filter.from}` : this.db``}
        ${filter.to ? this.db`and booking_date <= ${filter.to}` : this.db``}
      order by booking_date desc, created_at desc, id
      limit ${filter.limit}
    `
    return this.transactionsByIds(ids.map((r) => r.id))
  }

  /**
   * Buchungen samt Aufteilung und Vorschlag, in der Reihenfolge der IDs. Prüft keinen Zugriff:
   * Die IDs müssen aus einer Abfrage stammen, die das schon getan hat.
   */
  async transactionsByIds(ids: string[]): Promise<Transaction[]> {
    if (ids.length === 0) return []
    const rows = await this.db<
      {
        id: string
        account_id: string
        source_id: string | null
        booking_date: string
        value_date: string | null
        amount_cents: string
        currency: 'EUR'
        counterparty_name: string | null
        counterparty_iban: string | null
        purpose: string | null
        status: TransactionStatus
        recurring_series_id: string | null
      }[]
    >`
      select id, account_id, source_id, booking_date::text, value_date::text, amount_cents,
             currency, counterparty_name, counterparty_iban, purpose, status, recurring_series_id
      from transactions
      where id = any(${ids}::uuid[])
    `
    const byId = new Map(rows.map((r) => [r.id, r]))
    const categorizations = await loadCategorizations(this.db, ids)
    return ids.flatMap((id) => {
      const r = byId.get(id)
      if (!r) return []
      return [
        {
          id: r.id,
          accountId: r.account_id,
          sourceId: r.source_id,
          bookingDate: r.booking_date,
          valueDate: r.value_date,
          amountCents: cents(r.amount_cents),
          currency: r.currency,
          counterpartyName: r.counterparty_name,
          counterpartyIban: r.counterparty_iban,
          purpose: r.purpose,
          status: r.status,
          recurringSeriesId: r.recurring_series_id,
          splits: categorizations.get(r.id)?.splits ?? [],
          suggestion: categorizations.get(r.id)?.suggestion ?? null,
        },
      ]
    })
  }

  // --- Wiederkehrende Serien ---------------------------------------------------

  async listRecurring(
    personId: string,
    filter: { state?: 'aktiv' | 'beendet' | undefined; accountId?: string | undefined } = {},
  ): Promise<RecurringSeries[]> {
    const rows = await this.db<SeriesRow[]>`
      select s.id, s.account_id, s.counterparty, s.direction, s.cadence,
             s.typical_amount_cents, s.min_amount_cents, s.max_amount_cents, s.occurrences,
             s.first_date::text, s.last_date::text, s.next_expected_date::text, s.state
      from recurring_series s
      join accounts a on a.id = s.account_id
      join household_members m on m.household_id = a.household_id and m.person_id = ${personId}
      where true
        ${filter.state ? this.db`and s.state = ${filter.state}` : this.db``}
        ${filter.accountId ? this.db`and s.account_id = ${filter.accountId}` : this.db``}
      order by s.state, s.direction, abs(s.typical_amount_cents) desc, s.counterparty
    `
    return rows.map(toSeries)
  }

  /**
   * Serien eines Kontos aus der gesamten Historie neu berechnen. Serien behalten ihre ID über
   * Neuberechnungen (Schlüssel aus Richtung, Gegenpartei, ggf. Betrag); nicht mehr erkannte
   * werden entfernt.
   */
  private async refreshRecurring(
    tx: TransactionSql,
    accountId: string,
    asOf: IsoDate,
  ): Promise<{ active: number; ended: number }> {
    const history = await tx<
      {
        id: string
        booking_date: string
        amount_cents: string
        counterparty_name: string | null
        counterparty_iban: string | null
        purpose: string | null
      }[]
    >`
      select id, booking_date::text, amount_cents, counterparty_name, counterparty_iban, purpose
      from transactions where account_id = ${accountId}
    `
    const detected: DetectedSeries[] = detectRecurring(
      history.map((h) => ({
        id: h.id,
        bookingDate: h.booking_date,
        amountCents: cents(h.amount_cents),
        counterpartyName: h.counterparty_name,
        counterpartyIban: h.counterparty_iban,
        purpose: h.purpose,
      })),
      asOf,
    )

    await tx`update transactions set recurring_series_id = null where account_id = ${accountId}`
    const keys = detected.map((s) => s.key)
    await tx`
      delete from recurring_series
      where account_id = ${accountId} and not (series_key = any(${keys}::text[]))
    `
    for (const s of detected) {
      const [row] = await tx<{ id: string }[]>`
        insert into recurring_series (
          account_id, series_key, counterparty, direction, cadence, typical_amount_cents,
          min_amount_cents, max_amount_cents, occurrences, first_date, last_date,
          next_expected_date, state
        ) values (
          ${accountId}, ${s.key}, ${s.counterparty}, ${s.direction}, ${s.cadence},
          ${s.typicalAmountCents}, ${s.minAmountCents}, ${s.maxAmountCents}, ${s.occurrences},
          ${s.firstDate}, ${s.lastDate}, ${s.nextExpectedDate}, ${s.state}
        )
        on conflict (account_id, series_key) do update set
          counterparty = excluded.counterparty, direction = excluded.direction,
          cadence = excluded.cadence, typical_amount_cents = excluded.typical_amount_cents,
          min_amount_cents = excluded.min_amount_cents,
          max_amount_cents = excluded.max_amount_cents, occurrences = excluded.occurrences,
          first_date = excluded.first_date, last_date = excluded.last_date,
          next_expected_date = excluded.next_expected_date, state = excluded.state,
          updated_at = now()
        returning id
      `
      if (!row) throw new Error('Serie konnte nicht gespeichert werden')
      await tx`
        update transactions set recurring_series_id = ${row.id}
        where id = any(${s.transactionIds}::uuid[])
      `
    }
    return {
      active: detected.filter((s) => s.state === 'aktiv').length,
      ended: detected.filter((s) => s.state === 'beendet').length,
    }
  }
}
