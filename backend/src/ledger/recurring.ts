/**
 * Erkennung wiederkehrender Buchungen (Abos, Miete, Gehalt) aus der Buchungshistorie eines Kontos.
 * Reine Funktion ohne Datenbank, damit sie gut testbar bleibt.
 *
 * Vorgehen:
 * 1. Gruppieren nach Richtung (Eingang/Ausgang) und Gegenpartei (Name, sonst IBAN, sonst
 *    Anfang des Verwendungszwecks).
 * 2. Zuerst die ganze Gruppe prüfen (z. B. Strom mit schwankendem Abschlag). Passt sie nicht,
 *    Teilgruppen mit genau gleichem Betrag prüfen (z. B. ein Abo zwischen Einzelkäufen beim
 *    selben Händler).
 * 3. Eine Gruppe ist eine Serie, wenn der Median der Abstände in ein Rhythmusfenster fällt, fast
 *    alle Abstände dazu passen und keiner deutlich kürzer ist.
 */
import { addDays, addMonths, daysBetween, type IsoDate } from './dates.js'

export type Cadence =
  | 'woechentlich'
  | 'zweiwoechentlich'
  | 'monatlich'
  | 'quartalsweise'
  | 'halbjaehrlich'
  | 'jaehrlich'

export interface HistoryTransaction {
  id: string
  bookingDate: IsoDate
  amountCents: number
  counterpartyName: string | null
  counterpartyIban: string | null
  purpose: string | null
}

export interface DetectedSeries {
  key: string
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
  transactionIds: string[]
}

interface CadenceRule {
  cadence: Cadence
  /** erlaubte Abstände in Tagen (Wochenenden und Feiertage verschieben Buchungen) */
  min: number
  max: number
  /** Mindestzahl an Buchungen */
  minOccurrences: number
  next: (date: IsoDate) => IsoDate
  /** Verspätung, ab der eine Serie als beendet gilt */
  graceDays: number
}

const RULES: CadenceRule[] = [
  {
    cadence: 'woechentlich',
    min: 6,
    max: 8,
    minOccurrences: 4,
    next: (d) => addDays(d, 7),
    graceDays: 4,
  },
  {
    cadence: 'zweiwoechentlich',
    min: 12,
    max: 16,
    minOccurrences: 3,
    next: (d) => addDays(d, 14),
    graceDays: 7,
  },
  {
    cadence: 'monatlich',
    min: 26,
    max: 35,
    minOccurrences: 3,
    next: (d) => addMonths(d, 1),
    graceDays: 10,
  },
  {
    cadence: 'quartalsweise',
    min: 83,
    max: 99,
    minOccurrences: 3,
    next: (d) => addMonths(d, 3),
    graceDays: 21,
  },
  {
    cadence: 'halbjaehrlich',
    min: 172,
    max: 193,
    minOccurrences: 2,
    next: (d) => addMonths(d, 6),
    graceDays: 31,
  },
  {
    cadence: 'jaehrlich',
    min: 350,
    max: 380,
    minOccurrences: 2,
    next: (d) => addMonths(d, 12),
    graceDays: 31,
  },
]

/** Bei nur zwei Buchungen (halbjährlich, jährlich) müssen die Beträge nahe beieinander liegen. */
const TWO_OCCURRENCE_MAX_SPREAD = 0.1
/** Anteil der Abstände, die ins Fenster passen müssen (Rest: ausgelassene Monate o. Ä.). */
const MIN_FITTING_SHARE = 0.75

const LEGAL_SUFFIXES = new Set([
  'gmbh',
  'mbh',
  'ag',
  'se',
  'kg',
  'kgaa',
  'ohg',
  'gbr',
  'ug',
  'eg',
  'ev',
  'co',
  'ltd',
  'inc',
  'llc',
  'sarl',
  'sa',
  'bv',
  'nv',
  'plc',
  'europe',
  'deutschland',
  'germany',
])

/**
 * Gegenpartei vereinheitlichen: Kleinbuchstaben, Umlaute ausgeschrieben, ohne Ziffern,
 * Satzzeichen und Rechtsformen. „Musterstrom GmbH & Co. KG“ und „MUSTERSTROM GMBH“ werden gleich.
 */
