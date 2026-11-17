import postgres, { type Sql } from 'postgres'

export type Db = Sql

export function createDb(databaseUrl: string): Db {
  return postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    // Datenbank läuft in UTC; Zeitpunkte sind überall timestamptz.
    connection: { TimeZone: 'UTC' },
  })
}
