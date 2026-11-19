/**
 * Sitzung im Browser (Web-Oberfläche, ADR 0007): dasselbe Token wie per Bearer, aber nur als
 * HttpOnly-Cookie. Der Präfix `__Host-` erzwingt Secure, Path=/ und keine Domain.
 */
export const SESSION_COOKIE = '__Host-freiraum_session'

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export function clearSessionCookie(): string {
  return sessionCookie('', 0)
}

/** Wert des Sitzungs-Cookies aus dem `cookie`-Header, sonst null. */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim()
      return value || null
    }
  }
  return null
}
