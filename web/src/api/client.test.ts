import { describe, expect, it } from 'vitest'
import { ApiError, unwrap } from './client'

const response = (status: number) => new Response(null, { status })

describe('unwrap', () => {
  it('liefert die Daten einer erfolgreichen Antwort', () => {
    expect(unwrap({ data: { id: 'x' }, response: response(200) })).toEqual({ id: 'x' })
  })

  it('wirft die Meldung des Servers', () => {
    const run = () =>
      unwrap({
        error: { error: { code: 'nicht_angemeldet', message: 'Bitte melde dich an.' } },
        response: response(401),
      })
    expect(run).toThrow(ApiError)
    expect(run).toThrow('Bitte melde dich an.')
    try {
      run()
    } catch (e) {
      expect((e as ApiError).status).toBe(401)
      expect((e as ApiError).code).toBe('nicht_angemeldet')
    }
  })

  it('hat eine Meldung, auch wenn der Server keine schickt', () => {
    expect(() => unwrap({ response: response(502) })).toThrow('Der Server antwortet mit 502.')
  })
})
