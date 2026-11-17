import { createHash, randomBytes } from 'node:crypto'

/** Zufälliges Geheimnis mit Präfix, damit es in Logs und Secret-Scans erkennbar ist. */
export function newToken(prefix: 'frs' | 'fre'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

/** Tokens werden nur gehasht gespeichert. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}
