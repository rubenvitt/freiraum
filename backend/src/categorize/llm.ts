/**
 * Schnittstelle für LLM-Vorschläge (Anbindung: `openrouter.ts`, ADR 0003). Ohne Anbindung
 * schlägt nur das Regelwerk vor.
 *
 * Eine Anfrage bündelt mehrere Buchungen **eines** Haushalts (FREI-16), damit große Importe mit
 * wenigen Anfragen auskommen.
 *
 * Datenschutz: Das Modell bekommt nur Datum, Betrag, Gegenpartei und Verwendungszweck einer
 * Buchung, keine IBAN und keine Kontodaten, und nur die Töpfe des Haushalts, zu dem die Konten
 * gehören. Buchungen verschiedener Haushalte landen nie in derselben Anfrage.
 */
import type { SplitKind } from './rules.js'

export interface LlmOption {
  kind: SplitKind
  potId: string | null
  label: string
  groupName: string | null
}

export interface LlmTransaction {
  bookingDate: string
  amountCents: number
  counterpartyName: string | null
  purpose: string | null
}

export interface LlmRequest {
  transactions: LlmTransaction[]
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
  /**
   * Je Buchung ein Vorschlag, in derselben Reihenfolge wie `request.transactions`; `null`, wenn
   * das Modell für diese Buchung nichts Brauchbares geliefert hat. Netzwerk-, HTTP- und
   * Zeitfehler werfen: Dann gilt keine Buchung der Anfrage als beantwortet.
   */
  suggest(request: LlmRequest): Promise<(LlmSuggestion | null)[]>
}
