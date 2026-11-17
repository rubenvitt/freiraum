import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { defaultFrom, MAX_RANGE_MONTHS } from '../analytics/service.js'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
import { monthOf } from '../budget/months.js'
import { todayUtc } from '../ledger/dates.js'
import { error, json, Month, pathId } from './common.js'

const Bp = z
  .number()
  .int()
  .nullable()
  .openapi({ description: 'Anteil in Basispunkten (10 000 = 100 %), null ohne Einkommen' })

const PotKind = z.enum(['monatlich', 'ruecklage', 'ziel', 'erst_ich'])

const metricFields = {
  incomeCents: z.number().int().openapi({
    description:
      'Einkommen: Einnahme-Aufteilungen; im gemeinsamen Haushalt auch die Einzahlungen der Personen',
  }),
  consumptionCents: z
    .number()
    .int()
    .openapi({
      description:
        'Konsum (positiv = ausgegeben): Töpfe außer Erst-ich, abzüglich Erstattungen, plus nicht ' +
        'zugeordnete Ausgänge',
    }),
  erstIchCents: z
    .number()
    .int()
    .openapi({ description: 'Ausgaben aus Erst-ich-Töpfen (Sparen, kein Konsum)' }),
  contributionsCents: z
    .number()
    .int()
    .openapi({
      description:
        'Einzahlungen ins Gemeinsame vom privaten Konto (positiv = abgeflossen): kein Konsum, ' +
        'aber auch nicht gespart',
    }),
  savedCents: z.number().int().openapi({ description: 'Einkommen − Konsum − Einzahlungen' }),
  savingsRateBp: Bp.openapi({ description: 'Sparquote: Gespart ÷ Einkommen, in Basispunkten' }),
  fixedCostsCents: z.number().int().openapi({
    description: 'Konsum aus wiederkehrenden Ausgängen (Miete, Versicherungen, Abos)',
  }),
  fixedCostShareBp: Bp.openapi({ description: 'Fixkosten ÷ Einkommen, in Basispunkten' }),
  uncategorizedOutCents: z.number().int().openapi({ description: 'nicht zugeordnete Ausgänge' }),
  uncategorizedInCents: z
    .number()
    .int()
    .openapi({ description: 'nicht zugeordnete Eingänge (zählen nicht als Einkommen)' }),
}

const MonthMetricsSchema = z
  .object({
    month: Month,
    ...metricFields,
    ageOfMoneyDays: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          'Alter des Geldes am Monatsende (bzw. heute): Durchschnitt der letzten 10 Ausgänge, wie ' +
          'lange das ausgegebene Geld schon da war (älteste Eingänge zuerst verbraucht)',
      }),
  })
  .openapi('MonthMetrics')

const MetricsSchema = z
  .object({
    householdId: z.uuid(),
    from: Month,
    to: Month,
    months: z.array(MonthMetricsSchema),
    totals: z.object(metricFields).openapi('MetricsTotals'),
    runway: z
      .object({
        cashCents: z.number().int().openapi({
          description:
            'Geld des Haushalts heute: Noch ohne Aufgabe + alle Töpfe + nicht zugeordnete Buchungen',
        }),
        averageMonthlyConsumptionCents: z.number().int().nullable(),
        fixedContributionsCents: z.number().int().openapi({
          description:
            'Feste Einzahlungen ins Gemeinsame, die jetzt gelten (nur privat; Prozent vom Netto zählt nicht)',
        }),
        monthlyOutflowCents: z.number().int().nullable().openapi({
          description: 'Konsum im Schnitt + feste Einzahlungen; null ohne Historie',
        }),
        basedOnMonths: z
          .number()
          .int()
          .openapi({ description: 'abgeschlossene Monate im Schnitt (höchstens 6)' }),
        months: z.number().nullable().openapi({
          description: 'Monate ohne Einkommen bei diesem Abfluss, eine Nachkommastelle',
          example: 7.4,
        }),
      })
      .openapi('Runway'),
  })
  .openapi('Metrics')

