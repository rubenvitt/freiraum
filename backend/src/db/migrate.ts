import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Db } from './client.js'

/** Ordner `backend/migrations`, gleich tief von `src/db` und `dist/db` aus. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

/** Feste Kennung für pg_advisory_xact_lock, damit parallele Starts nicht doppelt migrieren. */
const LOCK_KEY = 0x46524549 // „FREI“

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()

  return db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`
    await tx`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `
    const done = new Set(
      (await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    )
    const applied: string[] = []
    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(`${dir}${file}`, 'utf8')
      await tx.unsafe(sql).simple()
      await tx`insert into schema_migrations (name) values (${file})`
      applied.push(file)
    }
    return applied
  })
}
