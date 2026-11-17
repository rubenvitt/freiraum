/**
 * LLM-Vorschläge über OpenRouter (Entscheidung vom 17.11.2026, ADR 0003). Spricht die
 * OpenAI-kompatible Chat-Completions-Schnittstelle, die Basis-URL ist austauschbar (etwa für ein
 * lokales Modell mit derselben Schnittstelle).
 *
 * Eine Anfrage trägt mehrere Buchungen (FREI-16); das Modell antwortet mit einem Array, je
 * Buchung ein Eintrag.
 *
 * Datenschutz: Es geht nur hinaus, was in `LlmRequest` steht (Datum, Betrag, Gegenpartei,
 * Verwendungszweck, Töpfe des Haushalts). Bei OpenRouter verlangt jede Anfrage Anbieter, die
 * nichts speichern oder zum Training nutzen (`data_collection: deny`, standardmäßig auch `zdr`).
 * IDs verlassen den Server nicht: Das Modell sieht kurze Kennungen für Buchungen (`b1`, `b2`, …)
 * und Optionen (`o1`, `o2`, …).
 */
import { z } from 'zod'
import type { LlmConfig } from '../config.js'
import type { LlmCategorizer, LlmOption, LlmRequest, LlmSuggestion, LlmTransaction } from './llm.js'

type Fetch = typeof globalThis.fetch

const SYSTEM_PROMPT = [
  'Du ordnest Kontobuchungen eines privaten Haushaltsbudgets (Topf-Prinzip) jeweils genau einer',
  'der angebotenen Optionen zu.',
  'Antworte für jede Buchung genau einmal, mit ihrer id.',
  'Negative Beträge sind Ausgaben, positive Beträge Eingänge.',
  '„Umbuchung“ nur, wenn Geld erkennbar zwischen eigenen Konten wandert (etwa Sparkonto,',
  'Kreditkartenabrechnung).',
  'Die Konfidenz (0–100) ist ehrlich: unter 50, wenn du rätst.',
  'Die Begründung ist ein kurzer deutscher Satz ohne Kontodaten.',
].join(' ')

const answerSchema = z.object({
  buchung: z.string(),
  option: z.string(),
  confidence_pct: z.number(),
  reason: z.string(),
})

/** Einzelne kaputte Einträge verwerfen, die übrigen behalten. */
const answersSchema = z.object({ antworten: z.array(z.unknown()) })

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
})

export const optionId = (index: number) => `o${index + 1}`
export const transactionId = (index: number) => `b${index + 1}`

/** Antwortlänge je Buchung (Kennungen, Konfidenz, ein Satz), großzügig bemessen. */
const TOKENS_PER_TRANSACTION = 150

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
  return JSON.stringify({
    buchungen: request.transactions.map((t: LlmTransaction, i) => ({
      id: transactionId(i),
      datum: t.bookingDate,
      betrag: formatEuro(t.amountCents),
      gegenpartei: t.counterpartyName,
      verwendungszweck: t.purpose,
    })),
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
   * Antwort, die nicht passt, ergibt `null` für die betroffenen Buchungen: Das Modell hatte seine
   * Gelegenheit.
   */
  async suggest(request: LlmRequest): Promise<(LlmSuggestion | null)[]> {
    const n = request.transactions.length
    const none = () => Array.from({ length: n }, () => null)
    if (n === 0) return []
    if (request.options.length === 0) return none()
    const optionIds = request.options.map((_, i) => optionId(i))
    const transactionIds = request.transactions.map((_, i) => transactionId(i))
    const body = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 200 + TOKENS_PER_TRANSACTION * n,
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
              antworten: {
                type: 'array',
                description: 'je Buchung genau eine Antwort',
                items: {
                  type: 'object',
                  properties: {
                    buchung: {
                      type: 'string',
                      enum: transactionIds,
                      description: 'id der Buchung',
                    },
                    option: {
                      type: 'string',
                      enum: optionIds,
                      description: 'id der gewählten Option',
                    },
                    confidence_pct: { type: 'integer', description: 'Konfidenz 0–100' },
                    reason: { type: 'string', description: 'Begründung in einem Satz' },
                  },
                  required: ['buchung', 'option', 'confidence_pct', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['antworten'],
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
    if (!content) return none()
    let parsed: unknown
    try {
      parsed = JSON.parse(unwrapJson(content))
    } catch {
      return none()
    }
    const answers = answersSchema.safeParse(parsed)
    if (!answers.success) return none()

    const result: (LlmSuggestion | null)[] = none()
    const seen = new Set<number>()
    for (const raw of answers.data.antworten) {
      const answer = answerSchema.safeParse(raw)
      if (!answer.success) continue
      const index = transactionIds.indexOf(answer.data.buchung)
      // Unbekannte Buchung oder doppelte Antwort: Es zählt die erste Antwort zu einer Buchung.
      if (index < 0 || seen.has(index)) continue
      seen.add(index)
      const option = request.options[optionIds.indexOf(answer.data.option)]
      const reason = answer.data.reason.replace(/\s+/g, ' ').trim()
      if (!option || !reason || !Number.isFinite(answer.data.confidence_pct)) continue
      result[index] = {
        kind: option.kind,
        potId: option.potId,
        confidencePct: Math.min(100, Math.max(0, Math.round(answer.data.confidence_pct))),
        reason,
      }
    }
    return result
  }
}
