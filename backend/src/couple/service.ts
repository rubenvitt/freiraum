/**
 * Paar-Modell (E4): Freigaben, Kennzahlen, Einzahlungsregeln und Ausgleich. ADR 0006.
 *
 * Privatsphäre wird hier durchgesetzt, nicht in der Oberfläche:
 * - Aus dem privaten Haushalt der anderen Person kommt nur, was sie freigegeben hat
 *   (`shares`). Freigaben gelten nur zwischen Personen mit gemeinsamem Haushalt und werden bei
 *   jeder Anfrage neu geprüft; Zurücknehmen wirkt sofort.
 * - Kennzahlen sind Anteile und Ja/Nein, keine Beträge: Aus „Erst ich erledigt“ oder der
 *   Sparquote lässt sich kein Einkommen zurückrechnen.
 * - Das Soll einer Einzahlungsregel „Prozent vom Netto“ verrät das Einkommen. Die andere Person
 *   sieht es nur mit der Freigabe `einzahlung_soll`; ein fester Betrag ist ohnehin bekannt.
 * - Wer eine private Buchung einem gemeinsamen Topf zuordnet, macht sie fürs Gemeinsame
 *   sichtbar, aber nur Datum, Gegenpartei und den gemeinsamen Anteil, nicht Konto oder Zweck.
 * - Umgekehrt (FREI-18): Eine Buchung des gemeinsamen Kontos im privaten Topf einer Person zeigt
 *   der Ausgleich als Schuld mit Datum, Gegenpartei und privatem Anteil, ohne den Topf.
 */
import type { TransactionSql } from 'postgres'
import type { AnalyticsService } from '../analytics/service.js'
import { computeMonth, type PotKind } from '../budget/compute.js'
import { firstDay, type Month } from '../budget/months.js'
import type { BudgetService } from '../budget/service.js'
import { cents } from '../db/cents.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { type IsoDate, todayUtc } from '../ledger/dates.js'
import { openClaims } from './settle.js'

type Sql = Db | TransactionSql

export const SHARE_SCOPES = [
  'erst_ich',
  'ruecklagen',
  'einzahlung_soll',
  'budget',
  'sparquote',
] as const
export type ShareScope = (typeof SHARE_SCOPES)[number]

export interface ShareEntry {
  personId: string
  displayName: string
  scope: ShareScope
  createdAt: Date
}

export interface ReceivedShare extends ShareEntry {
  /** privater Haushalt der freigebenden Person (für die Sicht `budget`) */
  householdId: string
}

/** Erfüllungsgrad eines Topf-Typs im Monat: Anteil statt Betrag. */
export interface PotProgress {
  hasPots: boolean
  /** alle Töpfe dieses Typs haben ihre Monatsrate zugewiesen */
  fulfilled: boolean
  /** zugewiesener Anteil am Plan in Prozent (abgerundet, höchstens 100); null ohne Plan */
  fundedPct: number | null
}

/** Sparquote im Monat (ADR 0005): Anteil statt Betrag. */
export interface SavingsRate {
  /** Gespart ÷ Einkommen in Prozent (abgerundet, kann negativ sein); null ohne Einkommen */
  savingsRatePct: number | null
}

export interface Metrics {
  personId: string
  month: Month
  scopes: ShareScope[]
  erstIch: PotProgress | null
  ruecklagen: PotProgress | null
  sparquote: SavingsRate | null
}

export interface ContributionRule {
  householdId: string
  personId: string
  validFrom: Month
  kind: 'fest' | 'prozent'
  amountCents: number | null
  percentBp: number | null
  updatedAt: Date
}

export interface ContributionRuleInput {
  kind: 'fest' | 'prozent'
  amountCents?: number | null | undefined
  percentBp?: number | null | undefined
}

