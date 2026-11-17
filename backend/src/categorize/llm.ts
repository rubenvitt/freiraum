/**
 * Schnittstelle für LLM-Vorschläge. Welches Modell (lokal oder per API) es wird, ist noch offen
 * (Spec, „Offene Entscheidungen“). Ohne Anbindung schlägt nur das Regelwerk vor.
 *
 * Datenschutz: Das Modell bekommt nur Datum, Betrag, Gegenpartei und Verwendungszweck einer
 * Buchung, keine IBAN und keine Kontodaten, und nur die Töpfe des Haushalts, zu dem das
 * Konto gehört.
 */
import type { SplitKind } from './rules.js'

export interface LlmOption {
  kind: SplitKind
  potId: string | null
  label: string
  groupName: string | null
}

export interface LlmRequest {
  transaction: {
    bookingDate: string
    amountCents: number
    counterpartyName: string | null
    purpose: string | null
  }
  options: LlmOption[]
}

export interface LlmSuggestion {
  kind: SplitKind
  potId: string | null
  /** 0–100 */
  confidencePct: number
  /** Begründung in einem Satz */
  reason: string
}

export interface LlmCategorizer {
  suggest(request: LlmRequest): Promise<LlmSuggestion | null>
}
