import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
import {
  type ContributionRule,
  type ContributionsView,
  type Metrics,
  type ReceivedShare,
  type SettlementsView,
  SHARE_SCOPES,
  type ShareEntry,
} from '../couple/service.js'
import { error, IsoDate, json, Month, pathId } from './common.js'

const security = [{ bearerAuth: [] }]

const ShareScope = z.enum(SHARE_SCOPES).openapi({
  description:
    'erst_ich = ob die Erst-ich-Töpfe des Monats gefüllt sind (Anteil, kein Betrag); ' +
    'ruecklagen = ob die Rücklagen ihre Monatsrate haben (Anteil); einzahlung_soll = Soll der ' +
    'eigenen Einzahlungsregel „Prozent vom Netto“ (verrät sonst das Einkommen); budget = Budget ' +
    'und Töpfe des privaten Haushalts lesen (ohne Buchungen, ohne Ändern); sparquote = ' +
    'Sparquote des Monats als Prozentwert (ohne Beträge)',
})

const ShareSchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    scope: ShareScope,
    createdAt: z.iso.datetime(),
  })
  .openapi('Share')

const ReceivedShareSchema = ShareSchema.extend({
  householdId: z.uuid().openapi({ description: 'privater Haushalt der freigebenden Person' }),
}).openapi('ReceivedShare')

const PotProgressSchema = z
  .object({
    hasPots: z.boolean(),
    fulfilled: z.boolean().openapi({ description: 'alle Töpfe haben ihre Monatsrate' }),
    fundedPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .openapi({ description: 'zugewiesener Anteil am Plan; null ohne Plan' }),
  })
  .openapi('PotProgress')

const SavingsRateSchema = z
  .object({
    savingsRatePct: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          'Sparquote: (Einkommen − Konsum − Einzahlungen ins Gemeinsame) ÷ Einkommen in Prozent, ' +
          'abgerundet, kann negativ sein; null ohne Einkommen im Monat',
      }),
  })
  .openapi('SavingsRate')

const MetricsSchema = z
  .object({
    personId: z.uuid(),
    month: Month,
    scopes: z.array(ShareScope).openapi({ description: 'sichtbare Kennzahlen' }),
    erstIch: PotProgressSchema.nullable(),
    ruecklagen: PotProgressSchema.nullable(),
    sparquote: SavingsRateSchema.nullable(),
  })
  .openapi('PersonMetrics')

