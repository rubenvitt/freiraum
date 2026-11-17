/**
 * Konfiguration ausschließlich aus Umgebungsvariablen. Secrets gehören nie ins Repo.
 */
export interface Config {
  port: number
  databaseUrl: string
  webauthn: {
    rpId: string
    rpName: string
    origins: string[]
  }
  /** App-IDs (TEAMID.bundle.id) für apple-app-site-association; leer = Datei wird nicht ausgeliefert */
  appleAppIds: string[]
  sessionTtlDays: number
  invitationTtlHours: number
  migrateOnStart: boolean
  /** LLM für Kategorisierungsvorschläge; null = aus (nur Regeln schlagen vor) */
  llm: LlmConfig | null
}

export interface LlmConfig {
  /** OpenAI-kompatible API, Standard OpenRouter */
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  /** Nur Anbieter ohne Datenspeicherung (OpenRouter `provider.zdr`) */
  zeroDataRetention: boolean
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Umgebungsvariable ${name} fehlt`)
  return value
}

function requiredWith(env: Env, name: string, because: string): string {
  const value = env[name]?.trim()
  if (!value)
    throw new Error(`Umgebungsvariable ${name} fehlt (nötig, weil ${because} gesetzt ist)`)
  return value
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Umgebungsvariable ${name} muss eine positive ganze Zahl sein`)
  }
  return value
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`Umgebungsvariable ${name} muss true oder false sein`)
}

/** Ohne `LLM_API_KEY` bleibt das LLM aus. */
function loadLlm(env: Env): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim()
  if (!apiKey) return null
  const baseUrl = (env.LLM_BASE_URL?.trim() || OPENROUTER_BASE_URL).replace(/\/+$/, '')
  try {
    new URL(baseUrl)
  } catch {
    throw new Error('Umgebungsvariable LLM_BASE_URL ist keine gültige URL')
  }
  return {
    baseUrl,
    apiKey,
    model: requiredWith(env, 'LLM_MODEL', 'LLM_API_KEY'),
    timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 60_000),
    zeroDataRetention: bool(env, 'LLM_ZDR', true),
  }
}

export function loadConfig(env: Env = process.env): Config {
  const rpId = required(env, 'WEBAUTHN_RP_ID')
  const origins = list(env, 'WEBAUTHN_ORIGINS')
  return {
    port: positiveInt(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    webauthn: {
      rpId,
      rpName: env.WEBAUTHN_RP_NAME?.trim() || 'Freiraum',
      origins: origins.length > 0 ? origins : [`https://${rpId}`],
    },
    appleAppIds: list(env, 'APPLE_APP_IDS'),
    sessionTtlDays: positiveInt(env, 'SESSION_TTL_DAYS', 90),
    invitationTtlHours: positiveInt(env, 'INVITATION_TTL_HOURS', 72),
    migrateOnStart: (env.MIGRATE_ON_START ?? 'true').trim().toLowerCase() !== 'false',
    llm: loadLlm(env),
  }
}
