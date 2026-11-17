import { createHash } from 'node:crypto'
import type { IsoDate } from './dates.js'

/** Eine Buchung, wie sie ein Import (Datei, Anbieter, App) liefert. Betrag in Cent. */
export interface IncomingTransaction {
  /** Quell-ID der Bank; nur angeben, wenn sie stabil ist (bei jedem Abruf gleich). */
  sourceId?: string | undefined
  bookingDate: IsoDate
  valueDate?: IsoDate | undefined
  amountCents: number
  counterpartyName?: string | undefined
  counterpartyIban?: string | undefined
  purpose?: string | undefined
}

/** Leerraum vereinheitlichen, damit Zeilenumbrüche der Bank den Hash nicht ändern. */
export function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function contentHash(accountId: string, t: IncomingTransaction): string {
  return createHash('sha256')
    .update(
      [
        accountId,
        t.bookingDate,
        String(t.amountCents),
        normalizeText(t.purpose),
        // Gegenpartei zusätzlich zur Spec: Sonst würden zwei verschiedene Empfänger mit gleichem
        // Betrag und leerem Verwendungszweck am selben Tag nur über die Reihenfolge unterschieden.
        normalizeText(t.counterpartyName).toLowerCase(),
        (t.counterpartyIban ?? '').replace(/\s+/g, '').toUpperCase(),
      ].join('\u001f'),
      'utf8',
    )
    .digest('hex')
}

/**
 * Idempotenzschlüssel je Buchung, in der Reihenfolge der Eingabe.
 *
 * - Mit Quell-ID: `id:<Quell-ID>`.
 * - Sonst `hash:<sha256 aus Konto, Buchungstag, Betrag, Verwendungszweck, Gegenpartei>:<n>`. `n` zählt
 *   gleiche Buchungen innerhalb des Abrufs (zwei gleiche Kaffees am selben Tag sind zwei
 *   Buchungen). Weil Abrufe ganze Tage abdecken, bekommt dieselbe Buchung in überlappenden
 *   Abrufen denselben Schlüssel; kommt eine zweite gleiche später dazu, erhält sie `n = 1`.
 */
export function importKeys(accountId: string, transactions: IncomingTransaction[]): string[] {
  const seen = new Map<string, number>()
  return transactions.map((t) => {
    const sourceId = normalizeText(t.sourceId)
    if (sourceId) return `id:${sourceId}`
    const hash = contentHash(accountId, t)
    const n = seen.get(hash) ?? 0
    seen.set(hash, n + 1)
    return `hash:${hash}:${n}`
  })
}
