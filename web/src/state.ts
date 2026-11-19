// Was die Seite zeigt, steht in der Adresse (`?haushalt=…&monat=…&zeitraum=…&fluss=…`), damit
// Neuladen und Lesezeichen funktionieren. Ungültiges fällt auf den Standard zurück.
import { isMonth, type YearMonth } from './lib/month'
import { PERIODS, type Period } from './lib/presentation'

export type FlowScope = 'haushalt' | 'person'

export type ViewState = {
  haushalt?: string
  monat?: YearMonth
  zeitraum: Period
  fluss: FlowScope
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function readState(search: string): ViewState {
  const q = new URLSearchParams(search)
  const state: ViewState = {
    zeitraum: (PERIODS as string[]).includes(q.get('zeitraum') ?? '')
      ? (q.get('zeitraum') as Period)
      : 'monat',
    fluss: q.get('fluss') === 'person' ? 'person' : 'haushalt',
  }
  const haushalt = q.get('haushalt')
  if (haushalt && UUID.test(haushalt)) state.haushalt = haushalt
  const monat = q.get('monat')
  if (monat && isMonth(monat)) state.monat = monat
  return state
}

export function writeState(state: ViewState): string {
  const q = new URLSearchParams()
  if (state.haushalt) q.set('haushalt', state.haushalt)
  if (state.monat) q.set('monat', state.monat)
  if (state.zeitraum !== 'monat') q.set('zeitraum', state.zeitraum)
  if (state.fluss !== 'haushalt') q.set('fluss', state.fluss)
  const text = q.toString()
  return text ? `?${text}` : ''
}
