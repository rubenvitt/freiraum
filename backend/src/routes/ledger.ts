import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
import { isIsoDate } from '../ledger/dates.js'
import { type Account, MAX_IMPORT_SIZE } from '../ledger/service.js'
import { ErrorSchema } from '../schemas.js'

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const error = (description: string) => json(ErrorSchema, description)

const IsoDate = z
  .string()
  .refine(isIsoDate, 'Datum als JJJJ-MM-TT erwartet')
  .openapi({ format: 'date', example: '2026-11-03' })
const Cents = z
  .number()
  .int()
  .min(-100_000_000_000)
  .max(100_000_000_000)
  .openapi({ description: 'Betrag in Cent; negativ = Ausgang', example: -1299 })
const Iban = z
  .string()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/, 'keine gültige IBAN'))
  .openapi({ type: 'string', example: 'DE02120300000000202051' })
const AccountId = z.uuid().openapi({ param: { name: 'accountId', in: 'path' } })

const HouseholdSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['privat', 'gemeinsam']),
    name: z.string(),
    members: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  })
  .openapi('Household')

const AccountSource = z.enum(['bank', 'bar', 'manuell']).openapi({
  description: 'bank = importiert, bar = Bargeld (wird erfasst), manuell = Import per Datei/App',
})

const AccountSchema = z
  .object({
    id: z.uuid(),
    householdId: z.uuid(),
    name: z.string(),
    source: AccountSource,
    iban: z.string().nullable(),
    currency: z.literal('EUR'),
    createdAt: z.iso.datetime(),
    lastImportAt: z.iso.datetime().nullable(),
  })
  .openapi('Account')

const IncomingTransactionSchema = z
  .object({
    sourceId: z.string().min(1).max(200).optional().openapi({
      description: 'Quell-ID der Bank. Nur angeben, wenn sie bei jedem Abruf gleich bleibt.',
    }),
    bookingDate: IsoDate,
    valueDate: IsoDate.optional(),
    amountCents: Cents,
    currency: z.literal('EUR').default('EUR'),
    counterpartyName: z.string().max(300).optional(),
    counterpartyIban: Iban.optional(),
    purpose: z.string().max(2000).optional(),
  })
  .openapi('IncomingTransaction')

const ImportResultSchema = z
  .object({
    importId: z.uuid(),
    received: z.number().int(),
    imported: z.number().int().openapi({ description: 'neu übernommen' }),
    skipped: z.number().int().openapi({ description: 'schon bekannt (idempotent)' }),
    recurring: z.object({
      active: z.number().int(),
      ended: z.number().int(),
    }),
  })
  .openapi('ImportResult')

const TransactionSchema = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    sourceId: z.string().nullable(),
    bookingDate: IsoDate,
    valueDate: IsoDate.nullable(),
    amountCents: z.number().int(),
    currency: z.literal('EUR'),
    counterpartyName: z.string().nullable(),
    counterpartyIban: z.string().nullable(),
    purpose: z.string().nullable(),
    status: z.enum(['importiert', 'vorgeschlagen', 'bestaetigt']),
    recurringSeriesId: z.uuid().nullable(),
  })
  .openapi('Transaction')

const RecurringSeriesSchema = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    counterparty: z.string(),
    direction: z.enum(['eingang', 'ausgang']),
    cadence: z.enum([
      'woechentlich',
      'zweiwoechentlich',
      'monatlich',
      'quartalsweise',
      'halbjaehrlich',
      'jaehrlich',
    ]),
    typicalAmountCents: z.number().int().openapi({ description: 'Median der Beträge' }),
    minAmountCents: z.number().int(),
    maxAmountCents: z.number().int(),
    occurrences: z.number().int(),
    firstDate: IsoDate,
    lastDate: IsoDate,
    nextExpectedDate: IsoDate,
    state: z.enum(['aktiv', 'beendet']).openapi({
      description: 'beendet = nächste Buchung deutlich überfällig (z. B. gekündigtes Abo)',
    }),
  })
  .openapi('RecurringSeries')

const listHouseholds = createRoute({
  method: 'get',
  path: '/v1/households',
  tags: ['Haushalte'],
  summary: 'Haushalte, in denen die angemeldete Person Mitglied ist',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: json(z.object({ items: z.array(HouseholdSchema) }), 'Haushalte'),
    401: error('Nicht angemeldet'),
  },
})

