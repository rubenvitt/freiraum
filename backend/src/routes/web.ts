import { readFileSync } from 'node:fs'
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

export function webRoutes(app: OpenAPIHono<AppEnv>): void {
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

  // Bis es ein Web-Frontend gibt (E6), führt die Startseite zur Registrierung.
  app.get('/', (c) => c.redirect('/registrieren', 302))
}
