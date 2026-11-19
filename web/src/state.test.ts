import { describe, expect, it } from 'vitest'
import { readState, writeState } from './state'

describe('Zustand in der Adresse', () => {
  it('liest und schreibt alle Felder', () => {
    const state = {
      haushalt: '6f1c1d2e-0000-4000-8000-000000000001',
      monat: '2026-11',
      zeitraum: 'quartal' as const,
      fluss: 'person' as const,
    }
    expect(readState(writeState(state))).toEqual(state)
  })

  it('lässt Standardwerte weg', () => {
    expect(writeState({ zeitraum: 'monat', fluss: 'haushalt' })).toBe('')
    expect(readState('')).toEqual({ zeitraum: 'monat', fluss: 'haushalt' })
  })

  it('verwirft ungültige Werte', () => {
    expect(readState('?zeitraum=foo&fluss=bar&monat=2026-13&haushalt=')).toEqual({
      zeitraum: 'monat',
      fluss: 'haushalt',
    })
    expect(readState('?haushalt=..%2Fetc').haushalt).toBeUndefined()
  })
})
