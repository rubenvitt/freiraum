import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { clearSessionCookie, sessionCookie } from '../auth/cookie.js'
import { requireAuth, requireAuthOrWebLogout } from '../auth/middleware.js'
import type { IssuedSession, Person } from '../auth/service.js'
import {
  AuthenticationCredentialSchema,
  AuthenticationOptionsSchema,
  ChallengeId,
  ErrorSchema,
  PersonSchema,
  RegistrationCredentialSchema,
  RegistrationOptionsSchema,
  SessionSchema,
} from '../schemas.js'
import { authRead } from './common.js'

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const error = (description: string) => json(ErrorSchema, description)

const InvitationToken = z.string().min(10).max(200).openapi({
  description: 'Einmaliges Einladungs-Token (fre_…), erzeugt per Kommandozeile',
})

const RegistrationStart = z
  .object({ challengeId: ChallengeId, options: RegistrationOptionsSchema })
  .openapi('RegistrationStart')
const WebSession = z
  .object({
    expiresAt: z.iso.datetime(),
    person: PersonSchema,
  })
  .openapi('WebSession', {
    description: 'Sitzung im Browser: Das Token steht nur im HttpOnly-Cookie, nie im Body.',
  })

const LoginStart = z
  .object({ challengeId: ChallengeId, options: AuthenticationOptionsSchema })
  .openapi('LoginStart')

const registrationOptions = createRoute({
  method: 'post',
  path: '/v1/auth/registration/options',
  tags: ['Anmeldung'],
  summary: 'Passkey-Registrierung mit einer Einladung beginnen',
  request: {
    body: json(z.object({ invitationToken: InvitationToken }), 'Einladung'),
  },
  responses: {
    200: json(
      RegistrationStart,
      'Optionen für navigator.credentials.create() bzw. ASAuthorization',
    ),
    400: error('Ungültige Anfrage'),
    410: error('Einladung ungültig, abgelaufen oder verbraucht'),
  },
})

const registrationVerify = createRoute({
  method: 'post',
  path: '/v1/auth/registration/verify',
  tags: ['Anmeldung'],
  summary: 'Passkey-Registrierung abschließen und anmelden',
  request: {
    body: json(
      z.object({
        challengeId: ChallengeId,
        invitationToken: InvitationToken,
        credential: RegistrationCredentialSchema,
      }),
      'Antwort des Authenticators',
    ),
  },
  responses: {
    201: json(SessionSchema, 'Passkey gespeichert, Sitzung erstellt'),
    400: error('Ungültige Anfrage oder abgelaufene Challenge'),
    401: error('Passkey abgelehnt'),
    409: error('Passkey bereits registriert'),
    410: error('Einladung ungültig, abgelaufen oder verbraucht'),
  },
})

const loginOptions = createRoute({
  method: 'post',
  path: '/v1/auth/login/options',
  tags: ['Anmeldung'],
  summary: 'Anmeldung mit Passkey beginnen',
  responses: {
    200: json(LoginStart, 'Optionen für navigator.credentials.get() bzw. ASAuthorization'),
  },
})

const loginVerify = createRoute({
  method: 'post',
  path: '/v1/auth/login/verify',
  tags: ['Anmeldung'],
  summary: 'Anmeldung mit Passkey abschließen',
  request: {
    body: json(
      z.object({ challengeId: ChallengeId, credential: AuthenticationCredentialSchema }),
      'Antwort des Authenticators',
    ),
  },
  responses: {
    200: json(SessionSchema, 'Sitzung erstellt'),
    400: error('Ungültige Anfrage oder abgelaufene Challenge'),
    401: error('Passkey abgelehnt'),
  },
})

const loginVerifyWeb = createRoute({
  method: 'post',
  path: '/v1/auth/login/verify-web',
  tags: ['Anmeldung'],
  summary: 'Anmeldung mit Passkey im Browser abschließen (Sitzung als HttpOnly-Cookie)',
  description:
    'Wie /v1/auth/login/verify, aber das Token kommt nur als Cookie `__Host-freiraum_session` ' +
    '(Secure, HttpOnly, SameSite=Strict). Das Cookie gilt nur für lesende Anfragen und fürs Abmelden.',
  request: {
    body: json(
      z.object({ challengeId: ChallengeId, credential: AuthenticationCredentialSchema }),
      'Antwort des Authenticators',
    ),
  },
  responses: {
    200: json(WebSession, 'Sitzung erstellt, Cookie gesetzt'),
    400: error('Ungültige Anfrage oder abgelaufene Challenge'),
    401: error('Passkey abgelehnt'),
  },
})

const logout = createRoute({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['Anmeldung'],
  summary: 'Aktuelle Sitzung beenden',
  description:
    'Per Bearer-Token oder, im Browser, per Sitzungs-Cookie mit erlaubtem `Origin`. Löscht das Cookie.',
  security: authRead,
  middleware: [requireAuthOrWebLogout] as const,
  responses: {
    204: { description: 'Abgemeldet' },
    401: error('Nicht angemeldet'),
  },
})

const me = createRoute({
  method: 'get',
  path: '/v1/me',
  tags: ['Person'],
  summary: 'Angemeldete Person',
  security: authRead,
  middleware: [requireAuth] as const,
  responses: {
    200: json(PersonSchema, 'Angemeldete Person'),
    401: error('Nicht angemeldet'),
  },
})

const maxAge = (days: number) => days * 24 * 3600

const personJson = (p: Person) => ({ ...p, createdAt: p.createdAt.toISOString() })
const sessionJson = (s: IssuedSession) => ({
  token: s.token,
  expiresAt: s.expiresAt.toISOString(),
  person: personJson(s.person),
})

export function authRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(registrationOptions, async (c) => {
    const { invitationToken } = c.req.valid('json')
    const result = await c.var.auth.startRegistration(invitationToken)
    return c.json(result, 200)
  })

  app.openapi(registrationVerify, async (c) => {
    const body = c.req.valid('json')
    const session = await c.var.auth.finishRegistration({
      ...body,
      userAgent: c.req.header('user-agent'),
    })
    return c.json(sessionJson(session), 201)
  })

  app.openapi(loginOptions, async (c) => {
    const result = await c.var.auth.startLogin()
    return c.json(result, 200)
  })

  app.openapi(loginVerify, async (c) => {
    const body = c.req.valid('json')
    const session = await c.var.auth.finishLogin({
      ...body,
      userAgent: c.req.header('user-agent'),
    })
    return c.json(sessionJson(session), 200)
  })

  app.openapi(loginVerifyWeb, async (c) => {
    const body = c.req.valid('json')
    const session = await c.var.auth.finishLogin({
      ...body,
      userAgent: c.req.header('user-agent'),
    })
    c.header('set-cookie', sessionCookie(session.token, maxAge(c.var.config.sessionTtlDays)))
    return c.json(
      { expiresAt: session.expiresAt.toISOString(), person: personJson(session.person) },
      200,
    )
  })

  app.openapi(logout, async (c) => {
    await c.var.auth.revokeSession(c.var.session.id)
    if (c.var.session.via === 'cookie') c.header('set-cookie', clearSessionCookie())
    return c.body(null, 204)
  })

  app.openapi(me, (c) => {
    // Die Sitzung läuft gleitend weiter; das Cookie zieht hier nach (die Seite ruft /v1/me beim Laden).
    if (c.var.session.via === 'cookie') {
      c.header(
        'set-cookie',
        sessionCookie(c.var.session.token, maxAge(c.var.config.sessionTtlDays)),
      )
    }
    return c.json(personJson(c.var.session.person), 200)
  })
}
