import { afterAll, describe, expect, it } from 'vitest'
import { setupTestApp } from './helpers/app.js'

const { db, request } = setupTestApp()
afterAll(() => db.end())

const get = (path: string) => request('GET', path)

function expectStrictHeaders(res: Response) {
  const csp = res.headers.get('content-security-policy') ?? ''
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).not.toContain('unsafe-inline')
  expect(csp).not.toContain('unsafe-eval')
  expect(csp).not.toMatch(/https?:/)
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
}

describe('Registrierungsseite', () => {
  it('wird unter /registrieren mit strengen Sicherheits-Headern ausgeliefert', async () => {
    const res = await get('/registrieren')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expectStrictHeaders(res)
    const html = await res.text()
    expect(html).toContain('Passkey anlegen')
    expect(html).toContain('Anmelden testen')
  })

  it('führt von der Startseite zur Registrierung', async () => {
    const res = await get('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/registrieren')
  })

  it('enthält keine externen oder Inline-Skripte und keine Inline-Stile', async () => {
    const html = await (await get('/registrieren')).text()

    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/[^/]/)
      expect(body?.trim()).toBe('')
    }
    // Alle Verweise bleiben auf dem eigenen Server.
    for (const [, url] of html.matchAll(/\b(?:src|href)="([^"]*)"/gi)) {
      expect(url).toMatch(/^\/[^/]/)
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it('liefert Skript und Stil mit passendem Typ und denselben Headern', async () => {
    const html = await (await get('/registrieren')).text()
    const assets = [...html.matchAll(/\b(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!)
    expect(assets.sort()).toEqual(['/registrieren.css', '/registrieren.js'])

    const js = await get('/registrieren.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expectStrictHeaders(js)

    const css = await get('/registrieren.css')
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expectStrictHeaders(css)
  })

  it('lädt im Skript nichts nach und spricht nur die eigene API an', async () => {
    const js = await (await get('/registrieren.js')).text()
    expect(js).not.toMatch(/\bimport\s*[({'"*\w]/)
    expect(js).not.toMatch(/\b(eval|importScripts|Function)\s*\(/)
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)

    const calls = [...js.matchAll(/\b(?:api|fetch)\(\s*(['"`])([^'"`]*)\1/g)].map((m) => m[2])
    expect(calls.length).toBeGreaterThan(0)
    for (const path of calls) expect(path).toMatch(/^\/v1\//)
  })

  it('lässt API-Fehler weiter als JSON antworten', async () => {
    const res = await get('/gibt-es-nicht')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'nicht_gefunden' } })
  })
})
