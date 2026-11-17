import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = { DATABASE_URL: 'postgres://x@localhost/y', WEBAUTHN_RP_ID: 'freiraum.example' }

describe('Konfiguration', () => {
  it('setzt sinnvolle Standardwerte', () => {
    expect(loadConfig(base)).toEqual({
      port: 3000,
      databaseUrl: base.DATABASE_URL,
      webauthn: {
        rpId: 'freiraum.example',
        rpName: 'Freiraum',
        origins: ['https://freiraum.example'],
      },
      appleAppIds: [],
      sessionTtlDays: 90,
      invitationTtlHours: 72,
      migrateOnStart: true,
    })
  })

  it('liest Listen und Zahlen', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      WEBAUTHN_ORIGINS: 'https://a.example, https://b.example',
      APPLE_APP_IDS: 'TEAM.app.one,TEAM.app.two',
      MIGRATE_ON_START: 'false',
    })
    expect(config.port).toBe(8080)
    expect(config.webauthn.origins).toEqual(['https://a.example', 'https://b.example'])
    expect(config.appleAppIds).toEqual(['TEAM.app.one', 'TEAM.app.two'])
    expect(config.migrateOnStart).toBe(false)
  })

  it('verlangt Pflichtwerte und gültige Zahlen', () => {
    expect(() => loadConfig({ WEBAUTHN_RP_ID: 'x' })).toThrow('DATABASE_URL')
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow('WEBAUTHN_RP_ID')
    expect(() => loadConfig({ ...base, SESSION_TTL_DAYS: '0' })).toThrow('SESSION_TTL_DAYS')
  })
})