export interface MemberContribution {
  personId: string
  displayName: string
  rule: ContributionRule | null
  /** Soll im Monat; null, wenn es nicht sichtbar ist oder es keine Regel gibt */
  targetCents: number | null
  targetVisible: boolean
  /** Ist: Einzahlungen dieser Person aufs gemeinsame Konto im Monat */
  paidCents: number
  /** noch offen (Soll − Ist, nie negativ); null, wenn das Soll nicht sichtbar ist */
  remainingCents: number | null
}

export interface ContributionsView {
  householdId: string
  month: Month
  members: MemberContribution[]
}

export interface SettlementBalance {
  personId: string
  displayName: string
  /** privat bezahlte gemeinsame Ausgaben (abzüglich Gutschriften) */
  claimedCents: number
  /** erstattet: Überweisungen vom gemeinsamen Konto plus von Hand verbucht */
  repaidCents: number
  /** vom gemeinsamen Konto bezahlte private Ausgaben (abzüglich Gutschriften), FREI-18 */
  debtCents: number
  /** zurückgezahlt: Überweisungen der Person aufs gemeinsame Konto (Art `ausgleich`) */
  paidBackCents: number
  /**
   * Saldo: schuldet das Gemeinsame der Person noch (positiv) oder die Person dem Gemeinsamen
   * (negativ). Forderung und Schuld verrechnen sich.
   */
  openCents: number
}

export interface OpenClaim {
  transactionId: string
  personId: string
  bookingDate: IsoDate
  counterpartyName: string | null
  /** gemeinsamer Anteil der Buchung */
  amountCents: number
  openCents: number
}

/** Offene Schuld: Buchung des gemeinsamen Kontos im privaten Topf der Person. */
export interface OpenDebt {
  transactionId: string
  personId: string
  bookingDate: IsoDate
  counterpartyName: string | null
  /** privater Anteil der Buchung */
  amountCents: number
  openCents: number
}

export interface ManualSettlement {
  id: string
  personId: string
  amountCents: number
  settledOn: IsoDate
  note: string | null
  createdAt: Date
}

export interface SettlementsView {
  householdId: string
  balances: SettlementBalance[]
  openItems: OpenClaim[]
  openDebts: OpenDebt[]
  manual: ManualSettlement[]
}

const personNotFound = () =>
  new ApiError(404, 'person_nicht_gefunden', 'Diese Person gibt es nicht.')
const householdNotFound = () =>
  new ApiError(404, 'haushalt_nicht_gefunden', 'Diesen Haushalt gibt es nicht.')

interface RuleRow {
  household_id: string
  person_id: string
  valid_from: string
  kind: 'fest' | 'prozent'
  amount_cents: string | null
  percent_bp: number | null
  updated_at: Date
}

const toRule = (r: RuleRow): ContributionRule => ({
  householdId: r.household_id,
  personId: r.person_id,
  validFrom: r.valid_from,
  kind: r.kind,
  amountCents: r.amount_cents === null ? null : cents(r.amount_cents),
  percentBp: r.percent_bp,
  updatedAt: r.updated_at,
})

const RULE_COLUMNS = `household_id, person_id, to_char(valid_from, 'YYYY-MM') as valid_from, kind,
  amount_cents, percent_bp, updated_at`

/** Soll einer Einzahlungsregel für einen Monat mit den Einnahmen der Person. */
export function contributionTarget(rule: ContributionRule, incomeCents: number): number {
  if (rule.kind === 'fest') return rule.amountCents ?? 0
  return Math.floor(((rule.percentBp ?? 0) * Math.max(0, incomeCents)) / 10_000)
}

export class CoupleService {
  constructor(
    private readonly db: Db,
    private readonly budget: BudgetService,
    private readonly analytics: AnalyticsService,
  ) {}

  // --- Zugriff -----------------------------------------------------------------

