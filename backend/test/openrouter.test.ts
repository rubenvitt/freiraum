import { describe, expect, it } from 'vitest'
import type { LlmRequest } from '../src/categorize/llm.js'
import { OpenRouterCategorizer } from '../src/categorize/openrouter.js'
import type { LlmConfig } from '../src/config.js'

// Alle Namen und Beträge sind erfunden.

const config: LlmConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test-nicht-echt',
  model: 'beispiel/modell',
  timeoutMs: 200,
  zeroDataRetention: true,
}

const request: LlmRequest = {
  transactions: [
    {
      bookingDate: '2026-11-02',
      amountCents: -4_250,
      counterpartyName: 'Supermarkt Beispiel',
      purpose: 'Einkauf 2026-11-02',
    },
    {
      bookingDate: '2026-11-01',
      amountCents: 300_000,
      counterpartyName: 'Arbeitgeberin Beispiel',
      purpose: null,
    },
  ],
  options: [
    { kind: 'einnahme', potId: null, label: 'Einnahme (Noch ohne Aufgabe)', groupName: null },
    { kind: 'umbuchung', potId: null, label: 'Umbuchung', groupName: null },
    {
      kind: 'topf',
      potId: '11111111-1111-4111-8111-111111111111',
      label: 'Lebensmittel',
      groupName: 'Alltag',
    },
  ],
}

type Call = { url: string; init: RequestInit; body: any }

function adapter(
  answer: (call: Call) => Response | Promise<Response>,
  extra: Partial<LlmConfig> = {},
) {
  const calls: Call[] = []
  const categorizer = new OpenRouterCategorizer(
    { ...config, ...extra },
    {
      fetch: async (url, init = {}) => {
        const call = { url: String(url), init, body: JSON.parse(String(init.body)) }
        calls.push(call)
        return answer(call)
      },
    },
  )
  return { categorizer, calls }
}