export function counterpartyKey(name: string): string {
  const folded = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
  const words = folded
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !LEGAL_SUFFIXES.has(w))
  return words.slice(0, 4).join(' ')
}

function groupKey(t: HistoryTransaction): { key: string; label: string } | null {
  const name = t.counterpartyName ? counterpartyKey(t.counterpartyName) : ''
  if (name) return { key: `name:${name}`, label: t.counterpartyName?.trim() ?? name }
  if (t.counterpartyIban) return { key: `iban:${t.counterpartyIban}`, label: t.counterpartyIban }
  const purpose = t.purpose ? counterpartyKey(t.purpose) : ''
  if (purpose) return { key: `zweck:${purpose}`, label: purpose }
  return null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

function analyse(
  items: HistoryTransaction[],
  asOf: IsoDate,
): Omit<DetectedSeries, 'key' | 'counterparty' | 'direction'> | null {
  const sorted = [...items].sort(
    (a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id),
  )
  // Mehrere Buchungen am selben Tag sind keine Serie im Sinne eines Rhythmus.
  const dates = sorted.map((t) => t.bookingDate)
  if (new Set(dates).size !== dates.length) return null

  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i] as IsoDate, d))
  if (gaps.length === 0) return null

  const typicalGap = median(gaps)
  const rule = RULES.find((r) => typicalGap >= r.min && typicalGap <= r.max)
  if (!rule || sorted.length < rule.minOccurrences) return null
  if (gaps.some((g) => g < rule.min)) return null
  const fitting = gaps.filter((g) => g <= rule.max).length
  if (fitting / gaps.length < MIN_FITTING_SHARE) return null

  const amounts = sorted.map((t) => Math.abs(t.amountCents))
  const min = Math.min(...amounts)
  const max = Math.max(...amounts)
  if (sorted.length === 2 && (max - min) / max > TWO_OCCURRENCE_MAX_SPREAD) return null

  const sign = Math.sign(sorted[0]?.amountCents ?? 0)
  const lastDate = dates[dates.length - 1] as IsoDate
  const nextExpectedDate = rule.next(lastDate)
  return {
    cadence: rule.cadence,
    typicalAmountCents: sign * median(amounts),
    // min/max mit Vorzeichen, damit min ≤ typisch ≤ max auch bei Ausgängen gilt
    minAmountCents: sign < 0 ? -max : min,
    maxAmountCents: sign < 0 ? -min : max,
    occurrences: sorted.length,
    firstDate: dates[0] as IsoDate,
    lastDate,
    nextExpectedDate,
    state: daysBetween(nextExpectedDate, asOf) > rule.graceDays ? 'beendet' : 'aktiv',
    transactionIds: sorted.map((t) => t.id),
  }
}

/** Erkennt Serien in der Historie eines Kontos. `asOf` ist der Stichtag für „aktiv/beendet“. */
export function detectRecurring(
  transactions: HistoryTransaction[],
  asOf: IsoDate,
): DetectedSeries[] {
  const groups = new Map<
    string,
    { label: string; direction: 'eingang' | 'ausgang'; items: HistoryTransaction[] }
  >()
  for (const t of transactions) {
    if (t.amountCents === 0) continue
    const g = groupKey(t)
    if (!g) continue
    const direction = t.amountCents > 0 ? 'eingang' : 'ausgang'
    const key = `${direction}|${g.key}`
    const group = groups.get(key) ?? { label: g.label, direction, items: [] }
    group.items.push(t)
    groups.set(key, group)
  }

  const result: DetectedSeries[] = []
  for (const [key, group] of groups) {
    const base = { counterparty: group.label, direction: group.direction }
    const whole = analyse(group.items, asOf)
    if (whole) {
      result.push({ key, ...base, ...whole })
      continue
    }
    const byAmount = new Map<number, HistoryTransaction[]>()
    for (const t of group.items) {
      const list = byAmount.get(t.amountCents) ?? []
      list.push(t)
      byAmount.set(t.amountCents, list)
    }
    if (byAmount.size < 2) continue
    for (const [amount, items] of byAmount) {
      const series = analyse(items, asOf)
      if (series) result.push({ key: `${key}|${amount}`, ...base, ...series })
    }
  }
  return result.sort((a, b) => a.key.localeCompare(b.key))
}
