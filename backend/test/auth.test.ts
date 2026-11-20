import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashToken } from '../src/auth/tokens.js'
import { ORIGIN, setupTestApp } from './helpers/app.js'
import { SoftAuthenticator } from './helpers/authenticator.js'

const { db, auth, request, reset } = setupTestApp()

afterAll(() => db.end())
beforeEach(() => reset())
afterEach(() => vi.restoreAllMocks())

/** Fängt console.error ab und liefert die protokollierten Zeilen. */
function captureErrors() {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return lines
}

type Json = Record<string, any>
const body = async (res: Response): Promise<Json> => (await res.json()) as Json

/** Person anlegen, einladen und den ersten Passkey registrieren. */
async function enroll(name: string, authenticator = new SoftAuthenticator(ORIGIN)) {
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
  const session = await body(res)
  return { person, authenticator, session, invitationToken }
}

async function login(authenticator: SoftAuthenticator) {
  const start = await body(await request('POST', '/v1/auth/login/options'))
  return request('POST', '/v1/auth/login/verify', {
    challengeId: start.challengeId,
    credential: authenticator.get(start.options as any),
  })
}

describe('Registrierung per Einladung', () => {
  it('registriert einen Passkey und liefert eine Sitzung', async () => {
    const { person, session } = await enroll('Person A')
    expect(session.token).toMatch(/^frs_/)
    expect(session.person).toMatchObject({ id: person.id, displayName: 'Person A' })

    const me = await request('GET', '/v1/me', undefined, session.token)
    expect(me.status).toBe(200)
    expect(await body(me)).toMatchObject({ id: person.id, displayName: 'Person A' })
  })

  it('liefert Optionen mit Pflicht zu auffindbarem Passkey und Nutzerverifikation', async () => {
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    const res = await request('POST', '/v1/auth/registration/options', { invitationToken: token })
    const { options } = await body(res)
    expect(options.rp).toEqual({ id: 'freiraum.test', name: 'Freiraum Test' })
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.user.name).toBe('Person A')
  })

  it('akzeptiert eine Einladung nur einmal', async () => {
    const { invitationToken } = await enroll('Person A')
    const res = await request('POST', '/v1/auth/registration/options', { invitationToken })
    expect(res.status).toBe(410)
    expect((await body(res)).error.code).toBe('einladung_ungueltig')
  })

  it('lehnt abgelaufene und unbekannte Einladungen ab', async () => {
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    await db`update invitations set expires_at = now() - interval '1 minute'`
    expect(
      (await request('POST', '/v1/auth/registration/options', { invitationToken: token })).status,
    ).toBe(410)
    expect(
      (
        await request('POST', '/v1/auth/registration/options', {
          invitationToken: 'fre_gibtesnicht0000',
        })
      ).status,
    ).toBe(410)
  })

  it('bindet die Challenge an die Einladung', async () => {
    const a = await auth.createPerson('Person A')
    const b = await auth.createPerson('Person B')
    const invA = await auth.createInvitation(a.id)
    const invB = await auth.createInvitation(b.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: invA.token }),
    )
    const res = await request('POST', '/v1/auth/registration/verify', {
      challengeId: start.challengeId,
      invitationToken: invB.token,
      credential: new SoftAuthenticator(ORIGIN).create(start.options as any),
    })
    expect(res.status).toBe(410)
    expect(await db`select * from passkeys`).toHaveLength(0)
  })

  it('lehnt eine fremde Origin ab', async () => {
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    const res = await request('POST', '/v1/auth/registration/verify', {
      challengeId: start.challengeId,
      invitationToken: token,
      credential: new SoftAuthenticator('https://boese.example').create(start.options as any),
    })
    expect(res.status).toBe(401)
    expect((await body(res)).error.code).toBe('passkey_abgelehnt')
  })

  it('protokolliert den Grund einer abgelehnten Registrierung', async () => {
    const lines = captureErrors()
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    await request('POST', '/v1/auth/registration/verify', {
      challengeId: start.challengeId,
      invitationToken: token,
      credential: new SoftAuthenticator('https://boese.example').create(start.options as any),
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Passkey abgelehnt \(Registrierung\): .*boese\.example/)
    expect(lines[0]).not.toContain(token)
  })

  it('verlangt Nutzerverifikation (Face ID, Touch ID, Code)', async () => {
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    const res = await request('POST', '/v1/auth/registration/verify', {
      challengeId: start.challengeId,
      invitationToken: token,
      credential: new SoftAuthenticator(ORIGIN, { userVerified: false }).create(
        start.options as any,
      ),
    })
    expect(res.status).toBe(401)
  })

  it('verbraucht die Challenge auch bei fehlgeschlagener Prüfung', async () => {
    const person = await auth.createPerson('Person A')
    const { token } = await auth.createInvitation(person.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    const bad = new SoftAuthenticator('https://boese.example').create(start.options as any)
    const good = new SoftAuthenticator(ORIGIN).create(start.options as any)
    const verify = (credential: unknown) =>
      request('POST', '/v1/auth/registration/verify', {
        challengeId: start.challengeId,
        invitationToken: token,
        credential,
      })
    expect((await verify(bad)).status).toBe(401)
    const retry = await verify(good)
    expect(retry.status).toBe(400)
    expect((await body(retry)).error.code).toBe('challenge_ungueltig')
  })

  it('erlaubt mit neuer Einladung einen weiteren Passkey, aber nicht denselben doppelt', async () => {
    const { person, authenticator } = await enroll('Person A')
    const { token } = await auth.createInvitation(person.id)
    const start = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    expect(start.options.excludeCredentials).toEqual([
      expect.objectContaining({ id: authenticator.id }),
    ])

    const duplicate = await request('POST', '/v1/auth/registration/verify', {
      challengeId: start.challengeId,
      invitationToken: token,
      credential: authenticator.create(start.options as any),
    })
    expect(duplicate.status).toBe(409)

    // Die Einladung ist noch nicht verbraucht: zweites Gerät klappt.
    const again = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    const second = await request('POST', '/v1/auth/registration/verify', {
      challengeId: again.challengeId,
      invitationToken: token,
      credential: new SoftAuthenticator(ORIGIN).create(again.options as any),
    })
    expect(second.status).toBe(201)
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from passkeys where person_id = ${person.id}
    `
    expect(row?.n).toBe(2)
  })
})

describe('Anmeldung mit Passkey', () => {
  it('meldet zwei Personen getrennt an', async () => {
    const a = await enroll('Person A')
    const b = await enroll('Person B')

    const resA = await login(a.authenticator)
    const resB = await login(b.authenticator)
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    const sessionA = await body(resA)
    const sessionB = await body(resB)

    const meA = await body(await request('GET', '/v1/me', undefined, sessionA.token))
    const meB = await body(await request('GET', '/v1/me', undefined, sessionB.token))
    expect(meA.id).toBe(a.person.id)
    expect(meB.id).toBe(b.person.id)
    expect(meA.id).not.toBe(meB.id)
  })

  it('nutzt auffindbare Passkeys (keine allowCredentials)', async () => {
    const { options } = await body(await request('POST', '/v1/auth/login/options'))
    expect(options.rpId).toBe('freiraum.test')
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials ?? []).toEqual([])
  })

  it('lehnt unbekannte Passkeys ab', async () => {
    const lines = captureErrors()
    const res = await login(new SoftAuthenticator(ORIGIN))
    expect(res.status).toBe(401)
    expect(lines).toEqual([expect.stringMatching(/^Passkey abgelehnt \(Anmeldung\): .*unbekannt/)])
  })

  it('lehnt einen Passkey ab, der sich als andere Person ausgibt', async () => {
    const a = await enroll('Person A')
    const b = await enroll('Person B')
    a.authenticator.userHandle = b.authenticator.userHandle
    const lines = captureErrors()
    expect((await login(a.authenticator)).status).toBe(401)
    expect(lines).toEqual([
      expect.stringMatching(/^Passkey abgelehnt \(Anmeldung\): .*User-Handle/),
    ])
  })

  it('protokolliert den Grund einer abgelehnten Signaturprüfung', async () => {
    const { authenticator } = await enroll('Person A')
    const lines = captureErrors()
    const start = await body(await request('POST', '/v1/auth/login/options'))
    const credential = authenticator.get(start.options as any)
    const clientData = JSON.parse(
      Buffer.from(credential.response.clientDataJSON, 'base64url').toString(),
    )
    clientData.origin = 'https://boese.example'
    credential.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString(
      'base64url',
    )
    const res = await request('POST', '/v1/auth/login/verify', {
      challengeId: start.challengeId,
      credential,
    })
    expect(res.status).toBe(401)
    expect(lines).toEqual([
      expect.stringMatching(/^Passkey abgelehnt \(Anmeldung\): .*boese\.example/),
    ])
  })

  it('akzeptiert keine Registrierungs-Challenge für die Anmeldung', async () => {
    const { authenticator, person } = await enroll('Person A')
    const { token } = await auth.createInvitation(person.id)
    const reg = await body(
      await request('POST', '/v1/auth/registration/options', { invitationToken: token }),
    )
    const res = await request('POST', '/v1/auth/login/verify', {
      challengeId: reg.challengeId,
      credential: authenticator.get({ challenge: reg.options.challenge, rpId: 'freiraum.test' }),
    })
    expect(res.status).toBe(400)
  })

  it('aktualisiert Nutzungszeitpunkt des Passkeys', async () => {
    const { authenticator } = await enroll('Person A')
    await login(authenticator)
    const [row] = await db<{ last_used_at: Date | null }[]>`select last_used_at from passkeys`
    expect(row?.last_used_at).toBeInstanceOf(Date)
  })
})

describe('Sitzungen', () => {
  it('verlangt ein Token', async () => {
    const res = await request('GET', '/v1/me')
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({
      error: { code: 'nicht_angemeldet', message: 'Bitte melde dich an.' },
    })
    expect((await request('GET', '/v1/me', undefined, 'frs_falsch')).status).toBe(401)
  })

  it('speichert Tokens nur gehasht', async () => {
    const { session } = await enroll('Person A')
    const rows = await db<{ token_hash: Buffer }[]>`select token_hash from sessions`
    expect(rows).toHaveLength(1)
    expect(Buffer.compare(rows[0]!.token_hash, hashToken(session.token))).toBe(0)
    const invitations = await db`select * from invitations`
    expect(JSON.stringify(invitations)).not.toContain('fre_')
  })

  it('beendet die Sitzung beim Abmelden', async () => {
    const { session } = await enroll('Person A')
    expect((await request('POST', '/v1/auth/logout', undefined, session.token)).status).toBe(204)
    expect((await request('GET', '/v1/me', undefined, session.token)).status).toBe(401)
  })

  it('lehnt abgelaufene Sitzungen ab und räumt sie auf', async () => {
    const { session } = await enroll('Person A')
    await db`update sessions set expires_at = now() - interval '1 second'`
    expect((await request('GET', '/v1/me', undefined, session.token)).status).toBe(401)
    await auth.purgeExpired()
    expect(await db`select * from sessions`).toHaveLength(0)
  })

  it('verlängert die Sitzung bei Nutzung', async () => {
    const { session } = await enroll('Person A')
    await db`update sessions set expires_at = now() + interval '1 day'`
    await request('GET', '/v1/me', undefined, session.token)
    const [row] = await db<{ days: number }[]>`
      select extract(day from expires_at - now())::int as days from sessions
    `
    expect(row?.days).toBeGreaterThanOrEqual(89)
  })
})

describe('Fehlerantworten', () => {
  it('meldet Validierungsfehler auf Deutsch', async () => {
    const res = await request('POST', '/v1/auth/login/verify', { challengeId: 'keine-uuid' })
    expect(res.status).toBe(400)
    const { error } = await body(res)
    expect(error.code).toBe('ungueltige_anfrage')
    expect(error.message).toMatch(/^Die Anfrage ist ungültig/)
  })

  it('meldet unbekannte Adressen', async () => {
    const res = await request('GET', '/v1/gibtesnicht')
    expect(res.status).toBe(404)
    expect((await body(res)).error.code).toBe('nicht_gefunden')
  })
})

describe('Signaturprüfung', () => {
  it('lehnt eine manipulierte Signatur ab', async () => {
    const { authenticator } = await enroll('Person A')
    const start = await body(await request('POST', '/v1/auth/login/options'))
    const credential = authenticator.get(start.options as any)
    const sig = Buffer.from(credential.response.signature, 'base64url')
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0xff
    credential.response.signature = sig.toString('base64url')
    const res = await request('POST', '/v1/auth/login/verify', {
      challengeId: start.challengeId,
      credential,
    })
    expect(res.status).toBe(401)
  })
})
