/**
 * Kategorisierungsregeln als reine Funktionen: passt eine Regel auf eine Buchung, und welche
 * Regel entsteht aus einer Korrektur?
 */
import { normalizeText } from '../ledger/import-key.js'

export type SplitKind = 'topf' | 'einnahme' | 'umbuchung'

export interface Target {
  kind: SplitKind
  potId: string | null
}

export interface RuleCriteria {
  accountId: string | null
  direction: 'eingang' | 'ausgang' | null
  counterpartyIban: string | null
  /** normalisiert, Vergleich ohne Groß-/Kleinschreibung */
  counterpartyName: string | null
  /** Teilstring, ohne Groß-/Kleinschreibung */
  purposeContains: string | null
  minAmountCents: number | null
  maxAmountCents: number | null
}

export interface Rule extends RuleCriteria, Target {
  id: string
  householdId: string
  origin: 'korrektur' | 'manuell'
  createdAt: Date
  updatedAt: Date
}

export interface MatchableTransaction {
  accountId: string
  amountCents: number
  counterpartyName: string | null
  counterpartyIban: string | null
  purpose: string | null
}

export const normalizeName = (value: string | null | undefined): string =>
  normalizeText(value ?? undefined).toLocaleLowerCase('de')

/** Anzahl gesetzter Merkmale; spezifischere Regeln gewinnen. */
export function specificity(r: RuleCriteria): number {
  return [
    r.accountId,
    r.direction,
    r.counterpartyIban,
    r.counterpartyName,
    r.purposeContains,
    r.minAmountCents,
    r.maxAmountCents,
  ].filter((v) => v !== null).length
}

export function matches(rule: RuleCriteria, t: MatchableTransaction): boolean {
  if (specificity(rule) === 0) return false
  if (rule.accountId !== null && rule.accountId !== t.accountId) return false
  if (rule.direction !== null && rule.direction !== (t.amountCents >= 0 ? 'eingang' : 'ausgang')) {
    return false
  }
  if (rule.counterpartyIban !== null && rule.counterpartyIban !== t.counterpartyIban) return false
  if (
    rule.counterpartyName !== null &&
    normalizeName(rule.counterpartyName) !== normalizeName(t.counterpartyName)
  ) {
    return false
  }
  if (
    rule.purposeContains !== null &&
    !normalizeName(t.purpose).includes(normalizeName(rule.purposeContains))
  ) {
    return false
  }
  if (rule.minAmountCents !== null && t.amountCents < rule.minAmountCents) return false
  if (rule.maxAmountCents !== null && t.amountCents > rule.maxAmountCents) return false
  return true
}

/** Beste passende Regel: die spezifischste, bei Gleichstand die zuletzt geänderte. */
export function bestRule<R extends Rule>(rules: R[], t: MatchableTransaction): R | null {
  const candidates = rules.filter((r) => matches(r, t))
  candidates.sort(
    (a, b) => specificity(b) - specificity(a) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  )
  return candidates[0] ?? null
}

/**
 * Regel aus einer Korrektur: Richtung plus Gegenpartei (IBAN, sonst Name). Ohne Gegenpartei
 * lässt sich nichts verallgemeinern, dann entsteht keine Regel.
 */
export function criteriaFromCorrection(t: MatchableTransaction): RuleCriteria | null {
  const iban = t.counterpartyIban
  const name = normalizeName(t.counterpartyName)
  if (!iban && !name) return null
  return {
    accountId: null,
    direction: t.amountCents >= 0 ? 'eingang' : 'ausgang',
    counterpartyIban: iban || null,
    counterpartyName: iban ? null : normalizeText(t.counterpartyName ?? undefined),
    purposeContains: null,
    minAmountCents: null,
    maxAmountCents: null,
  }
}

/** Kurze Beschreibung der Merkmale für die Begründung eines Vorschlags. */
export function describeCriteria(r: RuleCriteria): string {
  const parts: string[] = []
  if (r.counterpartyName !== null) parts.push(`Gegenpartei „${r.counterpartyName}“`)
  if (r.counterpartyIban !== null) parts.push(`IBAN ${r.counterpartyIban}`)
  if (r.purposeContains !== null) parts.push(`Verwendungszweck enthält „${r.purposeContains}“`)
  if (r.direction !== null) parts.push(r.direction === 'eingang' ? 'Eingang' : 'Ausgang')
  if (r.minAmountCents !== null) parts.push(`ab ${r.minAmountCents} Cent`)
  if (r.maxAmountCents !== null) parts.push(`bis ${r.maxAmountCents} Cent`)
  if (r.accountId !== null) parts.push('nur dieses Konto')
  return parts.join(', ')
}