const FlowSchema = z
  .object({
    householdId: z.uuid(),
    from: Month,
    to: Month,
    nodes: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          kind: z.enum(['quelle', 'haushalt', 'gruppe', 'topf', 'rest']),
          potId: z.uuid().nullable(),
          potKind: PotKind.nullable(),
        })
        .openapi('FlowNode'),
    ),
    links: z.array(
      z
        .object({
          source: z.string(),
          target: z.string(),
          valueCents: z.number().int().openapi({ description: 'immer positiv' }),
        })
        .openapi('FlowLink'),
    ),
    inCents: z.number().int().openapi({ description: 'Zufluss in den Haushalt (ohne Ausgleich)' }),
    outCents: z
      .number()
      .int()
      .openapi({ description: 'Abfluss aus dem Haushalt (ohne Ausgleich)' }),
  })
  .openapi('Flow', {
    description:
      'Sankey: Quellen → Haushalt → Gruppen → Töpfe. Die Mitte ist ausgeglichen („Aus Erspartem“ ' +
      'bzw. „Übrig“). Umbuchungen zwischen eigenen Konten fehlen.',
  })

const AnomaliesSchema = z
  .object({
    householdId: z.uuid(),
    month: Month,
    items: z.array(
      z
        .object({
          kind: z.enum(['ausgaben_hoch', 'neues_abo', 'preis_erhoeht']),
          title: z.string().openapi({ description: 'ein Satz für die Anzeige' }),
          potId: z.uuid().nullable(),
          seriesId: z.uuid().nullable(),
          amountCents: z.number().int(),
          referenceCents: z.number().int().nullable(),
        })
        .openapi('Anomaly'),
    ),
  })
  .openapi('Anomalies')

const GoalsSchema = z
  .object({
    householdId: z.uuid(),
    month: Month,
    items: z.array(
      z
        .object({
          potId: z.uuid(),
          name: z.string(),
          targetCents: z.number().int(),
          savedCents: z.number().int().openapi({ description: 'Verfügbar im Topf, ≥ 0' }),
          remainingCents: z.number().int(),
          progressBp: z.number().int(),
          targetMonth: Month.nullable(),
          monthlyRateCents: z.number().int().openapi({
            description: 'Durchschnittliche Zuweisung der letzten 3 Monate (mit dem laufenden)',
          }),
          projectedMonth: Month.nullable().openapi({
            description: 'Monat, in dem das Ziel bei dieser Rate erreicht ist',
          }),
          requiredMonthlyCents: z.number().int().nullable().openapi({
            description: 'Monatlich nötig ab dem nächsten Monat, um den Zielmonat zu halten',
          }),
          status: z.enum(['erreicht', 'im_plan', 'verspaetet', 'ohne_sparrate']),
        })
        .openapi('GoalForecast'),
    ),
  })
  .openapi('Goals')

