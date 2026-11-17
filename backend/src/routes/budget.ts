import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
import type { BudgetMonthView, Pot } from '../budget/service.js'
import { Cents, error, IsoDate, json, Month, pathId } from './common.js'

const PotKind = z.enum(['monatlich', 'ruecklage', 'ziel', 'erst_ich']).openapi({
  description:
    'monatlich = Monatsbudget (amountCents je Monat, optional); ruecklage = unregelmäßige ' +
    'Kosten (amountCents je Jahr, Monatsrate = ein Zwölftel); ziel = Zielbetrag (amountCents) ' +
    'bis targetMonth; erst_ich = wird nach jeder Einnahme zuerst gefüllt (amountCents je Monat ' +
    'oder percentBp der Einnahmen des Monats)',
})

const PositiveCents = z.number().int().min(1).max(100_000_000_000)
const PercentBp = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .openapi({ description: 'Anteil in Basispunkten, 1000 = 10 %', example: 1000 })

const PotSchema = z
  .object({
    id: z.uuid(),
    householdId: z.uuid(),
    name: z.string(),
    kind: PotKind,
    groupName: z.string().nullable(),
    amountCents: z.number().int().nullable(),
    percentBp: z.number().int().nullable(),
    targetMonth: Month.nullable(),
    sortOrder: z.number().int(),
    archived: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Pot')

const BudgetPotSchema = z
  .object({
    potId: z.uuid(),
    name: z.string(),
    kind: PotKind,
    groupName: z.string().nullable(),
    archived: z.boolean(),
    carryoverCents: z.number().int().openapi({ description: 'Übertrag aus dem Vormonat, ≥ 0' }),
    assignedCents: z.number().int(),
    assignmentSource: z.enum(['manuell', 'automatik']).nullable(),
    activityCents: z
      .number()
      .int()
      .openapi({ description: 'Summe der Aufteilungen im Monat (Ausgaben negativ)' }),
    availableCents: z
      .number()
      .int()
      .openapi({ description: 'Übertrag + Zuweisung + Aufteilungen; negativ = überzogen' }),
    planCents: z.number().int().openapi({ description: 'Was der Plan für den Monat vorsieht' }),
    neededCents: z.number().int().openapi({ description: 'Davon noch nicht zugewiesen' }),
  })
  .openapi('BudgetPot')

const BudgetMonthSchema = z
  .object({
    householdId: z.uuid(),
    month: Month,
    budgetStartMonth: Month.openapi({
      description: 'Budgetbeginn des Haushalts; Monate davor sind leer',
    }),
    closedAt: z.iso.datetime().nullable(),
    readyToAssignCents: z
      .number()
      .int()
      .openapi({
        description:
          '„Noch ohne Aufgabe“: Einnahmen bis zum Monat − alle Zuweisungen (auch spätere Monate) − ' +
          'Überziehung der Vormonate',
      }),
    openingBalanceCents: z
      .number()
      .int()
      .openapi({
        description:
          'Anfangsbestand (Summe der Kontostände zum Budgetbeginn), nur im Startmonat, sonst 0. ' +
          'Zählt zu „Noch ohne Aufgabe“, nicht zu den Einnahmen',
      }),
    inflowsCents: z.number().int().openapi({ description: 'Einnahmen im Monat' }),
    assignedCents: z.number().int(),
    activityCents: z.number().int(),
    overspentPreviousCents: z
      .number()
      .int()
      .openapi({ description: 'Überziehung im Vormonat, mindert „Noch ohne Aufgabe“' }),
    assignedInFutureCents: z.number().int(),
    unconfirmedTransactions: z.number().int(),
    pots: z.array(BudgetPotSchema),
  })
  .openapi('BudgetMonth')

const BalanceSchema = z.object({
  cents: z.number().int(),
  date: IsoDate.openapi({ description: 'Stand am Ende dieses Tages' }),
  source: z.enum(['manuell', 'anbieter']),
})

const BudgetStartSchema = z
  .object({
    householdId: z.uuid(),
    month: Month.openapi({ description: 'Startmonat; Buchungen davor zählen nicht im Budget' }),
    openingBalanceCents: z.number().int().openapi({
      description: 'Anfangsbestand = Summe der Konten; Konten ohne Kontostand zählen mit 0',
    }),
    accounts: z.array(
      z.object({
        accountId: z.uuid(),
        name: z.string(),
        balance: BalanceSchema.nullable().openapi({ description: 'Bekannter Kontostand' }),
        openingBalanceCents: z
          .number()
          .int()
          .nullable()
          .openapi({
            description:
              'Stand zu Beginn des Startmonats: Kontostand − Buchungen ab Startmonat bis zum ' +
              'Stichtag; null ohne Kontostand',
          }),
      }),
    ),
  })
  .openapi('BudgetStart')

const householdParams = z.object({ householdId: pathId('householdId') })
const monthParams = z.object({
  householdId: pathId('householdId'),
  month: Month.openapi({ param: { name: 'month', in: 'path' } }),
})

const listPots = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/pots',
  tags: ['Budget'],
  summary: 'Töpfe eines Haushalts',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    query: z.object({
      includeArchived: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(PotSchema) }), 'Töpfe'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
  },
})

