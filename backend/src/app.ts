import { OpenAPIHono } from '@hono/zod-openapi'
import type { Person } from './auth/service.js'
import { AuthService } from './auth/service.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { ApiError } from './errors.js'
import { authRoutes } from './routes/auth.js'
import { healthRoutes } from './routes/health.js'

export const API_VERSION = '0.1.0'

export type AppEnv = {
  Variables: {
    auth: AuthService
    db: Db
    session: { id: string; person: Person }
  }
}

const errorBody = (code: string, message: string) => ({ error: { code, message } })

export function createApp(deps: { db: Db; config: Config }) {
  const auth = new AuthService(deps.db, deps.config)

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const first = result.error.issues[0]
        const where = first?.path.length ? ` (${first.path.join('.')})` : ''
        return c.json(
          errorBody(
            'ungueltige_anfrage',
            `Die Anfrage ist ungültig${where}: ${first?.message ?? ''}`,
          ),
          400,
        )
      }
    },
  })

  app.use(async (c, next) => {
    c.set('auth', auth)
    c.set('db', deps.db)
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status)
    if (err instanceof SyntaxError) {
      return c.json(errorBody('ungueltige_anfrage', 'Der Inhalt ist kein gültiges JSON.'), 400)
    }
    console.error(err)
    return c.json(errorBody('serverfehler', 'Interner Fehler.'), 500)
  })

  app.notFound((c) => c.json(errorBody('nicht_gefunden', 'Diese Adresse gibt es nicht.'), 404))

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Sitzungs-Token aus /v1/auth/…/verify',
  })

  healthRoutes(app, deps.config)
  authRoutes(app)

  app.doc31('/openapi.json', openApiInfo)

  return { app, auth }
}

export const openApiInfo = {
  openapi: '3.1.0',
  info: {
    title: 'Freiraum API',
    version: API_VERSION,
    description:
      'Backend von Freiraum. Beträge immer als ganze Cent (Integer). Anmeldung nur per Passkey nach Einladung.',
  },
}
