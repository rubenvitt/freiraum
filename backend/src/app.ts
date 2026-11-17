import { OpenAPIHono } from '@hono/zod-openapi'
import type { Person } from './auth/service.js'
import { AuthService } from './auth/service.js'
import { BudgetService } from './budget/service.js'
import type { LlmCategorizer } from './categorize/llm.js'
import { OpenRouterCategorizer } from './categorize/openrouter.js'
import { CategorizationService } from './categorize/service.js'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { ApiError } from './errors.js'
import { LedgerService } from './ledger/service.js'
import { authRoutes } from './routes/auth.js'
import { budgetRoutes } from './routes/budget.js'
import { categorizeRoutes } from './routes/categorize.js'
import { healthRoutes } from './routes/health.js'
import { ledgerRoutes } from './routes/ledger.js'
import { webRoutes } from './routes/web.js'

export const API_VERSION = '0.1.0'

export type AppEnv = {
  Variables: {
    auth: AuthService
    budget: BudgetService
    categorize: CategorizationService
    db: Db
    ledger: LedgerService
    session: { id: string; person: Person }
  }
}

const errorBody = (code: string, message: string) => ({ error: { code, message } })

/**
 * `llm` ersetzt das LLM aus der Konfiguration (Tests); ohne Angabe gilt `config.llm`, und ohne
 * Konfiguration bleibt das LLM aus.
 */
export function createApp(deps: { db: Db; config: Config; llm?: LlmCategorizer | null }) {
  const llm =
    deps.llm !== undefined
      ? deps.llm
      : deps.config.llm
        ? new OpenRouterCategorizer(deps.config.llm)
        : null
  const auth = new AuthService(deps.db, deps.config)
  const budget = new BudgetService(deps.db)
  const categorize = new CategorizationService(deps.db, budget, llm)
  const ledger = new LedgerService(deps.db, {
    // Regeln in der Import-Transaktion, LLM danach (Netzwerk, ohne offene Transaktion).
    inTransaction: async (tx, ids, asOf) => {
      await categorize.applyRules(tx, ids, asOf)
    },
    afterCommit: async (ids, asOf) => {
      await categorize.suggestWithLlm(ids, asOf)
    },
  })

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
    c.set('budget', budget)
    c.set('categorize', categorize)
    c.set('db', deps.db)
    c.set('ledger', ledger)
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
  ledgerRoutes(app)
  budgetRoutes(app)
  categorizeRoutes(app)
  webRoutes(app)

  app.doc31('/openapi.json', openApiInfo)

  return { app, auth, budget, categorize, ledger }
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
