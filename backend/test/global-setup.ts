import postgres from 'postgres'
import { createDb } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { TEST_DATABASE_URL } from './helpers/env.js'

/** Legt die Testdatenbank frisch an und migriert sie. */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL)
  const name = url.pathname.slice(1)
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Testdatenbank muss auf _test enden, ist aber „${name}“`)
  }
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const sql = postgres(admin.toString(), { onnotice: () => {} })
  await sql.unsafe(`drop database if exists ${name} with (force)`)
  await sql.unsafe(`create database ${name}`)
  await sql.end()

  const db = createDb(TEST_DATABASE_URL)
  await migrate(db)
  await db.end()
}
