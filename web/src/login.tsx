import { useState } from 'preact/hooks'
import { ApiError, api, type Person, unwrap } from './api/client'
import { authenticationJson, type RequestOptionsJson, requestOptions } from './lib/webauthn'

function explain(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Die Anmeldung wurde abgebrochen oder ist abgelaufen. Versuch es noch einmal.'
  }
  if (err instanceof TypeError) {
    return 'Der Server ist nicht erreichbar. Prüfe die Verbindung und versuche es erneut.'
  }
  return 'Die Anmeldung hat nicht geklappt. Versuch es noch einmal.'
}

/** Anmeldung mit Passkey. Die Sitzung setzt der Server als HttpOnly-Cookie. */
export function Login({ onLogin }: { onLogin: (person: Person) => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const supported = typeof window !== 'undefined' && 'PublicKeyCredential' in window

  async function login() {
    setBusy(true)
    setMessage(null)
    try {
      const start = unwrap(await api.POST('/v1/auth/login/options'))
      const credential = (await navigator.credentials.get({
        publicKey: requestOptions(start.options as RequestOptionsJson),
      })) as PublicKeyCredential | null
      if (!credential) throw new DOMException('abgebrochen', 'NotAllowedError')
      const session = unwrap(
        await api.POST('/v1/auth/login/verify-web', {
          body: { challengeId: start.challengeId, credential: authenticationJson(credential) },
        }),
      )
      onLogin(session.person)
    } catch (err) {
      setMessage(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main class="login">
      <p class="marke">Freiraum</p>
      <h1>Auswertungen</h1>
      <p class="leise">
        Melde dich mit deinem Passkey an. Die Anmeldung bleibt auf diesem Gerät bestehen.
      </p>
      {supported ? (
        <button type="button" class="knopf" disabled={busy} onClick={login}>
          {busy ? 'Anmeldung läuft …' : 'Mit Passkey anmelden'}
        </button>
      ) : (
        <p class="meldung warnung" role="alert">
          Dieser Browser unterstützt keine Passkeys.
        </p>
      )}
      {message && (
        <p class="meldung warnung" role="alert">
          {message}
        </p>
      )}
      <p class="klein">
        Noch kein Passkey? Mit einer Einladung legst du ihn unter{' '}
        <a href="/registrieren">Passkey einrichten</a> an.
      </p>
    </main>
  )
}
