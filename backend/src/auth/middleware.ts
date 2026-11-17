import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../app.js'
import { ApiError } from '../errors.js'

/** Verlangt eine gültige Sitzung (Authorization: Bearer frs_…). */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  const result = match?.[1] ? await c.var.auth.authenticate(match[1]) : null
  if (!result) throw new ApiError(401, 'nicht_angemeldet', 'Bitte melde dich an.')
  c.set('session', { id: result.sessionId, person: result.person })
  await next()
})
