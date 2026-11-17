/**
 * Kalendertage als `JJJJ-MM-TT`, ohne Uhrzeit und Zeitzone. Gerechnet wird in UTC,
 * damit Sommerzeit keine Tage verschiebt.
 */
export type IsoDate = string

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value)
  if (!m) return false
  const d = toUtc(value)
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2])
}

function toUtc(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`)
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10)
}

/** Tage von `a` bis `b` (positiv, wenn `b` später ist). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000)
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toUtc(date)
  d.setUTCDate(d.getUTCDate() + days)
  return fromUtc(d)
}

/** Monate addieren; der Tag wird auf das Monatsende gekürzt (31.01. + 1 Monat = 28./29.02.). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = toUtc(date)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return fromUtc(d)
}

export function todayUtc(): IsoDate {
  return fromUtc(new Date())
}