  /** Die andere Person, sofern sie mit `personId` einen Haushalt teilt; sonst 404. */
  private async partner(sql: Sql, personId: string, otherId: string) {
    const [row] = await sql<{ id: string; display_name: string }[]>`
      select p.id, p.display_name from persons p
      where p.id = ${otherId} and p.id <> ${personId}
        and exists (
          select 1 from household_members a join household_members b
            on a.household_id = b.household_id
          where a.person_id = ${personId} and b.person_id = p.id)
    `
    if (!row) throw personNotFound()
    return { id: row.id, displayName: row.display_name }
  }

  /** Gemeinsamer Haushalt, in dem die Person Mitglied ist; privat → 422, fremd → 404. */
  private async sharedHousehold(
    sql: Sql,
    personId: string,
    householdId: string,
    lock = false,
  ): Promise<void> {
    const [row] = lock
      ? await sql<{ kind: string }[]>`
          select h.kind from households h
          join household_members m on m.household_id = h.id and m.person_id = ${personId}
          where h.id = ${householdId}
          for update of h
        `
      : await sql<{ kind: string }[]>`
          select h.kind from households h
          join household_members m on m.household_id = h.id and m.person_id = ${personId}
          where h.id = ${householdId}
        `
    if (!row) throw householdNotFound()
    if (row.kind !== 'gemeinsam') {
      throw new ApiError(
        422,
        'nicht_gemeinsam',
        'Einzahlungen und Ausgleich gibt es nur im gemeinsamen Haushalt.',
      )
    }
  }

  private async grantedScopes(sql: Sql, ownerId: string, granteeId: string) {
    const rows = await sql<{ scope: ShareScope }[]>`
      select scope from shares
      where owner_person_id = ${ownerId} and grantee_person_id = ${granteeId}
    `
    return new Set(rows.map((r) => r.scope))
  }

  // --- Freigaben ---------------------------------------------------------------

  async listShares(
    personId: string,
  ): Promise<{ granted: ShareEntry[]; received: ReceivedShare[] }> {
    const granted = await this.db<
      { person_id: string; display_name: string; scope: ShareScope; created_at: Date }[]
    >`
      select s.grantee_person_id as person_id, p.display_name, s.scope, s.created_at
      from shares s join persons p on p.id = s.grantee_person_id
      where s.owner_person_id = ${personId}
      order by p.created_at, s.scope
    `
    const received = await this.db<
      {
        person_id: string
        display_name: string
        scope: ShareScope
        created_at: Date
        household_id: string
      }[]
    >`
      select s.owner_person_id as person_id, p.display_name, s.scope, s.created_at,
             h.id as household_id
      from shares s
      join persons p on p.id = s.owner_person_id
      join households h on h.owner_person_id = s.owner_person_id
      where s.grantee_person_id = ${personId}
      order by p.created_at, s.scope
    `
    return {
      granted: granted.map((r) => ({
        personId: r.person_id,
        displayName: r.display_name,
        scope: r.scope,
        createdAt: r.created_at,
      })),
      received: received.map((r) => ({
        personId: r.person_id,
        displayName: r.display_name,
        scope: r.scope,
        createdAt: r.created_at,
        householdId: r.household_id,
      })),
    }
  }

  /** Freigabe erteilen (idempotent). Nur an die Person, mit der man einen Haushalt teilt. */
  async grantShare(personId: string, granteeId: string, scope: ShareScope): Promise<ShareEntry> {
    const grantee = await this.partner(this.db, personId, granteeId)
    const [row] = await this.db<{ created_at: Date }[]>`
      insert into shares (owner_person_id, grantee_person_id, scope)
      values (${personId}, ${grantee.id}, ${scope})
      on conflict (owner_person_id, grantee_person_id, scope)
        do update set scope = excluded.scope
      returning created_at
    `
    if (!row) throw new Error('Freigabe konnte nicht gespeichert werden')
    return {
      personId: grantee.id,
      displayName: grantee.displayName,
      scope,
      createdAt: row.created_at,
    }
  }

