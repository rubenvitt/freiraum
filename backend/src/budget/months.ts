/** Monate als `JJJJ-MM`. In der Datenbank liegt der Monatserste als `date`. */
export type Month = string

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonth(value: string): boolean {
  return MONTH.test(value)
}

export function monthOf(date: string): Month {
  return date.slice(0, 7)
}

export function firstDay(month: Month): string {
  return `${month}-01`
}

export function addMonthsTo(month: Month, n: number): Month {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) + n
  const year = Math.floor(index / 12)
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** Monate von `a` bis `b` (positiv, wenn `b` später ist). */
export function monthsBetween(a: Month, b: Month): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number]
  const [yb, mb] = b.split('-').map(Number) as [number, number]
  return yb * 12 + mb - (ya * 12 + ma)
}

export const maxMonth = (a: Month, b: Month): Month => (a > b ? a : b)
export const minMonth = (a: Month, b: Month): Month => (a < b ? a : b)
