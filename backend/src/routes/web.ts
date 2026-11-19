import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'

/**
 * Schlichte Browserseite zum Einlösen einer Einladung (Passkey anlegen) und zum Testen der
 * Anmeldung. Statische Dateien aus `backend/public/`, ohne Build-Schritt und ohne fremde Quellen.
 * Nicht Teil des OpenAPI-Vertrags.
 */
const PUBLIC_DIR = new URL('../../public/', import.meta.url)

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
].join('; ')

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': PAGE_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'publickey-credentials-create=(self), publickey-credentials-get=(self), camera=(), microphone=(), geolocation=()',
}

const ASSETS = [
  { path: '/registrieren', file: 'registrieren.html', type: 'text/html; charset=utf-8' },
  { path: '/registrieren.js', file: 'registrieren.js', type: 'text/javascript; charset=utf-8' },
  { path: '/registrieren.css', file: 'registrieren.css', type: 'text/css; charset=utf-8' },
] as const

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/**
 * Build der Web-Oberfläche (ADR 0007): `index.html` unter `/`, gehashte Dateien unter `/assets/`.
 * Gelesen wird einmal beim Start; eine Anfrage schlägt nur in dieser Liste nach und berührt nie
 * das Dateisystem.
 */
function webApp(app: OpenAPIHono<AppEnv>, dir: string): void {
  const index = readFileSync(join(dir, 'index.html'), 'utf8')
  const assets = new Map<string, { content: Buffer; type: string }>()
  const assetDir = join(dir, 'assets')
  let names: string[] = []
  try {
    names = readdirSync(assetDir)
  } catch {
    // ohne assets/ gibt es nur die Seite
  }
  for (const name of names) {
    const type = ASSET_TYPES[name.slice(name.lastIndexOf('.'))]
    const path = join(assetDir, name)
    if (!type || !statSync(path).isFile()) continue
    assets.set(name, { content: readFileSync(path), type })
  }

  app.get('/', (c) =>
    c.body(index, 200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    }),
  )
  app.get('/assets/:name', (c) => {
    const asset = assets.get(c.req.param('name'))
    if (!asset) return c.notFound()
    return c.body(new Uint8Array(asset.content), 200, {
      ...SECURITY_HEADERS,
      'content-type': asset.type,
      'cache-control': 'public, max-age=31536000, immutable',
    })
  })
}

export function webRoutes(app: OpenAPIHono<AppEnv>, webDistDir: string | null): void {
  for (const asset of ASSETS) {
    const content = readFileSync(new URL(asset.file, PUBLIC_DIR), 'utf8')
    app.get(asset.path, (c) =>
      c.body(content, 200, {
        ...SECURITY_HEADERS,
        'content-type': asset.type,
        'cache-control': asset.file.endsWith('.html') ? 'no-store' : 'no-cache',
      }),
    )
  }

  if (webDistDir) {
    webApp(app, webDistDir)
  } else {
    // Ohne Build der Web-Oberfläche (Tests, Entwicklung) führt die Startseite zur Registrierung.
    app.get('/', (c) => c.redirect('/registrieren', 302))
  }
}
