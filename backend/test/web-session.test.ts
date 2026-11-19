import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ORIGIN, setupTestApp } from './helpers/app.js'
import { SoftAuthenticator } from './helpers/authenticator.js'

const { db, app, auth, request, reset, personWithSession } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

/** Person mit Passkey anlegen (per Einladung), Sitzung der Registrierung gleich beenden. */
async function enroll(name: string) {
  const authenticator = new SoftAuthenticator(ORIGIN)
  const person = await auth.createPerson(name)
  const { token: invitationToken } = await auth.createInvitation(person.id)
  const start = await body(
    await request('POST', '/v1/auth/registration/options', { invitationToken }),
  )
  const res = await request('POST', '/v1/auth/registration/verify', {
    challengeId: start.challengeId,
    invitationToken,
    credential: authenticator.create(start.options as any),
  })
  expect(res.status).toBe(201)
  return { person, authenticator }
}

async function webLogin(authenticator: SoftAuthenticator) {
  const start = await body(await request('POST', '/v1/auth/login/options'))
  return request('POST', '/v1/auth/login/verify-web', {
    challengeId: start.challengeId,
    credential: authenticator.get(start.options as any),
  })
}

/** Wert des Sitzungs-Cookies aus einer Antwort (`name=wert`). */
function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? ''
  const pair = header.split(';')[0] ?? ''
  expect(pair).toMatch(/^__Host-freiraum_session=frs_/)
  return pair
}

const withCookie = (
  method: string,
  path: string,
  cookie: string,
  extra: Record<string, string> = {},
  json?: unknown,
) =>
  app.request(path, {
    method,
    headers: {
      cookie,
      ...extra,
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })

async function loggedIn(name = 'Person A') {
  const { person, authenticator } = await enroll(name)
  const res = await webLogin(authenticator)
  return { person, res, cookie: cookieFrom(res) }
}

describe('Anmeldung im Browser per Cookie', () => {
  it('login/verify-web setzt den Cookie und liefert kein Token', async () => {
    const { res } = await loggedIn()
    expect(res.status).toBe(200)
    const data = await body(res)
    expect(data.person.displayName).toBe('Person A')
    expect(data.expiresAt).toEqual(expect.any(String))
    expect(data).not.toHaveProperty('token')
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^__Host-freiraum_session=frs_/)
    for (const part of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=7776000']) {
      expect(header).toContain(part)
    }
    expect(header).not.toMatch(/Domain=/i)
  })

  it('Cookie öffnet lesende Endpunkte', async () => {
    const { cookie, person } = await loggedIn()
    const me = await withCookie('GET', '/v1/me', cookie)
    expect(me.status).toBe(200)
    expect((await body(me)).id).toBe(person.id)
    expect((await withCookie('GET', '/v1/households', cookie)).status).toBe(200)
  })

  it('Cookie öffnet keine schreibenden Endpunkte, auch mit passendem Origin', async () => {
    const { cookie } = await loggedIn()
    const households = await body(await withCookie('GET', '/v1/households', cookie))
    const res = await withCookie(
      'POST',
      '/v1/accounts',
      cookie,
      { origin: ORIGIN },
      { householdId: households.items[0].id, name: 'Testkonto', source: 'manuell' },
    )
    expect(res.status).toBe(401)
    expect((await body(res)).error.code).toBe('nicht_angemeldet')
  })

  it('Logout per Cookie nur mit passendem Origin', async () => {
    const { cookie } = await loggedIn()
    expect((await withCookie('POST', '/v1/auth/logout', cookie)).status).toBe(401)
    expect(
      (await withCookie('POST', '/v1/auth/logout', cookie, { origin: 'https://evil.test' })).status,
    ).toBe(401)
    const res = await withCookie('POST', '/v1/auth/logout', cookie, { origin: ORIGIN })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await withCookie('GET', '/v1/me', cookie)).status).toBe(401)
  })

  it('Bearer hat Vorrang vor Cookie', async () => {
    const { cookie } = await loggedIn('Person A')
    const b = await personWithSession('Person B')
    const res = await withCookie('GET', '/v1/me', cookie, { authorization: `Bearer ${b.token}` })
    expect(res.status).toBe(200)
    expect((await body(res)).id).toBe(b.person.id)
  })

  it('GET /v1/me erneuert den Cookie nur bei Anmeldung per Cookie', async () => {
    const { cookie } = await loggedIn()
    const viaCookie = await withCookie('GET', '/v1/me', cookie)
    expect(viaCookie.headers.get('set-cookie')).toContain('Max-Age=7776000')
    const b = await personWithSession('Person B')
    const viaBearer = await request('GET', '/v1/me', undefined, b.token)
    expect(viaBearer.headers.get('set-cookie')).toBeNull()
  })

  it('andere Antworten setzen keinen Cookie', async () => {
    const { cookie } = await loggedIn()
    const res = await withCookie('GET', '/v1/households', cookie)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('abgelaufene Sitzung im Cookie ist nicht angemeldet', async () => {
    const { cookie } = await loggedIn()
    await db`update sessions set expires_at = now() - interval '1 minute'`
    const res = await withCookie('GET', '/v1/me', cookie)
    expect(res.status).toBe(401)
  })

  it('private Auswertung der anderen Person bleibt 404, auch per Cookie', async () => {
    const a = await personWithSession('Person A')
    const households = await body(await request('GET', '/v1/households', undefined, a.token))
    const privat = households.items.find((h: Json) => h.kind === 'privat')
    const { cookie } = await loggedIn('Person B')
    const res = await withCookie('GET', `/v1/households/${privat.id}/analytics/metrics`, cookie)
    expect(res.status).toBe(404)
  })
})
