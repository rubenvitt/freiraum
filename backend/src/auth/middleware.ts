import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app.js'
import { ApiError } from '../errors.js'
import { readSessionCookie } from './cookie.js'

type CookieRule = 'read' | 'logout'

/**
 * Bearer-Token aus `Authorization`, sonst (nur wo erlaubt) das Sitzungs-Cookie. Der Bearer-Header
 * hat Vorrang. Das Cookie gilt nur für lesende Anfragen (GET/HEAD) und fürs Abmelden mit einem
 * erlaubten `Origin`, damit ein Cookie nie etwas ändern kann (keine CSRF-Fläche, ADR 0007).
 */
function credential(
  c: Context<AppEnv>,
  rule: CookieRule,
): { token: string; via: 'bearer' | 'cookie' } | null {
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (match?.[1]) return { token: match[1], via: 'bearer' }

  const cookie = readSessionCookie(c.req.header('cookie'))
  if (!cookie) return null
  const method = c.req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return { token: cookie, via: 'cookie' }
  if (rule === 'logout') {
    const origin = c.req.header('origin')
    if (origin && c.var.config.webauthn.origins.includes(origin)) {
      return { token: cookie, via: 'cookie' }
    }
  }
  return null
}

const authenticate = (rule: CookieRule) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const found = credential(c, rule)
    const result = found ? await c.var.auth.authenticate(found.token) : null
    if (!found || !result) throw new ApiError(401, 'nicht_angemeldet', 'Bitte melde dich an.')
    c.set('session', {
      id: result.sessionId,
      person: result.person,
      via: found.via,
      token: found.token,
    })
    await next()
  })

/** Verlangt eine gültige Sitzung: Bearer-Token, bei GET/HEAD auch das Sitzungs-Cookie. */
export const requireAuth = authenticate('read')

/** Wie requireAuth, nimmt das Cookie aber auch beim Abmelden an, wenn `Origin` erlaubt ist. */
export const requireAuthOrWebLogout = authenticate('logout')