  /** Freigabe zurücknehmen; wirkt sofort. Gibt es sie nicht, passiert nichts. */
  async revokeShare(personId: string, granteeId: string, scope: ShareScope): Promise<void> {
    await this.db`
      delete from shares
      where owner_person_id = ${personId} and grantee_person_id = ${granteeId}
        and scope = ${scope}
    `
  }

  // --- Kennzahlen --------------------------------------------------------------

  /**
   * Kennzahlen aus dem privaten Haushalt einer Person für einen Monat. Die Person selbst sieht
   * alle; die andere nur die freigegebenen, alle übrigen sind null.
   */
  async metrics(viewerId: string, personId: string, month: Month): Promise<Metrics> {
    let scopes: Set<ShareScope>
    if (viewerId === personId) {
      scopes = new Set(SHARE_SCOPES)
    } else {
      await this.partner(this.db, viewerId, personId)
      scopes = await this.grantedScopes(this.db, personId, viewerId)
    }
    const [household] = await this.db<{ id: string }[]>`
      select id from households where owner_person_id = ${personId}
    `
    if (!household) throw personNotFound()
    const needsBudget = scopes.has('erst_ich') || scopes.has('ruecklagen')
    let erstIch: PotProgress | null = null
    let ruecklagen: PotProgress | null = null
    if (needsBudget) {
      const data = await this.budget.loadData(this.db, household.id)
      const budget = computeMonth(data, month)
      const kinds = new Map(data.potRows.map((p) => [p.id, { kind: p.kind, archived: p.archived }]))
      const progress = (kind: PotKind): PotProgress => {
        const rows = budget.pots.filter((r) => {
          const pot = kinds.get(r.potId)
          return pot?.kind === kind && !pot.archived
        })
        const plan = rows.reduce((sum, r) => sum + r.planCents, 0)
        const funded = rows.reduce((sum, r) => sum + Math.min(r.assignedCents, r.planCents), 0)
        return {
          hasPots: rows.length > 0,
          fulfilled: rows.length > 0 && rows.every((r) => r.neededCents === 0),
          fundedPct:
            plan > 0 ? Math.min(100, Math.floor((100 * Math.max(0, funded)) / plan)) : null,
        }
      }
      if (scopes.has('erst_ich')) erstIch = progress('erst_ich')
      if (scopes.has('ruecklagen')) ruecklagen = progress('ruecklage')
    }
    let sparquote: SavingsRate | null = null
    if (scopes.has('sparquote')) {
      const m = await this.analytics.monthMetricsUnchecked(household.id, month)
      sparquote = {
        // Abgerundet wie die übrigen Anteile; nur der Prozentwert verlässt den Server.
        savingsRatePct: m.incomeCents > 0 ? Math.floor((100 * m.savedCents) / m.incomeCents) : null,
      }
    }
    return {
      personId,
      month,
      scopes: SHARE_SCOPES.filter((s) => scopes.has(s)),
      erstIch,
      ruecklagen,
      sparquote,
    }
  }

  // --- Einzahlungsregeln -------------------------------------------------------

  async listContributionRules(personId: string, householdId: string): Promise<ContributionRule[]> {
    await this.sharedHousehold(this.db, personId, householdId)
    const rows = await this.db<RuleRow[]>`
      select ${this.db.unsafe(RULE_COLUMNS)} from contribution_rules
      where household_id = ${householdId}
      order by person_id, valid_from
    `
    return rows.map(toRule)
  }