const createPot = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/pots',
  tags: ['Budget'],
  summary: 'Topf anlegen',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    body: json(
      z.object({
        name: z.string().trim().min(1).max(100),
        kind: PotKind,
        groupName: z.string().trim().max(100).nullable().optional(),
        amountCents: PositiveCents.nullable().optional(),
        percentBp: PercentBp.nullable().optional(),
        targetMonth: Month.nullable().optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
      }),
      'Neuer Topf',
    ),
  },
  responses: {
    201: json(PotSchema, 'Topf angelegt'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    409: error('Name schon vergeben'),
    422: error('Plan passt nicht zum Topf-Typ'),
  },
})

const updatePot = createRoute({
  method: 'patch',
  path: '/v1/pots/{potId}',
  tags: ['Budget'],
  summary: 'Topf ändern oder archivieren',
  description: 'Der Typ lässt sich nicht ändern. Archivieren geht nur, wenn der Topf leer ist.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ potId: pathId('potId') }),
    body: json(
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        groupName: z.string().trim().max(100).nullable().optional(),
        amountCents: PositiveCents.nullable().optional(),
        percentBp: PercentBp.nullable().optional(),
        targetMonth: Month.nullable().optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
        archived: z.boolean().optional(),
      }),
      'Änderungen',
    ),
  },
  responses: {
    200: json(PotSchema, 'Topf geändert'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Topf nicht gefunden (oder kein Zugriff)'),
    409: error('Name vergeben oder Topf nicht leer'),
    422: error('Plan passt nicht zum Topf-Typ'),
  },
})

const getMonth = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/budget/{month}',
  tags: ['Budget'],
  summary: 'Budget eines Monats: „Noch ohne Aufgabe“ und alle Töpfe',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: monthParams },
  responses: {
    200: json(BudgetMonthSchema, 'Budget des Monats'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
  },
})

const setAssignment = createRoute({
  method: 'put',
  path: '/v1/households/{householdId}/budget/{month}/pots/{potId}',
  tags: ['Budget'],
  summary: 'Zuweisung eines Topfs für einen Monat setzen',
  description:
    'Erhöhen geht nur, solange „Noch ohne Aufgabe“ im Monat (und im laufenden Monat, falls ' +
    'später) nicht negativ wird. Senken geht immer. Eine eigene Zuweisung an einen Erst-ich-Topf ' +
    'schaltet die Automatik für diesen Topf und Monat ab.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: monthParams.extend({ potId: pathId('potId') }),
    body: json(z.object({ assignedCents: Cents }), 'Neuer Betrag (nicht die Änderung)'),
  },
  responses: {
    200: json(BudgetMonthSchema, 'Budget des Monats nach der Änderung'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt oder Topf nicht gefunden (oder kein Zugriff)'),
    409: error('Monat abgeschlossen'),
    422: error('Nicht genug Geld ohne Aufgabe, oder Topf archiviert'),
  },
})

const fillErstIch = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/budget/{month}/erst-ich',
  tags: ['Budget'],
  summary: 'Erst-ich-Automatik für einen Monat von Hand anstoßen',
  description:
    'Läuft sonst von selbst nach jeder neuen Einnahme. Füllt die Erst-ich-Töpfe in ihrer ' +
    'Reihenfolge bis zu ihrem Plan, soweit „Noch ohne Aufgabe“ reicht.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: monthParams },
  responses: {
    200: json(BudgetMonthSchema, 'Budget des Monats'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    409: error('Monat abgeschlossen'),
  },
})

const closeMonth = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/budget/{month}/closing',
  tags: ['Budget'],
  summary: 'Monat abschließen',
  description:
    'Nur vergangene Monate, der Reihe nach, und nur wenn alle Buchungen des Monats bestätigt ' +
    'sind. Danach nimmt der Monat keine Zuweisungen mehr an; der Stand wird festgehalten.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: monthParams },
  responses: {
    201: json(BudgetMonthSchema, 'Monat abgeschlossen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    409: error('Monat läuft noch, ist schon abgeschlossen, Vormonat offen oder Buchungen offen'),
  },
})

