import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      llm: null,
      webDistDir: null,
    })
  })

  it('nimmt WEB_DIST_DIR nur mit index.html an', () => {
    const dir = mkdtempSync(join(tmpdir(), 'freiraum-web-'))
    expect(() => loadConfig({ ...base, WEB_DIST_DIR: dir })).toThrow(/WEB_DIST_DIR/)
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
    expect(loadConfig({ ...base, WEB_DIST_DIR: dir }).webDistDir).toBe(dir)
  })

  it('schaltet das LLM nur mit Schlüssel ein', () => {
    expect(loadConfig({ ...base, LLM_MODEL: 'beispiel/modell' }).llm).toBeNull()
    expect(
      loadConfig({ ...base, LLM_API_KEY: 'sk-test', LLM_MODEL: 'beispiel/modell' }).llm,
    ).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      model: 'beispiel/modell',
      timeoutMs: 60_000,
      zeroDataRetention: true,
    })
    const custom = loadConfig({
      ...base,
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'beispiel/modell',
      LLM_BASE_URL: 'http://ollama.lan:11434/v1/',
      LLM_TIMEOUT_MS: '5000',
      LLM_ZDR: 'false',
    }).llm
    expect(custom).toMatchObject({
      baseUrl: 'http://ollama.lan:11434/v1',
      timeoutMs: 5000,
      zeroDataRetention: false,
    })
    expect(() => loadConfig({ ...base, LLM_API_KEY: 'sk-test' })).toThrow('LLM_MODEL')
    expect(() =>
      loadConfig({ ...base, LLM_API_KEY: 'sk-test', LLM_MODEL: 'm', LLM_ZDR: 'ja' }),
    ).toThrow('LLM_ZDR')
    expect(() =>
      loadConfig({ ...base, LLM_API_KEY: 'sk-test', LLM_MODEL: 'm', LLM_BASE_URL: 'kaputt' }),
    ).toThrow('LLM_BASE_URL')
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
