import { z } from '@hono/zod-openapi'
import { isMonth } from '../budget/months.js'
import { isIsoDate } from '../ledger/dates.js'
import { ErrorSchema } from '../schemas.js'

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
export const error = (description: string) => json(ErrorSchema, description)

export const IsoDate = z
  .string()
  .refine(isIsoDate, 'Datum als JJJJ-MM-TT erwartet')
  .openapi({ format: 'date', example: '2026-11-03' })

export const Month = z
  .string()
  .refine(isMonth, 'Monat als JJJJ-MM erwartet')
  .openapi({ example: '2026-11', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' })

export const Cents = z
  .number()
  .int()
  .min(-100_000_000_000)
  .max(100_000_000_000)
  .openapi({ description: 'Betrag in Cent; negativ = Ausgang', example: -1299 })

export const pathId = (name: string) => z.uuid().openapi({ param: { name, in: 'path' } })

/** Lesende Routen: Bearer-Token der Apps oder Sitzungs-Cookie des Browsers (ADR 0007). */
export const authRead: Record<string, string[]>[] = [{ bearerAuth: [] }, { cookieAuth: [] }]
/** Schreibende Routen: nur Bearer-Token; das Cookie öffnet sie nie. */
export const authWrite: Record<string, string[]>[] = [{ bearerAuth: [] }]