  /**
   * Eigene Einzahlungsregel ab einem Monat setzen. Jede Person legt nur ihre eigene fest; beide
   * sehen beide Regeln. Eine Standardregel gibt es bewusst nicht (gemeinsam absprechen).
   */
  async setContributionRule(
    personId: string,
    householdId: string,
    validFrom: Month,
    input: ContributionRuleInput,
  ): Promise<ContributionRule> {
    const amount = input.amountCents ?? null
    const percent = input.percentBp ?? null
    const fail = (message: string) => new ApiError(422, 'einzahlungsregel_ungueltig', message)
    if (input.kind === 'fest' && (amount === null || percent !== null)) {
      throw fail('Eine feste Einzahlung braucht einen Betrag und keinen Anteil.')
    }
    if (input.kind === 'prozent' && (percent === null || amount !== null)) {
      throw fail('Eine Einzahlung in Prozent braucht einen Anteil und keinen Betrag.')
    }
    await this.sharedHousehold(this.db, personId, householdId)
    const [row] = await this.db<RuleRow[]>`
      insert into contribution_rules
        (household_id, person_id, valid_from, kind, amount_cents, percent_bp, updated_by)
      values (${householdId}, ${personId}, ${firstDay(validFrom)}, ${input.kind}, ${amount},
              ${percent}, ${personId})
      on conflict (household_id, person_id, valid_from) do update set
        kind = excluded.kind, amount_cents = excluded.amount_cents,
        percent_bp = excluded.percent_bp, updated_by = excluded.updated_by, updated_at = now()
      returning ${this.db.unsafe(RULE_COLUMNS)}
    `
    if (!row) throw new Error('Einzahlungsregel konnte nicht gespeichert werden')
    return toRule(row)
  }

  async deleteContributionRule(
    personId: string,
    householdId: string,
    validFrom: Month,
  ): Promise<void> {
    await this.sharedHousehold(this.db, personId, householdId)
    const [row] = await this.db`
      delete from contribution_rules
      where household_id = ${householdId} and person_id = ${personId}
        and valid_from = ${firstDay(validFrom)}
      returning 1
    `
    if (!row) {
      throw new ApiError(
        404,
        'einzahlungsregel_nicht_gefunden',
        'Ab diesem Monat gibt es keine eigene Einzahlungsregel.',
      )
    }
  }

  /** Soll und Ist der Einzahlungen je Person für einen Monat. */
  async contributions(
    viewerId: string,
    householdId: string,
    month: Month,
  ): Promise<ContributionsView> {
    await this.sharedHousehold(this.db, viewerId, householdId)
    const members = await this.db<{ id: string; display_name: string }[]>`
      select p.id, p.display_name from household_members m join persons p on p.id = m.person_id
      where m.household_id = ${householdId}
      order by p.created_at
    `
    const rules = (
      await this.db<RuleRow[]>`
        select distinct on (person_id) ${this.db.unsafe(RULE_COLUMNS)} from contribution_rules
        where household_id = ${householdId} and valid_from <= ${firstDay(month)}
        order by person_id, valid_from desc
      `
    ).map(toRule)
    const paid = await this.db<{ person_id: string; amount_cents: string }[]>`
      select s.person_id, sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId} and s.kind = 'einzahlung'
        and to_char(t.booking_date, 'YYYY-MM') = ${month}
      group by s.person_id
    `
    const paidBy = new Map(paid.map((p) => [p.person_id, cents(p.amount_cents)]))
    const result: MemberContribution[] = []
    for (const m of members) {
      const rule = rules.find((r) => r.personId === m.id) ?? null
      const visible =
        rule !== null &&
        (m.id === viewerId ||
          rule.kind === 'fest' ||
          (await this.grantedScopes(this.db, m.id, viewerId)).has('einzahlung_soll'))
      let target: number | null = null
      if (rule && visible) {
        target = contributionTarget(
          rule,
          rule.kind === 'prozent' ? await this.privateIncome(m.id, month) : 0,
        )
      }
      const paidCents = paidBy.get(m.id) ?? 0
      result.push({
        personId: m.id,
        displayName: m.display_name,
        rule,
        targetCents: target,
        targetVisible: visible,
        paidCents,
        remainingCents: target === null ? null : Math.max(0, target - paidCents),
      })
    }
    return { householdId, month, members: result }
  }

