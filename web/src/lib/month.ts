// Monate als „JJJJ-MM“ wie in der API. Deutsche Namen wie in der Mac-App (`GermanDates`).

export type YearMonth = string

const NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
]
const SHORT = [
  'Jan',
  'Feb',
  'März',
  'Apr',
  'Mai',
  'Juni',
  'Juli',
  'Aug',
  'Sept',
  'Okt',
  'Nov',
  'Dez',
]

export const isMonth = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

function parts(m: YearMonth): [number, number] {
  return [Number(m.slice(0, 4)), Number(m.slice(5, 7))]
}

function make(year: number, month: number): YearMonth {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

export function previous(m: YearMonth): YearMonth {
  const [y, mo] = parts(m)
  return mo === 1 ? make(y - 1, 12) : make(y, mo - 1)
}

export function next(m: YearMonth): YearMonth {
  const [y, mo] = parts(m)
  return mo === 12 ? make(y + 1, 1) : make(y, mo + 1)
}

/** Negativ, wenn a vor b liegt (das Format sortiert als Text richtig). */
export const compare = (a: YearMonth, b: YearMonth): number => (a < b ? -1 : a > b ? 1 : 0)

export const monthName = (m: YearMonth): string => NAMES[parts(m)[1] - 1] ?? m
export const monthShort = (m: YearMonth): string => SHORT[parts(m)[1] - 1] ?? m
export const monthTitle = (m: YearMonth): string => `${monthName(m)} ${parts(m)[0]}`

/** Laufender Monat in der Zeitzone des Browsers. */
export const currentMonth = (today: Date): YearMonth =>
  make(today.getFullYear(), today.getMonth() + 1)
