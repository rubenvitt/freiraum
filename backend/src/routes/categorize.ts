import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
import type { Rule } from '../categorize/rules.js'
import { Cents, error, json, pathId } from './common.js'
import { SplitKind, SplitSchema, TransactionSchema } from './ledger.js'

const Iban = z
  .string()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/, 'keine gültige IBAN'))
  .openapi({ type: 'string', example: 'DE02120300000000202051' })

const RuleSchema = z
  .object({
    id: z.uuid(),
    householdId: z.uuid(),
    accountId: z.uuid().nullable(),
    direction: z.enum(['eingang', 'ausgang']).nullable(),
    counterpartyIban: z.string().nullable(),
    counterpartyName: z
      .string()
      .nullable()
      .openapi({ description: 'Gleichheit ohne Groß-/Kleinschreibung' }),
    purposeContains: z.string().nullable(),
    minAmountCents: z.number().int().nullable(),
    maxAmountCents: z.number().int().nullable(),
    kind: SplitKind,
    potId: z.uuid().nullable(),
    origin: z.enum(['korrektur', 'manuell']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Rule')

const RuleInputSchema = z
  .object({
    accountId: z.uuid().optional(),
    direction: z.enum(['eingang', 'ausgang']).optional(),
    counterpartyIban: Iban.optional(),
    counterpartyName: z.string().trim().min(1).max(300).optional(),
    purposeContains: z.string().trim().min(1).max(300).optional(),
    minAmountCents: Cents.optional(),
    maxAmountCents: Cents.optional(),
    kind: SplitKind,
    potId: z.uuid().nullable().default(null),
  })
  .openapi('RuleInput')

const transactionParams = z.object({ transactionId: pathId('transactionId') })

const listPending = createRoute({
  method: 'get',
  path: '/v1/transactions/pending',
  tags: ['Kategorisierung'],
  summary: 'Buchungen, die auf Bestätigung warten (neueste zuerst)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    query: z.object({
      householdId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(TransactionSchema) }), 'Offene Buchungen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
  },
})

const confirm = createRoute({
  method: 'post',
  path: '/v1/transactions/{transactionId}/confirm',
  tags: ['Kategorisierung'],
  summary: 'Vorschlag mit einem Tipp bestätigen',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: transactionParams },
  responses: {
    200: json(TransactionSchema, 'Bestätigte Buchung'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Buchung nicht gefunden (oder kein Zugriff)'),
    409: error('Kein Vorschlag vorhanden'),
  },
})

const setSplits = createRoute({
  method: 'put',
  path: '/v1/transactions/{transactionId}/splits',
  tags: ['Kategorisierung'],
  summary: 'Aufteilung festlegen (korrigieren) und bestätigen',
  description:
    'Die Summe der Aufteilungen muss dem Buchungsbetrag entsprechen; Töpfe kommen aus dem ' +
    'Haushalt des Kontos. Weicht eine einfache Zuordnung vom Vorschlag ab, entsteht eine Regel ' +
    'für die Gegenpartei (außer learn = false), und offene Buchungen werden neu vorgeschlagen.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: transactionParams,
    body: json(
      z.object({
        splits: z.array(SplitSchema).min(1).max(50),
        learn: z.boolean().default(true),
      }),
      'Aufteilung',
    ),
  },
  responses: {
    200: json(
      z.object({
        transaction: TransactionSchema,
        rule: RuleSchema.nullable().openapi({ description: 'aus der Korrektur entstandene Regel' }),
        resuggested: z
          .number()
          .int()
          .openapi({ description: 'offene Buchungen, die die Regel neu vorgeschlagen hat' }),
      }),
      'Bestätigte Buchung',
    ),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Buchung nicht gefunden (oder kein Zugriff)'),
    422: error('Summe falsch oder Topf aus anderem Haushalt'),
  },
})

const listRules = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/rules',
  tags: ['Kategorisierung'],
  summary: 'Kategorisierungsregeln eines Haushalts',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ householdId: pathId('householdId') }) },
  responses: {
    200: json(z.object({ items: z.array(RuleSchema) }), 'Regeln'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
  },
})

const createRule = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/rules',
  tags: ['Kategorisierung'],
  summary: 'Regel von Hand anlegen und auf offene Buchungen anwenden',
  description:
    'Alle gesetzten Merkmale müssen passen. Bei mehreren Treffern gewinnt die spezifischste ' +
    'Regel, bei Gleichstand die zuletzt geänderte. Gleiche Merkmale ersetzen eine bestehende Regel.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ householdId: pathId('householdId') }),
    body: json(RuleInputSchema, 'Neue Regel'),
  },
  responses: {
    201: json(
      z.object({ rule: RuleSchema, resuggested: z.number().int() }),
      'Regel angelegt (oder bestehende umgelenkt)',
    ),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein Merkmal, Topf oder Konto aus anderem Haushalt'),
  },
})

const deleteRule = createRoute({
  method: 'delete',
  path: '/v1/rules/{ruleId}',
  tags: ['Kategorisierung'],
  summary: 'Regel löschen (bestehende Vorschläge bleiben)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ ruleId: pathId('ruleId') }) },
  responses: {
    204: { description: 'Gelöscht' },
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Regel nicht gefunden (oder kein Zugriff)'),
  },
})

const ruleJson = (r: Rule) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

export function categorizeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listPending, async (c) => {
    const ids = await c.var.categorize.pendingTransactionIds(
      c.var.session.person.id,
      c.req.valid('query'),
    )
    return c.json({ items: await c.var.ledger.transactionsByIds(ids) }, 200)
  })

  app.openapi(confirm, async (c) => {
    const { transactionId } = c.req.valid('param')
    await c.var.categorize.confirm(c.var.session.person.id, transactionId)
    const [transaction] = await c.var.ledger.transactionsByIds([transactionId])
    if (!transaction) throw new Error('Buchung nach dem Bestätigen nicht gefunden')
    return c.json(transaction, 200)
  })

  app.openapi(setSplits, async (c) => {
    const { transactionId } = c.req.valid('param')
    const { splits, learn } = c.req.valid('json')
    const result = await c.var.categorize.setSplits(
      c.var.session.person.id,
      transactionId,
      splits,
      {
        learn,
      },
    )
    const [transaction] = await c.var.ledger.transactionsByIds([transactionId])
    if (!transaction) throw new Error('Buchung nach dem Bestätigen nicht gefunden')
    return c.json(
      {
        transaction,
        rule: result.rule ? ruleJson(result.rule) : null,
        resuggested: result.resuggested,
      },
      200,
    )
  })

  app.openapi(listRules, async (c) => {
    const { householdId } = c.req.valid('param')
    const items = await c.var.categorize.listRules(c.var.session.person.id, householdId)
    return c.json({ items: items.map(ruleJson) }, 200)
  })

  app.openapi(createRule, async (c) => {
    const { householdId } = c.req.valid('param')
    const result = await c.var.categorize.createRule(
      c.var.session.person.id,
      householdId,
      c.req.valid('json'),
    )
    return c.json({ rule: ruleJson(result.rule), resuggested: result.resuggested }, 201)
  })

  app.openapi(deleteRule, async (c) => {
    const { ruleId } = c.req.valid('param')
    await c.var.categorize.deleteRule(c.var.session.person.id, ruleId)
    return c.body(null, 204)
  })
}
