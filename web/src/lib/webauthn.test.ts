import { describe, expect, it } from 'vitest'
import { fromB64url, requestOptions, toB64url } from './webauthn'

describe('base64url', () => {
  it('wandelt hin und zurück ohne Auffüllung', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    const text = toB64url(bytes.buffer)
    expect(text).toBe('AAH6-_z9_v8')
    expect(new Uint8Array(fromB64url(text))).toEqual(bytes)
  })

  it('baut Optionen für navigator.credentials.get', () => {
    const options = requestOptions({
      challenge: 'AAH6-_z9_v8',
      rpId: 'freiraum.test',
      allowCredentials: [{ id: 'AQID', type: 'public-key' }],
      userVerification: 'required',
    })
    expect(options.rpId).toBe('freiraum.test')
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(
      new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]),
    )
    const first = options.allowCredentials?.[0]
    expect(new Uint8Array(first?.id as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