const ContributionRuleSchema = z
  .object({
    householdId: z.uuid(),
    personId: z.uuid(),
    validFrom: Month,
    kind: z.enum(['fest', 'prozent']),
    amountCents: z.number().int().nullable(),
    percentBp: z.number().int().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ContributionRule')

const ContributionsSchema = z
  .object({
    householdId: z.uuid(),
    month: Month,
    members: z.array(
      z.object({
        personId: z.uuid(),
        displayName: z.string(),
        rule: ContributionRuleSchema.nullable().openapi({ description: 'gültige Regel im Monat' }),
        targetCents: z.number().int().nullable().openapi({ description: 'Soll' }),
        targetVisible: z.boolean().openapi({
          description:
            'false bei „Prozent vom Netto“ der anderen Person ohne Freigabe einzahlung_soll',
        }),
        paidCents: z.number().int().openapi({ description: 'Ist: Einzahlungen im Monat' }),
        remainingCents: z.number().int().nullable().openapi({ description: 'Soll − Ist, ≥ 0' }),
      }),
    ),
  })
  .openapi('Contributions')

const SettlementsSchema = z
  .object({
    householdId: z.uuid(),
    balances: z.array(
      z.object({
        personId: z.uuid(),
        displayName: z.string(),
        claimedCents: z
          .number()
          .int()
          .openapi({ description: 'privat bezahlte gemeinsame Ausgaben' }),
        repaidCents: z.number().int().openapi({ description: 'erstattet (Überweisung, von Hand)' }),
        debtCents: z
          .number()
          .int()
          .openapi({ description: 'vom gemeinsamen Konto bezahlte private Ausgaben' }),
        paidBackCents: z
          .number()
          .int()
          .openapi({ description: 'zurückgezahlt (Überweisung aufs gemeinsame Konto)' }),
        openCents: z
          .number()
          .int()
          .openapi({
            description:
              'Saldo: positiv = schuldet das Gemeinsame der Person, negativ = schuldet die Person ' +
              'dem Gemeinsamen',
          }),
      }),
    ),
    openItems: z.array(
      z.object({
        transactionId: z.uuid(),
        personId: z.uuid(),
        bookingDate: IsoDate,
        counterpartyName: z.string().nullable(),
        amountCents: z.number().int().openapi({ description: 'gemeinsamer Anteil der Buchung' }),
        openCents: z.number().int(),
      }),
    ),
    openDebts: z
      .array(
        z.object({
          transactionId: z.uuid(),
          personId: z.uuid(),
          bookingDate: IsoDate,
          counterpartyName: z.string().nullable(),
          amountCents: z.number().int().openapi({ description: 'privater Anteil der Buchung' }),
          openCents: z.number().int(),
        }),
      )
      .openapi({
        description:
          'Buchungen des gemeinsamen Kontos in privaten Töpfen, die noch nicht zurückgezahlt ' +
          'oder mit Forderungen verrechnet sind (ohne den Topf selbst)',
      }),
    manual: z.array(
      z.object({
        id: z.uuid(),
        personId: z.uuid(),
        amountCents: z.number().int(),
        settledOn: IsoDate,
        note: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .openapi('Settlements')

const shareParams = z.object({
  personId: pathId('personId'),
  scope: ShareScope.openapi({ param: { name: 'scope', in: 'path' } }),
})
const householdMonth = z.object({
  householdId: pathId('householdId'),
  month: Month.openapi({ param: { name: 'month', in: 'path' } }),
})

const listShares = createRoute({
  method: 'get',
  path: '/v1/shares',
  tags: ['Paar'],
  summary: 'Eigene Freigaben (erteilt und erhalten)',
  security,
  middleware: [requireAuth] as const,
  responses: {
    200: json(
      z.object({ granted: z.array(ShareSchema), received: z.array(ReceivedShareSchema) }),
      'Freigaben',
    ),
    401: error('Nicht angemeldet'),
  },
})

const grantShare = createRoute({
  method: 'put',
  path: '/v1/shares/{personId}/{scope}',
  tags: ['Paar'],
  summary: 'Kennzahl oder Sicht auf den eigenen privaten Haushalt freigeben',
  description: 'Nur an die Person, mit der man einen Haushalt teilt. Wiederholen ändert nichts.',
  security,
  middleware: [requireAuth] as const,
  request: { params: shareParams },
  responses: {
    200: json(ShareSchema, 'Freigabe erteilt'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Person nicht gefunden (oder kein gemeinsamer Haushalt)'),
  },
})

const revokeShare = createRoute({
  method: 'delete',
  path: '/v1/shares/{personId}/{scope}',
  tags: ['Paar'],
  summary: 'Freigabe zurücknehmen (wirkt sofort)',
  security,
  middleware: [requireAuth] as const,
  request: { params: shareParams },
  responses: {
    204: { description: 'Zurückgenommen (oder gab es nicht)' },
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
  },
})

const getMetrics = createRoute({
  method: 'get',
  path: '/v1/persons/{personId}/metrics/{month}',
  tags: ['Paar'],
  summary: 'Kennzahlen aus dem privaten Haushalt einer Person',
  description:
    'Für sich selbst alle Kennzahlen, für die andere Person nur die freigegebenen; die übrigen ' +
    'sind null. Kennzahlen sind Anteile und Ja/Nein, keine Beträge.',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: z.object({
      personId: pathId('personId'),
      month: Month.openapi({ param: { name: 'month', in: 'path' } }),
    }),
  },
  responses: {
    200: json(MetricsSchema, 'Kennzahlen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Person nicht gefunden (oder kein gemeinsamer Haushalt)'),
  },
})

const listContributionRules = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/contribution-rules',
  tags: ['Paar'],
  summary: 'Einzahlungsregeln des gemeinsamen Haushalts (mit Historie)',
  security,
  middleware: [requireAuth] as const,
  request: { params: z.object({ householdId: pathId('householdId') }) },
  responses: {
    200: json(z.object({ items: z.array(ContributionRuleSchema) }), 'Regeln'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein gemeinsamer Haushalt'),
  },
})

const setContributionRule = createRoute({
  method: 'put',
  path: '/v1/households/{householdId}/contribution-rules/{month}',
  tags: ['Paar'],
  summary: 'Eigene Einzahlungsregel ab einem Monat setzen',
  description:
    'fest = Betrag je Monat (0 = Pause); prozent = Anteil der eigenen Einnahmen des Monats im ' +
    'privaten Haushalt (Netto). Es gilt die jüngste Regel bis zum Monat. Jede Person setzt nur ' +
    'ihre eigene.',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: householdMonth,
    body: json(
      z.object({
        kind: z.enum(['fest', 'prozent']),
        amountCents: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
        percentBp: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .nullable()
          .optional()
          .openapi({ description: 'Anteil in Basispunkten, 4000 = 40 %' }),
      }),
      'Regel',
    ),
  },
  responses: {
    200: json(ContributionRuleSchema, 'Regel gespeichert'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein gemeinsamer Haushalt oder Regel unvollständig'),
  },
})

const deleteContributionRule = createRoute({
  method: 'delete',
  path: '/v1/households/{householdId}/contribution-rules/{month}',
  tags: ['Paar'],
  summary: 'Eigene Einzahlungsregel ab diesem Monat löschen (die vorige gilt wieder)',
  security,
  middleware: [requireAuth] as const,
  request: { params: householdMonth },
  responses: {
    204: { description: 'Gelöscht' },
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt oder Regel nicht gefunden'),
    422: error('Kein gemeinsamer Haushalt'),
  },
})

const getContributions = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/contributions/{month}',
  tags: ['Paar'],
  summary: 'Einzahlungen ins Gemeinsame: Soll und Ist je Person',
  security,
  middleware: [requireAuth] as const,
  request: { params: householdMonth },
  responses: {
    200: json(ContributionsSchema, 'Einzahlungen des Monats'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein gemeinsamer Haushalt'),
  },
})

const getSettlements = createRoute({
  method: 'get',
  path: '/v1/households/{householdId}/settlements',
  tags: ['Paar'],
  summary: 'Ausgleich: was das Gemeinsame und die Personen einander schulden',
  description:
    'Eine Forderung entsteht, wenn eine Buchung eines privaten Kontos einem Topf des ' +
    'gemeinsamen Haushalts zugeordnet wird. Erledigt wird sie durch eine Überweisung vom ' +
    'gemeinsamen Konto (Art ausgleich) oder von Hand. Eine Schuld entsteht umgekehrt, wenn eine ' +
    'Buchung des gemeinsamen Kontos dem privaten Topf einer Person zugeordnet wird; sie zahlt ' +
    'sie per Überweisung aufs gemeinsame Konto (Art ausgleich) zurück. Forderung und Schuld ' +
    'verrechnen sich; Erstattungen decken der Reihe nach, älteste zuerst.',
  security,
  middleware: [requireAuth] as const,
  request: { params: z.object({ householdId: pathId('householdId') }) },
  responses: {
    200: json(SettlementsSchema, 'Stand des Ausgleichs'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein gemeinsamer Haushalt'),
  },
})

const recordSettlement = createRoute({
  method: 'post',
  path: '/v1/households/{householdId}/settlements',
  tags: ['Paar'],
  summary: 'Ausgleich von Hand verbuchen (z. B. bar erhalten), nur für die eigene Forderung',
  security,
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ householdId: pathId('householdId') }),
    body: json(
      z.object({
        amountCents: z.number().int().min(1).max(100_000_000_000),
        settledOn: IsoDate.optional(),
        note: z.string().trim().max(300).optional(),
      }),
      'Erhaltener Betrag',
    ),
  },
  responses: {
    201: json(SettlementsSchema, 'Stand des Ausgleichs danach'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Kein gemeinsamer Haushalt oder mehr als offen'),
  },
})

const deleteSettlement = createRoute({
  method: 'delete',
  path: '/v1/settlements/{settlementId}',
  tags: ['Paar'],
  summary: 'Von Hand verbuchten Ausgleich zurücknehmen (nur den eigenen)',
  security,
  middleware: [requireAuth] as const,
  request: { params: z.object({ settlementId: pathId('settlementId') }) },
  responses: {
    204: { description: 'Zurückgenommen' },
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    403: error('Ausgleich einer anderen Person'),
    404: error('Ausgleich nicht gefunden (oder kein Zugriff)'),
  },
})

const shareJson = (s: ShareEntry) => ({ ...s, createdAt: s.createdAt.toISOString() })
const receivedJson = (s: ReceivedShare) => ({ ...s, createdAt: s.createdAt.toISOString() })
const ruleJson = (r: ContributionRule) => ({ ...r, updatedAt: r.updatedAt.toISOString() })
const contributionsJson = (v: ContributionsView) => ({
  ...v,
  members: v.members.map((m) => ({ ...m, rule: m.rule ? ruleJson(m.rule) : null })),
})
const settlementsJson = (v: SettlementsView) => ({
  ...v,
  manual: v.manual.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
})
const metricsJson = (m: Metrics) => m

export function coupleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listShares, async (c) => {
    const { granted, received } = await c.var.couple.listShares(c.var.session.person.id)
    return c.json({ granted: granted.map(shareJson), received: received.map(receivedJson) }, 200)
  })

  app.openapi(grantShare, async (c) => {
    const { personId, scope } = c.req.valid('param')
    const share = await c.var.couple.grantShare(c.var.session.person.id, personId, scope)
    return c.json(shareJson(share), 200)
  })

  app.openapi(revokeShare, async (c) => {
    const { personId, scope } = c.req.valid('param')
    await c.var.couple.revokeShare(c.var.session.person.id, personId, scope)
    return c.body(null, 204)
  })

  app.openapi(getMetrics, async (c) => {
    const { personId, month } = c.req.valid('param')
    const metrics = await c.var.couple.metrics(c.var.session.person.id, personId, month)
    return c.json(metricsJson(metrics), 200)
  })

  app.openapi(listContributionRules, async (c) => {
    const { householdId } = c.req.valid('param')
    const items = await c.var.couple.listContributionRules(c.var.session.person.id, householdId)
    return c.json({ items: items.map(ruleJson) }, 200)
  })

  app.openapi(setContributionRule, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const rule = await c.var.couple.setContributionRule(
      c.var.session.person.id,
      householdId,
      month,
      c.req.valid('json'),
    )
    return c.json(ruleJson(rule), 200)
  })

  app.openapi(deleteContributionRule, async (c) => {
    const { householdId, month } = c.req.valid('param')
    await c.var.couple.deleteContributionRule(c.var.session.person.id, householdId, month)
    return c.body(null, 204)
  })

  app.openapi(getContributions, async (c) => {
    const { householdId, month } = c.req.valid('param')
    const view = await c.var.couple.contributions(c.var.session.person.id, householdId, month)
    return c.json(contributionsJson(view), 200)
  })

  app.openapi(getSettlements, async (c) => {
    const { householdId } = c.req.valid('param')
    const view = await c.var.couple.settlements(c.var.session.person.id, householdId)
    return c.json(settlementsJson(view), 200)
  })

  app.openapi(recordSettlement, async (c) => {
    const { householdId } = c.req.valid('param')
    const view = await c.var.couple.recordSettlement(
      c.var.session.person.id,
      householdId,
      c.req.valid('json'),
    )
    return c.json(settlementsJson(view), 201)
  })

  app.openapi(deleteSettlement, async (c) => {
    const { settlementId } = c.req.valid('param')
    await c.var.couple.deleteSettlement(c.var.session.person.id, settlementId)
    return c.body(null, 204)
  })
}