  /** Einnahmen einer Person im Monat, aus ihrem privaten Haushalt (Netto, wie beim Erst-ich-Anteil). */
  private async privateIncome(personId: string, month: Month): Promise<number> {
    const [row] = await this.db<{ amount_cents: string | null }[]>`
      select sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      where h.owner_person_id = ${personId} and s.kind = 'einnahme'
        and to_char(t.booking_date, 'YYYY-MM') = ${month}
    `
    return cents(row?.amount_cents ?? 0)
  }

  // --- Ausgleich ---------------------------------------------------------------

  /**
   * Was das Gemeinsame jeder Person schuldet: Ausgaben von privaten Konten in gemeinsamen
   * Töpfen minus Erstattungen (Überweisungen vom gemeinsamen Konto und von Hand verbucht).
   * Umgekehrt mindern Ausgaben vom gemeinsamen Konto in privaten Töpfen den Saldo, bis die
   * Person sie zurückzahlt (FREI-18). Alles wird aus den Aufteilungen neu gerechnet, nichts
   * fortgeschrieben.
   */
  async settlements(viewerId: string, householdId: string): Promise<SettlementsView> {
    await this.sharedHousehold(this.db, viewerId, householdId)
    return this.loadSettlements(this.db, householdId)
  }

  private async loadSettlements(sql: Sql, householdId: string): Promise<SettlementsView> {
    const members = await sql<{ id: string; display_name: string }[]>`
      select p.id, p.display_name from household_members m join persons p on p.id = m.person_id
      where m.household_id = ${householdId}
      order by p.created_at
    `
    const claims = await sql<
      {
        transaction_id: string
        person_id: string
        booking_date: string
        counterparty_name: string | null
        amount_cents: string
      }[]
    >`
      select t.id as transaction_id, h.owner_person_id as person_id, t.booking_date::text,
             t.counterparty_name, -sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join pots p on p.id = s.pot_id
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      join households h on h.id = a.household_id
      where p.household_id = ${householdId} and h.kind = 'privat'
      group by t.id, h.owner_person_id
      order by t.booking_date, t.created_at, t.id
    `
    const debts = await sql<
      {
        transaction_id: string
        person_id: string
        booking_date: string
        counterparty_name: string | null
        amount_cents: string
      }[]
    >`
      select t.id as transaction_id, hp.owner_person_id as person_id, t.booking_date::text,
             t.counterparty_name, -sum(s.amount_cents) as amount_cents
      from transaction_splits s
      join pots p on p.id = s.pot_id
      join households hp on hp.id = p.household_id
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId} and hp.kind = 'privat'
      group by t.id, hp.owner_person_id
      order by t.booking_date, t.created_at, t.id
    `
    // Gezählt wird die Seite des gemeinsamen Kontos: Ausgang = Erstattung an die Person,
    // Eingang = Rückzahlung der Person.
    const transfers = await sql<{ person_id: string; repaid: string; paid_back: string }[]>`
      select s.person_id,
             coalesce(-sum(s.amount_cents) filter (where s.amount_cents < 0), 0) as repaid,
             coalesce(sum(s.amount_cents) filter (where s.amount_cents > 0), 0) as paid_back
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      where a.household_id = ${householdId} and s.kind = 'ausgleich'
      group by s.person_id
    `
    const manual = await sql<
      {
        id: string
        person_id: string
        amount_cents: string
        settled_on: string
        note: string | null
        created_at: Date
      }[]
    >`
      select id, person_id, amount_cents, settled_on::text, note, created_at from settlements
      where household_id = ${householdId}
      order by settled_on desc, created_at desc
    `
    const balances: SettlementBalance[] = []
    const openItems: OpenClaim[] = []
    const openDebts: OpenDebt[] = []
    const sumCents = (rows: { amount_cents: string }[]) =>
      rows.reduce((sum, r) => sum + cents(r.amount_cents), 0)
    for (const m of members) {
      const own = claims.filter((c) => c.person_id === m.id)
      const owed = debts.filter((d) => d.person_id === m.id)
      const transfer = transfers.find((t) => t.person_id === m.id)
      const claimed = sumCents(own)
      const debt = sumCents(owed)
      const repaid =
        cents(transfer?.repaid ?? 0) + sumCents(manual.filter((s) => s.person_id === m.id))
      const paidBack = cents(transfer?.paid_back ?? 0)
      balances.push({
        personId: m.id,
        displayName: m.display_name,
        claimedCents: claimed,
        repaidCents: repaid,
        debtCents: debt,
        paidBackCents: paidBack,
        openCents: claimed - repaid - (debt - paidBack),
      })
      // Forderung und Schuld decken sich gegenseitig, jeweils älteste zuerst.
      const items = (rows: typeof own, credit: number) => {
        const open = openClaims(
          rows.map((r) => ({ id: r.transaction_id, amountCents: cents(r.amount_cents) })),
          credit,
        )
        return rows.flatMap((r) => {
          const rest = open.get(r.transaction_id)
          return rest === undefined
            ? []
            : [
                {
                  transactionId: r.transaction_id,
                  personId: m.id,
                  bookingDate: r.booking_date,
                  counterpartyName: r.counterparty_name,
                  amountCents: cents(r.amount_cents),
                  openCents: rest,
                },
              ]
        })
      }
      openItems.push(...items(own, repaid + debt - paidBack))
      openDebts.push(...items(owed, paidBack + claimed - repaid))
    }
    const newestFirst = (a: OpenClaim, b: OpenClaim) =>
      b.bookingDate.localeCompare(a.bookingDate) || a.transactionId.localeCompare(b.transactionId)
    openItems.sort(newestFirst)
    openDebts.sort(newestFirst)
    return {
      householdId,
      balances,
      openItems,
      openDebts,
      manual: manual.map((s) => ({
        id: s.id,
        personId: s.person_id,
        amountCents: cents(s.amount_cents),
        settledOn: s.settled_on,
        note: s.note,
        createdAt: s.created_at,
      })),
    }
  }

