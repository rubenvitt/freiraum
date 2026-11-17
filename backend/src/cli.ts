/**
 * Verwaltung per Kommandozeile (im Container: `node dist/cli.js …`).
 * Es gibt kein öffentliches Sign-up: Personen und Einladungen entstehen nur hier.
 */
import { AuthService } from './auth/service.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { migrate } from './db/migrate.js'
import { LedgerService } from './ledger/service.js'

const USAGE = `Verwendung:
  cli migrate                    Datenbank-Migrationen anwenden
  cli person-anlegen <Name>      Person anlegen und Einladung ausgeben
  cli einladen <Person-ID>       neue Einladung (weiterer Passkey, Wiederherstellung)
  cli personen                   Personen mit Anzahl Passkeys auflisten
  cli gemeinsam-anlegen <Person-ID> <Person-ID> <Name>
                                 gemeinsamen Haushalt für zwei Personen anlegen`

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args
  if (!command || command === 'hilfe' || command === '--help') {
    console.log(USAGE)
    return command ? 0 : 1
  }

  const config = loadConfig()
  const db = createDb(config.databaseUrl)
  const auth = new AuthService(db, config)
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(db)
        console.log(applied.length ? `Angewendet: ${applied.join(', ')}` : 'Nichts zu tun.')
        return 0
      }
      case 'person-anlegen': {
        const name = rest.join(' ').trim()
        if (!name) throw new Error('Name fehlt')
        const person = await auth.createPerson(name)
        const invitation = await auth.createInvitation(person.id)
        console.log(`Person angelegt: ${person.displayName} (${person.id})`)
        printInvitation(invitation)
        return 0
      }
      case 'einladen': {
        const personId = rest[0]
        if (!personId) throw new Error('Person-ID fehlt')
        printInvitation(await auth.createInvitation(personId))
        return 0
      }
      case 'personen': {
        for (const p of await auth.listPersons()) {
          console.log(`${p.id}  ${p.displayName}  Passkeys: ${p.passkeys}`)
        }
        return 0
      }
      case 'gemeinsam-anlegen': {
        const [a, b, ...nameParts] = rest
        const name = nameParts.join(' ').trim() || 'Gemeinsam'
        if (!a || !b) throw new Error('Zwei Person-IDs nötig')
        const household = await new LedgerService(db).createSharedHousehold(name, [a, b])
        const members = household.members.map((m) => m.displayName).join(' und ')
        console.log(
          `Gemeinsamer Haushalt angelegt: ${household.name} (${household.id}), ${members}`,
        )
        return 0
      }
      default:
        console.error(`Unbekannter Befehl: ${command}\n\n${USAGE}`)
        return 1
    }
  } finally {
    await db.end({ timeout: 5 })
  }
}

function printInvitation(inv: { token: string; expiresAt: Date }): void {
  console.log(`Einladungs-Token (einmalig, gültig bis ${inv.expiresAt.toISOString()}):`)
  console.log(inv.token)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
