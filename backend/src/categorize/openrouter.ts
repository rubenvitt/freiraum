/**
 * LLM-Vorschläge über OpenRouter (Entscheidung vom 17.11.2026, ADR 0003). Spricht die
 * OpenAI-kompatible Chat-Completions-Schnittstelle, die Basis-URL ist austauschbar (etwa für ein
 * lokales Modell mit derselben Schnittstelle).
 *
 * Datenschutz: Es geht nur hinaus, was in `LlmRequest` steht (Datum, Betrag, Gegenpartei,
 * Verwendungszweck, Töpfe des Haushalts). Bei OpenRouter verlangt jede Anfrage Anbieter, die
 * nichts speichern oder zum Training nutzen (`data_collection: deny`, standardmäßig auch `zdr`).
 * Pot-IDs verlassen den Server nicht: Das Modell wählt aus kurzen Kennungen (`o1`, `o2`, …).
 */
import { z } from 'zod'
import type { LlmConfig } from '../config.js'
import type { LlmCategorizer, LlmOption, LlmRequest, LlmSuggestion } from './llm.js'

type Fetch = typeof globalThis.fetch

const SYSTEM_PROMPT = [
  'Du ordnest Kontobuchungen eines privaten Haushaltsbudgets (Topf-Prinzip) genau einer der',
  'angebotenen Optionen zu.',
  'Negative Beträge sind Ausgaben, positive Beträge Eingänge.',
  '„Umbuchung“ nur, wenn Geld erkennbar zwischen eigenen Konten wandert (etwa Sparkonto,',
  'Kreditkartenabrechnung).',
  'Die Konfidenz (0–100) ist ehrlich: unter 50, wenn du rätst.',
  'Die Begründung ist ein kurzer deutscher Satz ohne Kontodaten.',
].join(' ')

const answerSchema = z.object({
  option: z.string(),
  confidence_pct: z.number(),
  reason: z.string(),
})

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
})

export const optionId = (index: number) => `o${index + 1}`

const formatEuro = (amountCents: number) => {
  const sign = amountCents < 0 ? '-' : ''
  const abs = Math.abs(amountCents)
  const euros = Math.floor(abs / 100)
  const rest = String(abs % 100).padStart(2, '0')
  return `${sign}${euros},${rest} EUR`
}

const describeOption = (o: LlmOption) => (o.groupName ? `${o.label} (${o.groupName})` : o.label)

/** Inhalt der Nutzernachricht. Bewusst nur die Felder aus `LlmRequest`. */
export function buildUserMessage(request: LlmRequest): string {
  const t = request.transaction
  return JSON.stringify({
    buchung: {
      datum: t.bookingDate,
      betrag: formatEuro(t.amountCents),
      gegenpartei: t.counterpartyName,
      verwendungszweck: t.purpose,
    },
    optionen: request.options.map((o, i) => ({ id: optionId(i), ziel: describeOption(o) })),
  })
}

/** Modelle verpacken JSON trotz Schema gelegentlich in Codeblöcke. */
const unwrapJson = (content: string) =>
  content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

export class OpenRouterCategorizer implements LlmCategorizer {
  private readonly fetch: Fetch

  constructor(
    private readonly config: LlmConfig,
    options: { fetch?: Fetch } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  private get isOpenRouter(): boolean {
    return new URL(this.config.baseUrl).hostname === 'openrouter.ai'
  }

  /**
   * Netzwerk-, HTTP- und Zeitfehler werfen (der Aufrufer versucht es später erneut). Eine
   * Antwort, die nicht passt, ergibt `null`: Das Modell hatte seine Gelegenheit.
   */
  async suggest(request: LlmRequest): Promise<LlmSuggestion | null> {
    if (request.options.length === 0) return null
    const ids = request.options.map((_, i) => optionId(i))
    const body = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(request) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'kategorisierung',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              option: { type: 'string', enum: ids, description: 'id der gewählten Option' },
              confidence_pct: { type: 'integer', description: 'Konfidenz 0–100' },
              reason: { type: 'string', description: 'Begründung in einem Satz' },
            },
            required: ['option', 'confidence_pct', 'reason'],
            additionalProperties: false,
          },
        },
      },
      ...(this.isOpenRouter
        ? {
            provider: {
              require_parameters: true,
              data_collection: 'deny',
              ...(this.config.zeroDataRetention ? { zdr: true } : {}),
            },
          }
        : {}),
    }

    let res: Response
    try {
      res = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
          ...(this.isOpenRouter ? { 'x-title': 'Freiraum' } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`LLM antwortet nicht innerhalb von ${this.config.timeoutMs} ms`)
      }
      throw new Error(`LLM nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      // Den Antworttext nicht loggen: Er könnte die Anfrage wiederholen.
      throw new Error(`LLM antwortet mit HTTP ${res.status}`)
    }

    const completion = completionSchema.safeParse(await res.json().catch(() => null))
    const content = completion.success ? completion.data.choices[0]?.message.content : null
    if (!content) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(unwrapJson(content))
    } catch {
      return null
    }
    const answer = answerSchema.safeParse(parsed)
    if (!answer.success) return null
    const option = request.options[ids.indexOf(answer.data.option)]
    const reason = answer.data.reason.replace(/\s+/g, ' ').trim()
    if (!option || !reason || !Number.isFinite(answer.data.confidence_pct)) return null
    return {
      kind: option.kind,
      potId: option.potId,
      confidencePct: Math.min(100, Math.max(0, Math.round(answer.data.confidence_pct))),
      reason,
    }
  }
}