  /**
   * Ausgleich von Hand verbuchen (z. B. bar erhalten). Nur für die eigene Forderung: Wer Geld
   * bekommen hat, bestätigt das selbst. Höchstens so viel, wie noch offen ist.
   */
  async recordSettlement(
    personId: string,
    householdId: string,
    input: { amountCents: number; settledOn?: IsoDate | undefined; note?: string | undefined },
  ): Promise<SettlementsView> {
    return this.db.begin(async (tx) => {
      await this.sharedHousehold(tx, personId, householdId, true)
      const before = await this.loadSettlements(tx, householdId)
      const open = before.balances.find((b) => b.personId === personId)?.openCents ?? 0
      if (input.amountCents > open) {
        throw new ApiError(
          422,
          'ausgleich_zu_hoch',
          `Offen sind nur ${Math.max(0, open)} Cent, mehr lässt sich nicht verbuchen.`,
        )
      }
      await tx`
        insert into settlements (household_id, person_id, amount_cents, settled_on, note, created_by)
        values (${householdId}, ${personId}, ${input.amountCents},
                ${input.settledOn ?? todayUtc()}, ${input.note?.trim() || null}, ${personId})
      `
      return this.loadSettlements(tx, householdId)
    })
  }

  /** Von Hand verbuchten Ausgleich zurücknehmen, nur den eigenen. */
  async deleteSettlement(personId: string, settlementId: string): Promise<void> {
    const [row] = await this.db<{ person_id: string }[]>`
      select s.person_id from settlements s
      join household_members m on m.household_id = s.household_id and m.person_id = ${personId}
      where s.id = ${settlementId}
    `
    if (!row) {
      throw new ApiError(404, 'ausgleich_nicht_gefunden', 'Diesen Ausgleich gibt es nicht.')
    }
    if (row.person_id !== personId) {
      throw new ApiError(
        403,
        'fremder_ausgleich',
        'Einen Ausgleich nimmt nur die Person zurück, die das Geld bekommen hat.',
      )
    }
    await this.db`delete from settlements where id = ${settlementId}`
  }
}
