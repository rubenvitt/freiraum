import { randomBytes } from 'node:crypto'
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { TransactionSql } from 'postgres'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { ApiError } from '../errors.js'
import { hashToken, newToken } from './tokens.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

export interface Person {
  id: string
  displayName: string
  createdAt: Date
}

export interface IssuedSession {
  token: string
  expiresAt: Date
  person: Person
}

interface PersonRow {
  id: string
  display_name: string
  webauthn_user_id: string
  created_at: Date
}

function toPerson(row: PersonRow): Person {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at }
}

const invalidInvitation = () =>
  new ApiError(
    410,
    'einladung_ungueltig',
    'Die Einladung ist ungültig, abgelaufen oder verbraucht.',
  )
const invalidChallenge = () =>
  new ApiError(
    400,
    'challenge_ungueltig',
    'Die Anmeldeanfrage ist abgelaufen oder unbekannt. Bitte neu starten.',
  )
const passkeyRejected = () =>
  new ApiError(401, 'passkey_abgelehnt', 'Der Passkey konnte nicht bestätigt werden.')

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  // --- Verwaltung (nur über die Kommandozeile) ---------------------------------

  /** Legt eine Person an. Es gibt kein öffentliches Sign-up. */
  async createPerson(displayName: string): Promise<Person> {
    const [row] = await this.db<PersonRow[]>`
      insert into persons (display_name, webauthn_user_id)
      values (${displayName.trim()}, ${randomBytes(32).toString('base64url')})
      returning *
    `
    if (!row) throw new Error('Person konnte nicht angelegt werden')
    return toPerson(row)
  }

  /** Einladung für eine Person, z. B. für den ersten oder einen weiteren Passkey. */
  async createInvitation(personId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken('fre')
    const expiresAt = new Date(Date.now() + this.config.invitationTtlHours * 3600 * 1000)
    await this.db`
      insert into invitations (person_id, token_hash, expires_at)
      values (${personId}, ${hashToken(token)}, ${expiresAt})
    `
    return { token, expiresAt }
  }

  async listPersons(): Promise<(Person & { passkeys: number })[]> {
    const rows = await this.db<(PersonRow & { passkeys: number })[]>`
      select p.*, (select count(*)::int from passkeys k where k.person_id = p.id) as passkeys
      from persons p order by p.created_at
    `
    return rows.map((r) => ({ ...toPerson(r), passkeys: r.passkeys }))
  }

  // --- Registrierung eines Passkeys per Einladung ------------------------------

  async startRegistration(
    invitationToken: string,
  ): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const [row] = await this.db<(PersonRow & { invitation_id: string })[]>`
      select p.*, i.id as invitation_id
      from invitations i join persons p on p.id = i.person_id
      where i.token_hash = ${hashToken(invitationToken)}
        and i.used_at is null and i.expires_at > now()
    `
    if (!row) throw invalidInvitation()

    const existing = await this.db<{ id: string; transports: string[] }[]>`
      select id, transports from passkeys where person_id = ${row.id}
    `
    const options = await generateRegistrationOptions({
      rpName: this.config.webauthn.rpName,
      rpID: this.config.webauthn.rpId,
      userName: row.display_name,
      userDisplayName: row.display_name,
      userID: Buffer.from(row.webauthn_user_id, 'base64url'),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    const challengeId = await this.storeChallenge(
      'registration',
      options.challenge,
      row.invitation_id,
    )
    return { challengeId, options }
  }

  async finishRegistration(input: {
    challengeId: string
    invitationToken: string
    credential: RegistrationResponseJSON
    userAgent?: string | undefined
  }): Promise<IssuedSession> {
    // Außerhalb der Transaktion verbrauchen, damit die Challenge auch bei Fehlschlag weg ist.
    const challenge = await this.consumeChallenge(input.challengeId, 'registration')
    return this.db.begin(async (tx) => {
      const [invitation] = await tx<{ id: string; person_id: string }[]>`
        select id, person_id from invitations
        where id = ${challenge.invitation_id}
          and token_hash = ${hashToken(input.invitationToken)}
          and used_at is null and expires_at > now()
        for update
      `
      if (!invitation) throw invalidInvitation()

      const verification = await verifyRegistrationResponse({
        response: input.credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.config.webauthn.origins,
        expectedRPID: this.config.webauthn.rpId,
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const }))
      if (!verification.verified) throw passkeyRejected()

      const info = verification.registrationInfo
      const inserted = await tx`
        insert into passkeys (id, person_id, public_key, counter, transports, device_type, backed_up)
        values (
          ${info.credential.id}, ${invitation.person_id}, ${Buffer.from(info.credential.publicKey)},
          ${info.credential.counter}, ${info.credential.transports ?? []},
          ${info.credentialDeviceType}, ${info.credentialBackedUp}
        )
        on conflict (id) do nothing
        returning id
      `
      if (inserted.length === 0) {
        throw new ApiError(409, 'passkey_vorhanden', 'Dieser Passkey ist bereits registriert.')
      }
      await tx`update invitations set used_at = now() where id = ${invitation.id}`

      return this.issueSession(tx, invitation.person_id, input.userAgent)
    })
  }

  // --- Anmeldung mit Passkey ---------------------------------------------------

  async startLogin(): Promise<{
    challengeId: string
    options: PublicKeyCredentialRequestOptionsJSON
  }> {
    // Leere allowCredentials: auffindbare Passkeys, das Gerät wählt die Person.
    const options = await generateAuthenticationOptions({
      rpID: this.config.webauthn.rpId,
      userVerification: 'required',
    })
    const challengeId = await this.storeChallenge('authentication', options.challenge, null)
    return { challengeId, options }
  }

  async finishLogin(input: {
    challengeId: string
    credential: AuthenticationResponseJSON
    userAgent?: string | undefined
  }): Promise<IssuedSession> {
    const challenge = await this.consumeChallenge(input.challengeId, 'authentication')
    return this.db.begin(async (tx) => {
      const [passkey] = await tx<
        {
          id: string
          person_id: string
          public_key: Buffer
          counter: string
          transports: string[]
          webauthn_user_id: string
        }[]
      >`
        select k.id, k.person_id, k.public_key, k.counter, k.transports, p.webauthn_user_id
        from passkeys k join persons p on p.id = k.person_id
        where k.id = ${input.credential.id}
        for update of k
      `
      if (!passkey) throw passkeyRejected()

      // Gehört der Passkey wirklich zu der Person, die das Gerät nennt?
      const userHandle = input.credential.response.userHandle
      if (userHandle && userHandle !== passkey.webauthn_user_id) throw passkeyRejected()

      const verification = await verifyAuthenticationResponse({
        response: input.credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.config.webauthn.origins,
        expectedRPID: this.config.webauthn.rpId,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        requireUserVerification: true,
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }))
      if (!verification.verified || !verification.authenticationInfo) throw passkeyRejected()

      await tx`
        update passkeys
        set counter = ${verification.authenticationInfo.newCounter},
            backed_up = ${verification.authenticationInfo.credentialBackedUp},
            last_used_at = now()
        where id = ${passkey.id}
      `
      return this.issueSession(tx, passkey.person_id, input.userAgent)
    })
  }

  // --- Sitzungen ---------------------------------------------------------------

  /** Prüft ein Bearer-Token und verlängert die Sitzung gleitend. */
  async authenticate(token: string): Promise<{ person: Person; sessionId: string } | null> {
    const [row] = await this.db<(PersonRow & { session_id: string })[]>`
      with s as (
        update sessions
        set last_seen_at = now(),
            expires_at = now() + make_interval(days => ${this.config.sessionTtlDays})
        where token_hash = ${hashToken(token)} and expires_at > now()
        returning id, person_id
      )
      select p.*, s.id as session_id from s join persons p on p.id = s.person_id
    `
    if (!row) return null
    return { person: toPerson(row), sessionId: row.session_id }
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db`delete from sessions where id = ${sessionId}`
  }

  /** Aufräumen abgelaufener Challenges und Sitzungen. */
  async purgeExpired(): Promise<void> {
    await this.db`delete from webauthn_challenges where expires_at < now()`
    await this.db`delete from sessions where expires_at < now()`
  }

  // --- intern ------------------------------------------------------------------

  private async storeChallenge(
    purpose: 'registration' | 'authentication',
    challenge: string,
    invitationId: string | null,
  ): Promise<string> {
    const [row] = await this.db<{ id: string }[]>`
      insert into webauthn_challenges (purpose, challenge, invitation_id, expires_at)
      values (${purpose}, ${challenge}, ${invitationId}, ${new Date(Date.now() + CHALLENGE_TTL_MS)})
      returning id
    `
    if (!row) throw new Error('Challenge konnte nicht gespeichert werden')
    return row.id
  }

  /** Challenges sind einmalig: Sie werden beim ersten Prüfversuch gelöscht. */
  private async consumeChallenge(
    challengeId: string,
    purpose: 'registration' | 'authentication',
  ): Promise<{ challenge: string; invitation_id: string | null }> {
    const [row] = await this.db<{ challenge: string; invitation_id: string | null }[]>`
      delete from webauthn_challenges
      where id = ${challengeId} and purpose = ${purpose} and expires_at > now()
      returning challenge, invitation_id
    `
    if (!row) throw invalidChallenge()
    return row
  }

  private async issueSession(
    tx: TransactionSql,
    personId: string,
    userAgent: string | undefined,
  ): Promise<IssuedSession> {
    const token = newToken('frs')
    const expiresAt = new Date(Date.now() + this.config.sessionTtlDays * 24 * 3600 * 1000)
    await tx`
      insert into sessions (person_id, token_hash, user_agent, expires_at)
      values (${personId}, ${hashToken(token)}, ${userAgent?.slice(0, 300) ?? null}, ${expiresAt})
    `
    const [row] = await tx<PersonRow[]>`select * from persons where id = ${personId}`
    if (!row) throw new Error('Person nicht gefunden')
    return { token, expiresAt, person: toPerson(row) }
  }
}
