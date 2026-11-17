/**
 * Ausgleich als reine Funktion: Welche privat bezahlten gemeinsamen Ausgaben sind noch offen?
 *
 * Erstattungen (Überweisungen und von Hand verbuchte) sind nicht einzelnen Ausgaben zugeordnet.
 * Sie decken die Ausgaben der Reihe nach, älteste zuerst. Negative Beträge (eine Erstattung des
 * Händlers aufs private Konto) mindern die Forderung wie eine Erstattung.
 */

export interface Claim {
  id: string
  /** was das Gemeinsame der Person für diese Buchung schuldet (negativ = Gutschrift) */
  amountCents: number
}

/** Offener Rest je Ausgabe (nur Ausgaben mit Rest > 0), in der Reihenfolge der Eingabe. */
export function openClaims(claims: Claim[], repaidCents: number): Map<string, number> {
  let credit =
    Math.max(0, repaidCents) +
    claims.filter((c) => c.amountCents < 0).reduce((sum, c) => sum - c.amountCents, 0)
  const open = new Map<string, number>()
  for (const c of claims) {
    if (c.amountCents <= 0) continue
    const covered = Math.min(c.amountCents, credit)
    credit -= covered
    if (c.amountCents - covered > 0) open.set(c.id, c.amountCents - covered)
  }
  return open
}
