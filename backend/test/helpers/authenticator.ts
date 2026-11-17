/**
 * Software-Authenticator für Tests: erzeugt echte WebAuthn-Antworten (ES256, Attestation „none“),
 * die @simplewebauthn/server ohne Abkürzungen prüft.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()
const b64url = (data: Uint8Array) => Buffer.from(data).toString('base64url')

export interface CreationOptions {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
}
export interface RequestOptions {
  challenge: string
  rpId?: string
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16)
  private readonly privateKey: KeyObject
  private readonly publicJwk: { x: string; y: string }
  private counter = 0
  userHandle: string | undefined

  constructor(
    private readonly origin: string,
    private readonly opts: { userVerified?: boolean } = {},
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }))
    const jwk = publicKey.export({ format: 'jwk' })
    if (!jwk.x || !jwk.y) throw new Error('JWK ohne Koordinaten')
    this.publicJwk = { x: jwk.x, y: jwk.y }
  }

  get id(): string {
    return b64url(this.credentialId)
  }

  private flags(extra: number): number {
    const uv = this.opts.userVerified === false ? 0 : FLAG_UV
    return FLAG_UP | uv | FLAG_BE | FLAG_BS | extra
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  /** Antwort auf navigator.credentials.create() */
  create(options: CreationOptions, rpIdOverride?: string) {
    const rpId = rpIdOverride ?? options.rp.id
    if (!rpId) throw new Error('rp.id fehlt')
    this.userHandle = options.user.id

    const coseKey = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ])
    const credIdLen = Buffer.alloc(2)
    credIdLen.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      Buffer.alloc(4), // signCount 0, wie bei Apple-Passkeys
      Buffer.alloc(16), // AAGUID
      credIdLen,
      this.credentialId,
      Buffer.from(isoCBOR.encode(coseKey)),
    ])
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
    }
  }

  /** Antwort auf navigator.credentials.get() */
  get(options: RequestOptions, rpIdOverride?: string) {
    const rpId = rpIdOverride ?? options.rpId
    if (!rpId) throw new Error('rpId fehlt')
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.counter)
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(0)]), count])
    const clientDataJSON = this.clientData('webauthn.get', options.challenge)
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.privateKey,
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
    }
  }
}
