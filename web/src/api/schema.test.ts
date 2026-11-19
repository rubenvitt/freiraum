import { readFile } from 'node:fs/promises'
import openapiTS, { astToString } from 'openapi-typescript'
import { describe, expect, it } from 'vitest'

describe('API-Client', () => {
  it('schema.d.ts passt zu openapi/openapi.yaml (sonst: pnpm gen)', async () => {
    const spec = new URL('../../../openapi/openapi.yaml', import.meta.url)
    const generated = astToString(await openapiTS(spec))
    const committed = await readFile(new URL('./schema.d.ts', import.meta.url), 'utf8')
    // Der Kopfkommentar der CLI fehlt bei astToString; verglichen wird der Rest.
    expect(committed.slice(committed.indexOf('export '))).toBe(
      generated.slice(generated.indexOf('export ')),
    )
  })
})
