import { describe, expect, it } from 'vitest'
import {
  compare,
  currentMonth,
  isMonth,
  monthName,
  monthShort,
  monthTitle,
  next,
  previous,
} from './month'

describe('Monate', () => {
  it('rechnet über Jahresgrenzen', () => {
    expect(previous('2026-01')).toBe('2025-12')
    expect(previous('2026-11')).toBe('2026-10')
    expect(next('2025-12')).toBe('2026-01')
    expect(compare('2025-12', '2026-01')).toBeLessThan(0)
    expect(compare('2026-01', '2026-01')).toBe(0)
  })

  it('benennt Monate deutsch', () => {
    expect(monthTitle('2026-11')).toBe('November 2026')
    expect(monthName('2026-03')).toBe('März')
    expect(monthShort('2026-09')).toBe('Sept')
    expect(monthShort('2026-06')).toBe('Juni')
  })

  it('prüft das Format', () => {
    expect(isMonth('2026-11')).toBe(true)
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth('2026-1')).toBe(false)
    expect(isMonth('')).toBe(false)
  })

  it('liefert den laufenden Monat', () => {
    expect(currentMonth(new Date(2026, 10, 19))).toBe('2026-11')
    expect(currentMonth(new Date(2026, 0, 1))).toBe('2026-01')
  })
})
