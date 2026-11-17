import { describe, expect, it } from 'vitest'
import { addDays, addMonths, daysBetween, isIsoDate } from '../src/ledger/dates.js'
import { importKeys } from '../src/ledger/import-key.js'
import {
  counterpartyKey,
  detectRecurring,
  type HistoryTransaction,
} from '../src/ledger/recurring.js'

// Alle Namen, Beträge und IBANs sind erfunden.

let seq = 0
function tx(
  bookingDate: string,
  amountCents: number,
  counterpartyName: string | null,
  extra: Partial<HistoryTransaction> = {},
): HistoryTransaction {
  seq += 1
  return {
    id: `t${String(seq).padStart(4, '0')}`,
    bookingDate,
    amountCents,
    counterpartyName,
    counterpartyIban: null,
    purpose: null,
    ...extra,
  }
}

describe('Kalendertage', () => {
  it('rechnet Monate mit Kürzung aufs Monatsende', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
    expect(addMonths('2026-03-31', 12)).toBe('2027-03-31')
  })

  it('zählt Tage über die Zeitumstellung hinweg', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06')
  })

  it('erkennt ungültige Daten', () => {
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('17.11.2026')).toBe(false)
  })
})

describe('Idempotenzschlüssel', () => {
  const account = '00000000-0000-4000-8000-000000000001'

  it('nimmt die Quell-ID, wenn vorhanden', () => {
    expect(
      importKeys(account, [{ sourceId: ' ABC-1 ', bookingDate: '2026-11-03', amountCents: -100 }]),
    ).toEqual(['id:ABC-1'])
  })

  it('hasht sonst Konto, Tag, Betrag und Verwendungszweck', () => {
    const [a] = importKeys(account, [
      { bookingDate: '2026-11-03', amountCents: -450, purpose: 'Kartenzahlung\n Café  Beispiel' },
    ])
    const [b] = importKeys(account, [
      { bookingDate: '2026-11-03', amountCents: -450, purpose: 'Kartenzahlung Café Beispiel' },
    ])
    const [other] = importKeys('00000000-0000-4000-8000-000000000002', [
      { bookingDate: '2026-11-03', amountCents: -450, purpose: 'Kartenzahlung Café Beispiel' },
    ])
    expect(a).toMatch(/^hash:[0-9a-f]{64}:0$/)
    expect(a).toBe(b)
    expect(other).not.toBe(a)
  })

  it('unterscheidet verschiedene Gegenparteien bei gleichem Betrag am selben Tag', () => {
    const base = { bookingDate: '2026-11-03', amountCents: -1_000 }
    const [a] = importKeys(account, [{ ...base, counterpartyName: 'Person X' }])
    const [b] = importKeys(account, [{ ...base, counterpartyName: 'Person Y' }])
    const [c] = importKeys(account, [{ ...base, counterpartyIban: 'DE02 1203 0000 0000 2020 51' }])
    expect(new Set([a, b, c]).size).toBe(3)
    expect(a).toMatch(/:0$/)
  })

  it('unterscheidet gleiche Buchungen am selben Tag über das Vorkommen', () => {
    const coffee = { bookingDate: '2026-11-03', amountCents: -450, purpose: 'Café' }
    const keys = importKeys(account, [coffee, { ...coffee, amountCents: -900 }, coffee])
    expect(keys[0]).toMatch(/:0$/)
    expect(keys[2]).toMatch(/:1$/)
    expect(keys[2]?.slice(0, -2)).toBe(keys[0]?.slice(0, -2))
    expect(new Set(keys).size).toBe(3)
  })
})

describe('Gegenpartei vereinheitlichen', () => {
  it('ignoriert Rechtsform, Groß-/Kleinschreibung, Ziffern und Umlaute', () => {
    expect(counterpartyKey('Musterstrom GmbH & Co. KG')).toBe('musterstrom')
    expect(counterpartyKey('MUSTERSTROM GMBH')).toBe('musterstrom')
    expect(counterpartyKey('Bäckerei Größe 4711')).toBe('baeckerei groesse')
    expect(counterpartyKey('Streamingdienst Europe S.a.r.l.')).toBe('streamingdienst')
  })
})

