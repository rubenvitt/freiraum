import { describe, expect, it } from 'vitest'
import { MINUS, money, points, ratio } from './money'

const NB = ' '

describe('money', () => {
  it('formatiert wie die Mac-App', () => {
    expect(money(21500)).toBe(`215${NB}€`)
    expect(money(3418)).toBe(`34,18${NB}€`)
    expect(money(-3418)).toBe(`${MINUS}34,18${NB}€`)
    expect(money(139000)).toBe(`1.390${NB}€`)
    expect(money(123456789)).toBe(`1.234.567,89${NB}€`)
    expect(money(21500, { exact: true })).toBe(`215,00${NB}€`)
    expect(money(500, { sign: true })).toBe(`+5${NB}€`)
    expect(money(5, { sign: true })).toBe(`+0,05${NB}€`)
    expect(money(0)).toBe(`0${NB}€`)
    expect(MINUS).toBe('−')
  })
})

describe('ratio und points', () => {
  it('Anteile als Text (wie RatioText)', () => {
    expect(ratio(2834)).toBe(`28${NB}%`)
    expect(ratio(2850)).toBe(`29${NB}%`)
    expect(ratio(950)).toBe(`9,5${NB}%`)
    expect(ratio(50)).toBe(`0,5${NB}%`)
    expect(ratio(1000)).toBe(`10${NB}%`)
    expect(ratio(-1200)).toBe(`${MINUS}12${NB}%`)
    expect(ratio(null)).toBe('–')
    expect(points(300)).toBe('+3 Punkte')
    expect(points(100)).toBe('+1 Punkt')
    expect(points(-100)).toBe(`${MINUS}1 Punkt`)
    expect(points(-300)).toBe(`${MINUS}3 Punkte`)
    expect(points(20)).toBe('gleich')
    expect(points(0)).toBe('gleich')
  })
})
