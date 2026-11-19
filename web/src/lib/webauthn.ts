// Passkey-Anmeldung im Browser: Umwandlung zwischen den JSON-Optionen der API (base64url) und
// den ArrayBuffern der WebAuthn-API. Wie in backend/public/registrieren.js.
import type { components } from '../api/schema'

export function fromB64url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function toB64url(buffer: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Descriptor = { id: string; type: string; transports?: string[] }
export type RequestOptionsJson = {
  challenge: string
  rpId?: string
  timeout?: number
  allowCredentials?: Descriptor[]
  userVerification?: string
}

export function requestOptions(json: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  const options: PublicKeyCredentialRequestOptions = {
    challenge: fromB64url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({
      id: fromB64url(c.id),
      type: 'public-key',
      ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    })),
  }
  if (json.rpId) options.rpId = json.rpId
  if (json.timeout) options.timeout = json.timeout
  if (json.userVerification) {
    options.userVerification = json.userVerification as UserVerificationRequirement
  }
  return options
}

/** Antwort des Authenticators als JSON für /v1/auth/login/verify-web. */
export function authenticationJson(
  credential: PublicKeyCredential,
): components['schemas']['AuthenticationCredential'] {
  const r = credential.response as AuthenticatorAssertionResponse
  const attachment = credential.authenticatorAttachment
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      ...(r.userHandle ? { userHandle: toB64url(r.userHandle) } : {}),
    },
    clientExtensionResults: { ...(credential.getClientExtensionResults?.() ?? {}) },
    ...(attachment === 'platform' || attachment === 'cross-platform'
      ? { authenticatorAttachment: attachment }
      : {}),
  }
}
