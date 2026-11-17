import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from '../app.js'
import { requireAuth } from '../auth/middleware.js'
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

const logout = createRoute({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['Anmeldung'],
  summary: 'Aktuelle Sitzung beenden',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
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
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: json(PersonSchema, 'Angemeldete Person'),
    401: error('Nicht angemeldet'),
  },
})

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

  app.openapi(logout, async (c) => {
    await c.var.auth.revokeSession(c.var.session.id)
    return c.body(null, 204)
  })

  app.openapi(me, (c) => c.json(personJson(c.var.session.person), 200))
}
