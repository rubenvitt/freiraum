import { z } from '@hono/zod-openapi'

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'nicht_angemeldet' }),
      message: z.string().openapi({ example: 'Bitte melde dich an.' }),
    }),
  })
  .openapi('Error')

export const PersonSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().openapi({ example: 'Person A' }),
    createdAt: z.iso.datetime(),
  })
  .openapi('Person')

export const SessionSchema = z
  .object({
    token: z.string().openapi({ description: 'Bearer-Token für den Header Authorization' }),
    expiresAt: z.iso.datetime(),
    person: PersonSchema,
  })
  .openapi('Session')

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'base64url erwartet')
const Transport = z.string().openapi({ example: 'internal' })
const CredentialDescriptor = z.object({
  id: Base64Url,
  type: z.string().openapi({ example: 'public-key' }),
  transports: z.array(Transport).optional(),
})

/** Teilmenge von PublicKeyCredentialCreationOptionsJSON (WebAuthn L3), weitere Felder erlaubt. */
export const RegistrationOptionsSchema = z
  .looseObject({
    challenge: Base64Url,
    rp: z.object({ id: z.string().optional(), name: z.string() }),
    user: z.object({ id: Base64Url, name: z.string(), displayName: z.string() }),
    pubKeyCredParams: z.array(
      z.object({ type: z.string().openapi({ example: 'public-key' }), alg: z.number().int() }),
    ),
    timeout: z.number().int().optional(),
    excludeCredentials: z.array(CredentialDescriptor).optional(),
    authenticatorSelection: z
      .looseObject({
        residentKey: z.string().optional(),
        userVerification: z.string().optional(),
      })
      .optional(),
    attestation: z.string().optional(),
  })
  .openapi('RegistrationOptions')

/** Teilmenge von PublicKeyCredentialRequestOptionsJSON (WebAuthn L3), weitere Felder erlaubt. */
export const AuthenticationOptionsSchema = z
  .looseObject({
    challenge: Base64Url,
    rpId: z.string().optional(),
    timeout: z.number().int().optional(),
    allowCredentials: z.array(CredentialDescriptor).optional(),
    userVerification: z.string().optional(),
  })
  .openapi('AuthenticationOptions')

/** RegistrationResponseJSON, wie es navigator.credentials.create() bzw. ASAuthorization liefert. */
export const RegistrationCredentialSchema = z
  .object({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: Base64Url,
      attestationObject: Base64Url,
      transports: z.array(Transport).optional(),
    }),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.looseObject({}).default({}),
  })
  .openapi('RegistrationCredential')

/** AuthenticationResponseJSON, wie es navigator.credentials.get() bzw. ASAuthorization liefert. */
export const AuthenticationCredentialSchema = z
  .object({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: Base64Url,
      authenticatorData: Base64Url,
      signature: Base64Url,
      userHandle: Base64Url.optional(),
    }),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.looseObject({}).default({}),
  })
  .openapi('AuthenticationCredential')

export const ChallengeId = z.uuid().openapi({ description: 'Kennung der Anfrage aus …/options' })
