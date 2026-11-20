import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { setupTestApp, testConfig } from './helpers/app.js'

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
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    expectStrictHeaders(res)
    const html = await res.text()
    expect(html).toContain('Passkey anlegen')
    expect(html).toContain('Anmelden testen')
  })

  it('verweist nach dem Anlegen auf die Auswertung unter /', async () => {
    const html = await (await get('/registrieren')).text()
    expect(html).toMatch(/<p id="weiter"[^>]*hidden[^>]*>\s*<a href="\/">Zur Auswertung<\/a>/)
    const js = await (await get('/registrieren.js')).text()
    expect(js).toContain('ui.weiter.hidden = false')
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
      expect(url).toMatch(/^\/(?:[^/]|$)/)
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

// Vor dem Server sitzt Cloudflare. Rocket Loader schreibt <script>-Tags um und lädt sie über ein
// eigenes Skript nach, das die CSP blockiert: Dann läuft kein JavaScript der Seiten.
describe('Cloudflare', () => {
  it('Registrierung: jedes Skript ist von Rocket Loader ausgenommen', async () => {
    const html = await (await get('/registrieren')).text()
    const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag).toContain('data-cfasync="false"')
  })

  it('Registrierung: Skript und Stil verbieten Umschreiben', async () => {
    for (const path of ['/registrieren.js', '/registrieren.css']) {
      expect((await get(path)).headers.get('cache-control')).toContain('no-transform')
    }
  })
})

describe('Web-Oberfläche', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freiraum-web-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><title>Freiraum</title><script type="module" src="/assets/app-abc123.js"></script>',
  )
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("x")')
  writeFileSync(join(dir, 'assets', 'app-abc123.css'), 'body{}')
  const { app: webApp } = createApp({ db, config: { ...testConfig, webDistDir: dir } })
  const getWeb = (path: string) => webApp.request(path)

  it('/ liefert index.html mit strengen Headern', async () => {
    const res = await getWeb('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    expectStrictHeaders(res)
    expect(await res.text()).toContain('<title>Freiraum</title>')
  })

  it('/ nimmt jedes Skript des Builds von Rocket Loader aus', async () => {
    const html = await (await getWeb('/')).text()
    expect(html).toContain(
      '<script data-cfasync="false" type="module" src="/assets/app-abc123.js">',
    )
  })

  it('/assets liefert gelistete Dateien unveränderlich', async () => {
    const js = await getWeb('/assets/app-abc123.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable, no-transform',
    )
    expectStrictHeaders(js)
    const css = await getWeb('/assets/app-abc123.css')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('/assets lehnt Unbekanntes und Pfad-Tricks ab', async () => {
    for (const path of [
      '/assets/fehlt.js',
      '/assets/../index.html',
      '/assets/%2e%2e%2findex.html',
      '/assets/..%2f..%2fpackage.json',
      '/assets/',
    ]) {
      const res = await getWeb(path)
      expect(res.status, path).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('nicht_gefunden')
    }
  })

  it('/registrieren bleibt erreichbar', async () => {
    expect((await getWeb('/registrieren')).status).toBe(200)
  })
})