const reopenMonth = createRoute({
  method: 'delete',
  path: '/v1/households/{householdId}/budget/{month}/closing',
  tags: ['Budget'],
  summary: 'Abschluss zurücknehmen (nur der zuletzt abgeschlossene Monat)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: monthParams },
  responses: {
    200: json(BudgetMonthSchema, 'Monat wieder offen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    409: error('Monat nicht abgeschlossen oder späterer Monat abgeschlossen'),
  },
})

const getStart = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/budget-start',
  tags: ['Budget'],
  summary: 'Budgetbeginn und Anfangsbestand eines Haushalts',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: householdParams },
  responses: {
    200: json(BudgetStartSchema, 'Budgetbeginn'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
  },
})

const setStart = createRoute({
  method: 'put',
  path: '/v1/households/{householdId}/budget-start',
  tags: ['Budget'],
  summary: 'Budgetbeginn festlegen',
  description:
    'Buchungen vor dem Startmonat zählen nicht im Budget (Import und Serien behalten sie). Geht ' +
    'nur, solange kein Monat abgeschlossen ist und vor dem neuen Start keine eigene Zuweisung ' +
    'liegt. Rückt der Start nach vorn, bekommen die neu hinzukommenden Buchungen Vorschläge.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    body: json(z.object({ month: Month }), 'Neuer Startmonat'),
  },
  responses: {
    200: json(BudgetStartSchema, 'Budgetbeginn nach der Änderung'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    409: error('Monat abgeschlossen oder Zuweisungen vor dem neuen Start'),
  },
})

const setBalance = createRoute({
  method: 'put',
  path: '/v1/accounts/{accountId}/balance',
  tags: ['Budget'],
  summary: 'Kontostand von Hand erfassen',
  description:
    'Stand am Ende des Tages `date`, einschließlich aller Buchungen bis dahin. Daraus leitet ' +
    'sich der Anfangsbestand zum Budgetbeginn ab. Ersetzt einen bekannten Kontostand.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ accountId: pathId('accountId') }),
    body: json(z.object({ balanceCents: Cents, date: IsoDate }), 'Kontostand'),
  },
  responses: {
    200: json(BudgetStartSchema, 'Budgetbeginn des Haushalts nach der Änderung'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Konto nicht gefunden (oder kein Zugriff)'),
    422: error('Stichtag in der Zukunft'),
  },
})

const potJson = (p: Pot) => ({ ...p, createdAt: p.createdAt.toISOString() })
const monthJson = (m: BudgetMonthView) => ({ ...m, closedAt: m.closedAt?.toISOString() ?? null })

export function budgetRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listPots, async (c) => {
    const { householdId } = c.req.valid('param')
    const { includeArchived } = c.req.valid('query')
    const items = await c.var.budget.listPots(c.var.session.person.id, householdId, includeArchived)
    return c.json({ items: items.map(potJson) }, 200)
  })

  app.openapi(createPot, async (c) => {
    const { householdId } = c.req.valid('param')
    const pot = await c.var.budget.createPot(
      c.var.session.person.id,
      householdId,
      c.req.valid('json'),
    )
    return c.json(potJson(pot), 201)
  })

  app.openapi(updatePot, async (c) => {
    const { potId } = c.req.valid('param')
    const pot = await c.var.budget.updatePot(c.var.session.person.id, potId, c.req.valid('json'))
    return c.json(potJson(pot), 200)
  })

  app.openapi(getStart, async (c) => {
    const { householdId } = c.req.valid('param')
    return c.json(await c.var.budget.getStart(c.var.session.person.id, householdId), 200)
  })

  app.openapi(setStart, async (c) => {
    const { householdId } = c.req.valid('param')
    const start = await c.var.budget.setStart(
      c.var.session.person.id,
      householdId,
      c.req.valid('json').month,
    )
    return c.json(start, 200)
  })

  app.openapi(setBalance, async (c) => {
    const { accountId } = c.req.valid('param')
    const { balanceCents, date } = c.req.valid('json')
    const start = await c.var.budget.setBalance(
      c.var.session.person.id,
      accountId,
      balanceCents,
      date,
    )
    return c.json(start, 200)
  })

  app.openapi(getMonth, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const view = await c.var.budget.getMonth(c.var.session.person.id, householdId, month)
    return c.json(monthJson(view), 200)
  })

  app.openapi(setAssignment, async (c) => {
    const { householdId, month, potId } = c.req.valid('param')
    const view = await c.var.budget.setAssignment(
      c.var.session.person.id,
      householdId,
      month,
      potId,
      c.req.valid('json').assignedCents,
    )
    return c.json(monthJson(view), 200)
  })

  app.openapi(fillErstIch, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const view = await c.var.budget.fillErstIch(c.var.session.person.id, householdId, month)
    return c.json(monthJson(view), 200)
  })

  app.openapi(closeMonth, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const view = await c.var.budget.closeMonth(c.var.session.person.id, householdId, month)
    return c.json(monthJson(view), 201)
  })

  app.openapi(reopenMonth, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const view = await c.var.budget.reopenMonth(c.var.session.person.id, householdId, month)
    return c.json(monthJson(view), 200)
  })
}
