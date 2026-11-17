import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import type { Config } from '../config.js'

const health = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Betrieb'],
  summary: 'Zustand des Dienstes und der Datenbank',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z
            .object({ status: z.literal('ok'), database: z.literal('ok') })
            .openapi('Health'),
        },
      },
      description: 'Dienst und Datenbank erreichbar',
    },
    503: {
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('fehler'), database: z.literal('fehler') }),
        },
      },
      description: 'Datenbank nicht erreichbar',
    },
  },
})

export function healthRoutes(app: OpenAPIHono<AppEnv>, config: Config): void {
  app.openapi(health, async (c) => {
    try {
      await c.var.db`select 1`
      return c.json({ status: 'ok' as const, database: 'ok' as const }, 200)
    } catch {
      return c.json({ status: 'fehler' as const, database: 'fehler' as const }, 503)
    }
  })

  // Für Passkeys in der iOS/macOS-App (Associated Domains, webcredentials).
  if (config.appleAppIds.length > 0) {
    app.get('/.well-known/apple-app-site-association', (c) =>
      c.json({ webcredentials: { apps: config.appleAppIds } }),
    )
  }
}
