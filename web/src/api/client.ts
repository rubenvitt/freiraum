// Client für die Freiraum-API, Typen erzeugt aus openapi/openapi.yaml (`pnpm gen`).
// Angemeldet wird per HttpOnly-Cookie (ADR 0007): Die Seite sieht das Token nie.
import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

type Schemas = components['schemas']
export type Person = Schemas['Person']
export type Household = Schemas['Household']
export type Metrics = Schemas['Metrics']
export type MonthMetrics = Schemas['MonthMetrics']
export type Flow = Schemas['Flow']
export type FlowNode = Schemas['FlowNode']
export type FlowLink = Schemas['FlowLink']
export type PersonFlow = Schemas['PersonFlow']
export type Anomalies = Schemas['Anomalies']
export type Anomaly = Schemas['Anomaly']
export type Goals = Schemas['Goals']
export type GoalForecast = Schemas['GoalForecast']
export type OwnershipCosts = Schemas['OwnershipCosts']
export type AssetCosts = Schemas['AssetCosts']

export const api = createClient<paths>({ baseUrl: '', credentials: 'same-origin' })

/** Fehler mit der Meldung des Servers (`error.message`), damit die Seite sie zeigen kann. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Result<T> = {
  data?: T
  error?: unknown
  response: Response
}

/** Daten einer Antwort, sonst ApiError mit Code und Meldung des Servers. */
export function unwrap<T>(result: Result<T>): T {
  if (result.data !== undefined && result.response.ok) return result.data
  const status = result.response.status
  const body = result.error as { error?: { code?: string; message?: string } } | undefined
  throw new ApiError(
    status,
    body?.error?.code ?? 'unbekannt',
    body?.error?.message ?? `Der Server antwortet mit ${status}.`,
  )
}
