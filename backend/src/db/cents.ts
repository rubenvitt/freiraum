/** bigint und Summen kommen aus postgres.js als Text; Cent-Beträge passen sicher in eine JS-Zahl. */
export function cents(value: string | number | bigint | null): number {
  const n = Number(value ?? 0)
  if (!Number.isSafeInteger(n)) throw new Error(`Betrag außerhalb des sicheren Bereichs: ${value}`)
  return n
}