const AssetSchema = z
  .object({
    id: z.uuid(),
    householdId: z.uuid(),
    name: z.string(),
    valueCents: z.number().int().nullable().openapi({ description: 'aktueller Wert, von Hand' }),
    sortOrder: z.number().int(),
    potIds: z.array(z.uuid()).openapi({ description: 'Töpfe mit den laufenden Kosten' }),
    archived: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Asset')

const OwnershipCostsSchema = z
  .object({
    householdId: z.uuid(),
    from: Month,
    to: Month,
    items: z.array(
      z
        .object({
          assetId: z.uuid(),
          name: z.string(),
          valueCents: z.number().int().nullable(),
          costCents: z
            .number()
            .int()
            .openapi({ description: 'Nettokosten im Zeitraum aus den Töpfen (positiv = kostet)' }),
          recurringCostCents: z.number().int().openapi({ description: 'davon wiederkehrend' }),
          monthlyAverageCents: z.number().int(),
          annualCostOfValueBp: z.number().int().nullable().openapi({
            description: 'Jahreskosten im Verhältnis zum Wert, in Basispunkten',
          }),
          classification: z.enum(['verbindlichkeit', 'vermoegenswert', 'neutral']).openapi({
            description:
              'Vermögenswert ohne Gewinn = Verbindlichkeit: kostet mehr, als er einbringt',
          }),
          pots: z.array(
            z.object({ potId: z.uuid(), name: z.string(), costCents: z.number().int() }),
          ),
        })
        .openapi('AssetCosts'),
    ),
    totalCostCents: z.number().int(),
    shareOfConsumptionBp: Bp.openapi({ description: 'Anteil der Besitzkosten am Konsum' }),
  })
  .openapi('OwnershipCosts')

const householdParams = z.object({ householdId: pathId('householdId') })
const range = z.object({
  from: Month.optional(),
  to: Month.optional().openapi({ description: 'Standard: laufender Monat' }),
})

const security = [{ bearerAuth: [] }]
const tags = ['Auswertungen']
const common = {
  400: error('Ungültige Anfrage'),
  401: error('Nicht angemeldet'),
  404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
}
const rangeError = {
  422: error(`Zeitraum ungültig (Anfang nach Ende oder mehr als ${MAX_RANGE_MONTHS} Monate)`),
}

const getMetrics = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/analytics/metrics',
  tags,
  summary: 'Kennzahlen je Monat: Sparquote, Fixkostenanteil, Alter des Geldes; dazu Runway',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    query: range.extend({
      from: Month.optional().openapi({ description: 'Standard: 11 Monate vor `to`' }),
    }),
  },
  responses: { 200: json(MetricsSchema, 'Kennzahlen'), ...common, ...rangeError },
})

const getFlow = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/analytics/flow',
  tags,
  summary: 'Geldfluss als Sankey: woher, wohin',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    query: range.extend({ from: Month.optional().openapi({ description: 'Standard: `to`' }) }),
  },
  responses: { 200: json(FlowSchema, 'Geldfluss'), ...common, ...rangeError },
})

const getAnomalies = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/analytics/anomalies',
  tags,
  summary: 'Auffälligkeiten eines Monats: hohe Ausgaben, neue Abos, Preiserhöhungen',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    query: z.object({
      month: Month.optional().openapi({ description: 'Standard: laufender Monat' }),
    }),
  },
  responses: { 200: json(AnomaliesSchema, 'Auffälligkeiten'), ...common },
})

const getGoals = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/analytics/goals',
  tags,
  summary: 'Ziel-Töpfe mit Prognose, wann das Ziel erreicht ist',
  security,
  middleware: [requireAuth] as const,
  request: { params: householdParams },
  responses: { 200: json(GoalsSchema, 'Ziele'), ...common },
})

const getOwnershipCosts = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/analytics/ownership-costs',
  tags,
  summary: 'Besitzkosten: Was kostet mich mein Besitz?',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    query: range.extend({
      from: Month.optional().openapi({ description: 'Standard: 11 Monate vor `to`' }),
    }),
  },
  responses: { 200: json(OwnershipCostsSchema, 'Besitzkosten'), ...common, ...rangeError },
})

const AssetName = z.string().trim().min(1).max(100)
const AssetValue = z.number().int().min(0).max(100_000_000_000)
const PotIds = z.array(z.uuid()).max(50)

const listAssets = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/assets',
  tags: ['Besitz'],
  summary: 'Besitz eines Haushalts',
  security,
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
  responses: { 200: json(z.object({ items: z.array(AssetSchema) }), 'Besitz'), ...common },
})

const createAsset = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/assets',
  tags: ['Besitz'],
  summary: 'Besitz anlegen und mit Töpfen verknüpfen',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdParams,
    body: json(
      z.object({
        name: AssetName,
        valueCents: AssetValue.nullable().optional(),
        potIds: PotIds.optional(),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
      }),
      'Neuer Besitz',
    ),
  },
  responses: {
    201: json(AssetSchema, 'Besitz angelegt'),
    ...common,
    409: error('Name vergeben oder Topf schon mit anderem Besitz verknüpft'),
    422: error('Topf aus anderem Haushalt'),
  },
})

const assetParams = z.object({ assetId: pathId('assetId') })