describe('Wiederkehrende Buchungen erkennen', () => {
  it('erkennt ein monatliches Abo trotz Wochenend-Verschiebung', () => {
    const series = detectRecurring(
      [
        tx('2026-07-01', -1299, 'Streamingdienst Europe S.a.r.l.'),
        tx('2026-08-03', -1299, 'STREAMINGDIENST EUROPE SARL'),
        tx('2026-09-01', -1299, 'Streamingdienst Europe S.a.r.l.'),
        tx('2026-10-01', -1299, 'Streamingdienst Europe S.a.r.l.'),
        tx('2026-11-02', -1299, 'Streamingdienst Europe S.a.r.l.'),
      ],
      '2026-11-17',
    )
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      counterparty: 'Streamingdienst Europe S.a.r.l.',
      direction: 'ausgang',
      cadence: 'monatlich',
      typicalAmountCents: -1299,
      minAmountCents: -1299,
      maxAmountCents: -1299,
      occurrences: 5,
      firstDate: '2026-07-01',
      lastDate: '2026-11-02',
      nextExpectedDate: '2026-12-02',
      state: 'aktiv',
    })
  })

  it('erkennt Gehalt mit schwankendem Betrag als Eingang', () => {
    const [salary] = detectRecurring(
      [
        tx('2026-08-28', 312_045, 'Arbeitgeber Beispiel AG'),
        tx('2026-09-30', 309_870, 'Arbeitgeber Beispiel AG'),
        tx('2026-10-30', 315_510, 'Arbeitgeber Beispiel AG'),
      ],
      '2026-11-17',
    )
    expect(salary).toMatchObject({
      direction: 'eingang',
      cadence: 'monatlich',
      typicalAmountCents: 312_045,
      minAmountCents: 309_870,
      maxAmountCents: 315_510,
    })
  })

  it('findet ein Abo zwischen Einzelkäufen beim selben Händler', () => {
    const series = detectRecurring(
      [
        tx('2026-08-05', -899, 'Versandhaus Beispiel'),
        tx('2026-08-17', -4_350, 'Versandhaus Beispiel'),
        tx('2026-09-05', -899, 'Versandhaus Beispiel'),
        tx('2026-09-06', -1_999, 'Versandhaus Beispiel'),
        tx('2026-10-05', -899, 'Versandhaus Beispiel'),
        tx('2026-10-22', -2_480, 'Versandhaus Beispiel'),
        tx('2026-11-05', -899, 'Versandhaus Beispiel'),
      ],
      '2026-11-17',
    )
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ cadence: 'monatlich', typicalAmountCents: -899 })
    expect(series[0]?.key).toMatch(/\|-899$/)
  })

  it('meldet unregelmäßige Einkäufe nicht als Serie', () => {
    const series = detectRecurring(
      [
        tx('2026-10-01', -2_340, 'Supermarkt Muster'),
        tx('2026-10-04', -5_610, 'Supermarkt Muster'),
        tx('2026-10-09', -1_220, 'Supermarkt Muster'),
        tx('2026-10-11', -3_380, 'Supermarkt Muster'),
        tx('2026-10-18', -4_470, 'Supermarkt Muster'),
        tx('2026-10-21', -990, 'Supermarkt Muster'),
      ],
      '2026-11-17',
    )
    expect(series).toEqual([])
  })

  it('braucht für monatlich mindestens drei Buchungen', () => {
    expect(
      detectRecurring(
        [tx('2026-09-15', -500, 'Verein Beispiel e.V.'), tx('2026-10-15', -500, 'Verein Beispiel')],
        '2026-11-17',
      ),
    ).toEqual([])
  })

  it('erkennt eine Jahresversicherung schon nach zwei Buchungen mit ähnlichem Betrag', () => {
    const [series] = detectRecurring(
      [
        tx('2025-01-02', -18_960, 'Versicherung Muster AG'),
        tx('2026-01-02', -19_420, 'Versicherung Muster AG'),
      ],
      '2026-11-17',
    )
    expect(series).toMatchObject({
      cadence: 'jaehrlich',
      nextExpectedDate: '2027-01-02',
      state: 'aktiv',
    })
  })

  it('lehnt zwei jährliche Buchungen mit stark abweichendem Betrag ab', () => {
    expect(
      detectRecurring(
        [
          tx('2025-03-10', -5_000, 'Möbelhaus Muster'),
          tx('2026-03-12', -42_000, 'Möbelhaus Muster'),
        ],
        '2026-11-17',
      ),
    ).toEqual([])
  })

  it('markiert ein gekündigtes Abo als beendet', () => {
    const [series] = detectRecurring(
      [
        tx('2026-04-10', -999, 'Musikdienst Beispiel'),
        tx('2026-05-10', -999, 'Musikdienst Beispiel'),
        tx('2026-06-10', -999, 'Musikdienst Beispiel'),
        tx('2026-07-10', -999, 'Musikdienst Beispiel'),
      ],
      '2026-11-17',
    )
    expect(series).toMatchObject({ nextExpectedDate: '2026-08-10', state: 'beendet' })
  })

  it('verkraftet einen ausgelassenen Monat', () => {
    const [series] = detectRecurring(
      [
        tx('2026-05-15', -3_000, 'Fitnessstudio Muster'),
        tx('2026-06-15', -3_000, 'Fitnessstudio Muster'),
        tx('2026-08-15', -3_000, 'Fitnessstudio Muster'),
        tx('2026-09-15', -3_000, 'Fitnessstudio Muster'),
        tx('2026-10-15', -3_000, 'Fitnessstudio Muster'),
      ],
      '2026-11-17',
    )
    expect(series).toMatchObject({ cadence: 'monatlich', occurrences: 5, state: 'aktiv' })
  })

  it('gruppiert ohne Namen nach IBAN und trennt Ein- und Ausgänge', () => {
    const iban = 'DE02120300000000202051'
    const series = detectRecurring(
      [
        tx('2026-08-01', -80_000, null, { counterpartyIban: iban }),
        tx('2026-09-01', -80_000, null, { counterpartyIban: iban }),
        tx('2026-10-01', -80_000, null, { counterpartyIban: iban }),
        tx('2026-10-20', 12_000, null, { counterpartyIban: iban }),
      ],
      '2026-11-17',
    )
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({ counterparty: iban, direction: 'ausgang', occurrences: 3 })
  })

  it('erkennt Serien ohne Gegenpartei am genauen Betrag (z. B. Sparplan)', () => {
    const series = detectRecurring(
      [
        tx('2026-08-02', -25_000, null),
        tx('2026-08-14', -7_310, null),
        tx('2026-09-02', -25_000, null),
        tx('2026-10-02', -25_000, null),
        tx('2026-10-19', -1_240, null),
        tx('2026-11-02', -25_000, null),
      ],
      '2026-11-17',
    )
    expect(series).toHaveLength(1)
    expect(series[0]).toMatchObject({
      counterparty: 'Ohne Gegenpartei',
      cadence: 'monatlich',
      typicalAmountCents: -25_000,
      occurrences: 4,
    })
  })

  it('erkennt wöchentliches Taschengeld', () => {
    const dates = ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']
    const [series] = detectRecurring(
      dates.map((d) => tx(d, -2_000, 'Kind Beispiel')),
      '2026-11-03',
    )
    expect(series).toMatchObject({ cadence: 'woechentlich', nextExpectedDate: '2026-11-06' })
  })
})