const reply = (content: unknown) =>
  Response.json({
    choices: [
      { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
    ],
  })

const answers = (...items: unknown[]) => reply({ antworten: items })

const groceries = {
  kind: 'topf',
  potId: '11111111-1111-4111-8111-111111111111',
  confidencePct: 82,
  reason: 'Supermarkt, also Lebensmittel.',
}

describe('OpenRouter-Adapter', () => {
  it('fragt mehrere Buchungen mit JSON-Schema und Datenschutz-Vorgaben in einer Anfrage', async () => {
    const { categorizer, calls } = adapter(() =>
      answers(
        // Reihenfolge der Antworten egal, Zuordnung über die Kennung.
        { buchung: 'b2', option: 'o1', confidence_pct: 95, reason: 'Gehalt.' },
        {
          buchung: 'b1',
          option: 'o3',
          confidence_pct: 82,
          reason: '  Supermarkt,\n also Lebensmittel. ',
        },
      ),
    )
    expect(await categorizer.suggest(request)).toEqual([
      groceries,
      { kind: 'einnahme', potId: null, confidencePct: 95, reason: 'Gehalt.' },
    ])
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer sk-test-nicht-echt')
    expect(call?.body).toMatchObject({
      model: 'beispiel/modell',
      temperature: 0,
      provider: { require_parameters: true, data_collection: 'deny', zdr: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          strict: true,
          schema: {
            required: ['antworten'],
            properties: {
              antworten: {
                type: 'array',
                items: {
                  properties: {
                    buchung: { enum: ['b1', 'b2'] },
                    option: { enum: ['o1', 'o2', 'o3'] },
                  },
                },
              },
            },
          },
        },
      },
    })
    // Platz für die Antworten aller Buchungen.
    expect(call?.body.max_tokens).toBeGreaterThanOrEqual(2 * 100)
    const user = JSON.parse(call?.body.messages[1].content)
    expect(user).toEqual({
      buchungen: [
        {
          id: 'b1',
          datum: '2026-11-02',
          betrag: '-42,50 EUR',
          gegenpartei: 'Supermarkt Beispiel',
          verwendungszweck: 'Einkauf 2026-11-02',
        },
        {
          id: 'b2',
          datum: '2026-11-01',
          betrag: '3000,00 EUR',
          gegenpartei: 'Arbeitgeberin Beispiel',
          verwendungszweck: null,
        },
      ],
      optionen: [
        { id: 'o1', ziel: 'Einnahme (Noch ohne Aufgabe)' },
        { id: 'o2', ziel: 'Umbuchung' },
        { id: 'o3', ziel: 'Lebensmittel (Alltag)' },
      ],
    })
    // Pot-IDs verlassen den Server nicht.
    expect(JSON.stringify(call?.body)).not.toContain('11111111')
  })

  it('lässt zdr weg, wenn abgeschaltet, und schickt anderen Schnittstellen kein provider', async () => {
    const ok = () => answers({ buchung: 'b1', option: 'o1', confidence_pct: 50, reason: 'Gehalt.' })
    const off = adapter(ok, { zeroDataRetention: false })
    await off.categorizer.suggest(request)
    expect(off.calls[0]?.body.provider).toEqual({
      require_parameters: true,
      data_collection: 'deny',
    })
    const local = adapter(ok, { baseUrl: 'http://ollama.lan:11434/v1' })
    await local.categorizer.suggest(request)
    expect(local.calls[0]?.url).toBe('http://ollama.lan:11434/v1/chat/completions')
    expect(local.calls[0]?.body.provider).toBeUndefined()
  })

  it('begrenzt die Konfidenz und liest JSON auch aus einem Codeblock', async () => {
    const { categorizer } = adapter(() =>
      reply(
        '```json\n{"antworten":[{"buchung":"b1","option":"o2","confidence_pct":140.4,"reason":"Sparkonto."}]}\n```',
      ),
    )
    expect(await categorizer.suggest(request)).toEqual([
      { kind: 'umbuchung', potId: null, confidencePct: 100, reason: 'Sparkonto.' },
      null,
    ])
  })

  it('verwirft einzelne unbrauchbare Antworten und behält die übrigen', async () => {
    const { categorizer } = adapter(() =>
      answers(
        {
          buchung: 'b1',
          option: 'o3',
          confidence_pct: 82,
          reason: 'Supermarkt, also Lebensmittel.',
        },
        // doppelt: die erste zählt
        { buchung: 'b1', option: 'o1', confidence_pct: 99, reason: 'Anders.' },
        { buchung: 'b9', option: 'o1', confidence_pct: 80, reason: 'Unbekannte Buchung.' },
        { buchung: 'b2', option: 'o9', confidence_pct: 80, reason: 'Erfundene Option.' },
        { buchung: 'b2' },
        'kein Objekt',
      ),
    )
    expect(await categorizer.suggest(request)).toEqual([groceries, null])
  })

  it('liefert lauter null bei unbrauchbaren Antworten', async () => {
    const replies = [
      answers({ buchung: 'b1', option: 'o1', confidence_pct: 80, reason: '   ' }),
      reply({ option: 'o1', confidence_pct: 80, reason: 'Ohne Array.' }),
      reply({ antworten: 'kein Array' }),
      reply('kein JSON'),
      Response.json({ choices: [] }),
      Response.json({ choices: [{ message: { content: null } }] }),
      new Response('nicht einmal JSON'),
    ]
    for (const answer of replies) {
      const { categorizer } = adapter(() => answer)
      expect(await categorizer.suggest(request)).toEqual([null, null])
    }
  })

  it('wirft bei HTTP-Fehlern und Zeitüberschreitung', async () => {
    const failing = adapter(() => new Response('{"error":"zu viele Anfragen"}', { status: 429 }))
    await expect(failing.categorizer.suggest(request)).rejects.toThrow('HTTP 429')

    const slow = adapter(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    await expect(slow.categorizer.suggest(request)).rejects.toThrow('innerhalb von 200 ms')

    const offline = adapter(() => {
      throw new TypeError('fetch failed')
    })
    await expect(offline.categorizer.suggest(request)).rejects.toThrow('nicht erreichbar')
  })

  it('fragt ohne Optionen oder Buchungen gar nicht erst', async () => {
    const { categorizer, calls } = adapter(() => reply({}))
    expect(await categorizer.suggest({ ...request, options: [] })).toEqual([null, null])
    expect(await categorizer.suggest({ ...request, transactions: [] })).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