const createAccount = createRoute({
  method: 'post',
  path: '/v1/accounts',
  tags: ['Konten'],
  summary: 'Konto in einem eigenen Haushalt anlegen',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: json(
      z.object({
        householdId: z.uuid(),
        name: z.string().trim().min(1).max(100),
        source: AccountSource,
        iban: Iban.optional(),
      }),
      'Neues Konto',
    ),
  },
  responses: {
    201: json(AccountSchema, 'Konto angelegt'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Haushalt nicht gefunden (oder kein Zugriff)'),
    422: error('Fachlich unzulässig'),
  },
})

const listAccounts = createRoute({
  method: 'get',
  path: '/v1/accounts',
  tags: ['Konten'],
  summary: 'Konten aller eigenen Haushalte',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: json(z.object({ items: z.array(AccountSchema) }), 'Konten'),
    401: error('Nicht angemeldet'),
  },
})

const importTransactions = createRoute({
  method: 'post',
  path: '/v1/accounts/{accountId}/imports',
  tags: ['Konten'],
  summary: 'Buchungen idempotent importieren',
  description:
    'Bekannte Buchungen werden übersprungen: Schlüssel ist die Quell-ID, sonst ein Hash aus Konto, ' +
    'Buchungstag, Betrag, Verwendungszweck und Gegenpartei (plus Vorkommen bei gleichen Buchungen am ' +
    'selben Tag). ' +
    'Ein Abruf sollte deshalb immer ganze Tage abdecken. Danach werden die wiederkehrenden Serien ' +
    'des Kontos neu berechnet.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ accountId: AccountId }),
    body: json(
      z.object({ transactions: z.array(IncomingTransactionSchema).max(MAX_IMPORT_SIZE) }),
      'Gebuchte Umsätze (keine vorgemerkten)',
    ),
  },
  responses: {
    201: json(ImportResultSchema, 'Import abgeschlossen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Konto nicht gefunden (oder kein Zugriff)'),
    422: error('Fachlich unzulässig, z. B. Bargeldkonto'),
  },
})

const listTransactions = createRoute({
  method: 'get',
  path: '/v1/accounts/{accountId}/transactions',
  tags: ['Konten'],
  summary: 'Buchungen eines Kontos, neueste zuerst',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ accountId: AccountId }),
    query: z.object({
      from: IsoDate.optional(),
      to: IsoDate.optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(TransactionSchema) }), 'Buchungen'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
    404: error('Konto nicht gefunden (oder kein Zugriff)'),
  },
})

const listRecurring = createRoute({
  method: 'get',
  path: '/v1/recurring',
  tags: ['Wiederkehrend'],
  summary: 'Erkannte wiederkehrende Buchungen (Abos, Miete, Gehalt)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    query: z.object({
      state: z.enum(['aktiv', 'beendet']).optional(),
      accountId: z.uuid().optional(),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(RecurringSeriesSchema) }), 'Serien'),
    400: error('Ungültige Anfrage'),
    401: error('Nicht angemeldet'),
  },
})

const accountJson = (a: Account) => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
  lastImportAt: a.lastImportAt?.toISOString() ?? null,
})

export function ledgerRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listHouseholds, async (c) => {
    const items = await c.var.ledger.listHouseholds(c.var.session.person.id)
    return c.json({ items }, 200)
  })

  app.openapi(createAccount, async (c) => {
    const account = await c.var.ledger.createAccount(c.var.session.person.id, c.req.valid('json'))
    return c.json(accountJson(account), 201)
  })

  app.openapi(listAccounts, async (c) => {
    const items = await c.var.ledger.listAccounts(c.var.session.person.id)
    return c.json({ items: items.map(accountJson) }, 200)
  })

  app.openapi(importTransactions, async (c) => {
    const { accountId } = c.req.valid('param')
    const { transactions } = c.req.valid('json')
    const result = await c.var.ledger.importTransactions(
      c.var.session.person.id,
      accountId,
      transactions,
    )
    return c.json(result, 201)
  })

  app.openapi(listTransactions, async (c) => {
    const { accountId } = c.req.valid('param')
    const items = await c.var.ledger.listTransactions(
      c.var.session.person.id,
      accountId,
      c.req.valid('query'),
    )
    return c.json({ items }, 200)
  })

  app.openapi(listRecurring, async (c) => {
    const items = await c.var.ledger.listRecurring(c.var.session.person.id, c.req.valid('query'))
    return c.json({ items }, 200)
  })
}