const updateAsset = createRoute({
  method: 'patch',
  path: '/v1/assets/{assetId}',
  tags: ['Besitz'],
  summary: 'Besitz ändern, Töpfe neu verknüpfen oder archivieren',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: assetParams,
    body: json(
      z.object({
        name: AssetName.optional(),
        valueCents: AssetValue.nullable().optional(),
        potIds: PotIds.optional().openapi({ description: 'ersetzt die ganze Liste' }),
        sortOrder: z.number().int().min(0).max(100_000).optional(),
        archived: z.boolean().optional(),
      }),
      'Änderungen',
    ),
  },
  responses: {
    200: json(AssetSchema, 'Besitz geändert'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Besitz nicht gefunden (oder kein Zugriff)'),
    409: error('Name vergeben oder Topf schon mit anderem Besitz verknüpft'),
    422: error('Topf aus anderem Haushalt'),
  },
})

const deleteAsset = createRoute({
  method: 'delete',
  path: '/v1/assets/{assetId}',
  tags: ['Besitz'],
  summary: 'Besitz löschen (Töpfe und Buchungen bleiben)',
  security,
  middleware: [requireAuth] as const,
  request: { params: assetParams },
  responses: {
    204: { description: 'Gelöscht' },
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Besitz nicht gefunden (oder kein Zugriff)'),
  },
})

const assetJson = <T extends { createdAt: Date }>(a: T) => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
})

const currentMonth = () => monthOf(todayUtc())

export function analyticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(getMetrics, async (c) => {
    const { householdId } = c.req.valid('param')
    const q = c.req.valid('query')
    const to = q.to ?? currentMonth()
    const view = await c.var.analytics.metrics(
      c.var.session.person.id,
      householdId,
      q.from ?? defaultFrom(to, 12),
      to,
    )
    return c.json(view, 200)
  })

  app.openapi(getFlow, async (c) => {
    const { householdId } = c.req.valid('param')
    const q = c.req.valid('query')
    const to = q.to ?? currentMonth()
    const view = await c.var.analytics.flow(c.var.session.person.id, householdId, q.from ?? to, to)
    return c.json(view, 200)
  })

  app.openapi(getAnomalies, async (c) => {
    const { householdId } = c.req.valid('param')
    const month = c.req.valid('query').month ?? currentMonth()
    const view = await c.var.analytics.anomalies(c.var.session.person.id, householdId, month)
    return c.json(view, 200)
  })

  app.openapi(getGoals, async (c) => {
    const { householdId } = c.req.valid('param')
    const view = await c.var.analytics.goals(c.var.session.person.id, householdId)
    return c.json(view, 200)
  })

  app.openapi(getOwnershipCosts, async (c) => {
    const { householdId } = c.req.valid('param')
    const q = c.req.valid('query')
    const to = q.to ?? currentMonth()
    const view = await c.var.analytics.ownershipCosts(
      c.var.session.person.id,
      householdId,
      q.from ?? defaultFrom(to, 12),
      to,
    )
    return c.json(view, 200)
  })

  app.openapi(listAssets, async (c) => {
    const { householdId } = c.req.valid('param')
    const { includeArchived } = c.req.valid('query')
    const items = await c.var.analytics.listAssets(
      c.var.session.person.id,
      householdId,
      includeArchived,
    )
    return c.json({ items: items.map(assetJson) }, 200)
  })

  app.openapi(createAsset, async (c) => {
    const { householdId } = c.req.valid('param')
    const asset = await c.var.analytics.createAsset(
      c.var.session.person.id,
      householdId,
      c.req.valid('json'),
    )
    return c.json(assetJson(asset), 201)
  })

  app.openapi(updateAsset, async (c) => {
    const { assetId } = c.req.valid('param')
    const asset = await c.var.analytics.updateAsset(
      c.var.session.person.id,
      assetId,
      c.req.valid('json'),
    )
    return c.json(assetJson(asset), 200)
  })

  app.openapi(deleteAsset, async (c) => {
    const { assetId } = c.req.valid('param')
    await c.var.analytics.deleteAsset(c.var.session.person.id, assetId)
    return c.body(null, 204)
  })
}
