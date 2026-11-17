// Freiraum: Passkey mit Einladung anlegen und Anmeldung testen.
// Kein Build-Schritt, keine fremden Skripte. Tokens bleiben nur im Speicher dieser Seite.

const $ = (id) => document.getElementById(id)

const ui = {
  umgebung: $('umgebung'),
  form: $('form-anlegen'),
  token: $('token'),
  knopfAnlegen: $('knopf-anlegen'),
  meldungAnlegen: $('meldung-anlegen'),
  knopfTesten: $('knopf-testen'),
  meldungTesten: $('meldung-testen'),
}

class UserError extends Error {}

class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`)
    this.status = status
    this.code = code
  }
}

// --- base64url <-> ArrayBuffer ------------------------------------------------

function fromB64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function toB64url(buffer) {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const descriptors = (list) => (list ?? []).map((c) => ({ ...c, id: fromB64url(c.id) }))

function creationOptions(json) {
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    user: { ...json.user, id: fromB64url(json.user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  }
}

function requestOptions(json) {
  return {
    ...json,
    challenge: fromB64url(json.challenge),
    allowCredentials: descriptors(json.allowCredentials),
  }
}

function registrationJson(credential) {
  const r = credential.response
  const json = {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  }
  if (typeof r.getTransports === 'function') json.response.transports = r.getTransports()
  if (credential.authenticatorAttachment) {
    json.authenticatorAttachment = credential.authenticatorAttachment
  }
  return json
}

function authenticationJson(credential) {
  const r = credential.response
  const json = {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  }
  if (r.userHandle) json.response.userHandle = toB64url(r.userHandle)
  if (credential.authenticatorAttachment) {
    json.authenticatorAttachment = credential.authenticatorAttachment
  }
  return json
}

// --- API ------------------------------------------------------------------------

async function api(path, { method = 'POST', body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    throw new UserError(
      'Der Server ist nicht erreichbar. Prüfe die Verbindung und versuche es erneut.',
    )
  }
  if (res.status === 204) return null
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiFailure(res.status, data?.error?.code, data?.error?.message)
  return data
}

/** Die Seite braucht keine Sitzung: Sie wird gleich wieder beendet. */
async function endSession(token) {
  try {
    await api('/v1/auth/logout', { token })
  } catch {
    // Läuft ohnehin ab; die Meldung an die Person ändert das nicht.
  }
}

// --- Prüfungen und Meldungen ------------------------------------------------------

function wrongDomain(rpId) {
  const host = location.hostname
  return Boolean(rpId) && host !== rpId && !host.endsWith(`.${rpId}`)
}

function checkDomain(rpId) {
  if (wrongDomain(rpId)) {
    throw new UserError(
      `Diese Seite läuft unter „${location.hostname}“, die Passkeys von Freiraum gehören aber zu „${rpId}“. ` +
        `Öffne die Seite über https://${rpId}/registrieren.`,
    )
  }
}

function explain(err, flow) {
  if (err instanceof UserError) return err.message
  if (err instanceof ApiFailure) {
    if (err.status === 410) {
      return 'Diese Einladung ist abgelaufen oder wurde schon benutzt. Lass dir mit „cli einladen <Person-ID>“ eine neue erzeugen.'
    }
    if (err.code === 'challenge_ungueltig') {
      return 'Das hat zu lange gedauert. Bitte noch einmal von vorn starten.'
    }
    if (err.status === 409) return 'Dieser Passkey ist bereits registriert.'
    if (err.status === 401 && flow === 'anlegen') {
      return 'Der Server hat den Passkey nicht bestätigt. Öffnest du die Seite über die richtige Adresse? Die Einladung ist noch gültig.'
    }
    if (err.status === 401) {
      return 'Dieser Passkey ist bei Freiraum nicht bekannt. Vielleicht gehört er zu einer anderen Adresse oder wurde entfernt.'
    }
    if (err.status === 400 && flow === 'anlegen') {
      return 'Das Token sieht nicht vollständig aus. Bitte komplett einfügen, es beginnt mit „fre_“.'
    }
    return err.message || `Unerwartete Antwort vom Server (HTTP ${err.status}).`
  }
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'AbortError':
        return flow === 'anlegen'
          ? 'Der Passkey-Dialog wurde abgebrochen oder ist abgelaufen. Es wurde nichts gespeichert, die Einladung ist noch gültig.'
          : 'Der Passkey-Dialog wurde abgebrochen, oder auf diesem Gerät gibt es noch keinen Passkey für Freiraum.'
      case 'InvalidStateError':
        return 'Auf diesem Gerät gibt es schon einen Passkey für diese Person. Die Einladung ist noch gültig und kann auf einem anderen Gerät benutzt werden.'
      case 'SecurityError':
        return `Der Browser lehnt Passkeys für diese Adresse ab („${location.hostname}“). Die Seite muss über die Domain von Freiraum und per HTTPS geöffnet werden.`
      case 'NotSupportedError':
        return 'Dieser Browser oder dieses Gerät unterstützt die nötigen Passkeys nicht.'
    }
  }
  return `Unerwarteter Fehler: ${err?.message ?? err}`
}

function show(element, text, kind) {
  element.textContent = text
  element.className = `meldung ${kind}`
  element.hidden = false
}

function busy(button, label) {
  const original = button.textContent
  button.disabled = true
  button.textContent = label
  return () => {
    button.disabled = false
    button.textContent = original
  }
}

function checkEnvironment() {
  if (!window.isSecureContext) {
    return 'Passkeys funktionieren nur über HTTPS. Öffne die Seite über https://…'
  }
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    return 'Dieser Browser unterstützt keine Passkeys. Bitte Safari, Chrome, Edge oder Firefox in einer aktuellen Version verwenden.'
  }
  return null
}

// --- Abläufe ------------------------------------------------------------------------

async function register(event) {
  event.preventDefault()
  const token = ui.token.value.trim()
  if (!token.startsWith('fre_') || token.length < 20) {
    show(
      ui.meldungAnlegen,
      'Bitte das vollständige Einladungs-Token einfügen. Es beginnt mit „fre_“.',
      'fehler',
    )
    ui.token.focus()
    return
  }
  const done = busy(ui.knopfAnlegen, 'Passkey wird angelegt …')
  ui.meldungAnlegen.hidden = true
  try {
    const start = await api('/v1/auth/registration/options', { body: { invitationToken: token } })
    checkDomain(start.options.rp?.id)
    const credential = await navigator.credentials.create({
      publicKey: creationOptions(start.options),
    })
    const session = await api('/v1/auth/registration/verify', {
      body: {
        challengeId: start.challengeId,
        invitationToken: token,
        credential: registrationJson(credential),
      },
    })
    ui.token.value = ''
    await endSession(session.token)
    show(
      ui.meldungAnlegen,
      `Passkey angelegt für ${session.person.displayName}. Die Einladung ist damit verbraucht.`,
      'erfolg',
    )
  } catch (err) {
    show(ui.meldungAnlegen, explain(err, 'anlegen'), 'fehler')
  } finally {
    done()
  }
}

async function testLogin() {
  const done = busy(ui.knopfTesten, 'Anmeldung läuft …')
  ui.meldungTesten.hidden = true
  try {
    const start = await api('/v1/auth/login/options')
    checkDomain(start.options.rpId)
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(start.options),
    })
    const session = await api('/v1/auth/login/verify', {
      body: { challengeId: start.challengeId, credential: authenticationJson(credential) },
    })
    const me = await api('/v1/me', { method: 'GET', token: session.token })
    await endSession(session.token)
    show(ui.meldungTesten, `Angemeldet als ${me.displayName}. Der Passkey funktioniert.`, 'erfolg')
  } catch (err) {
    show(ui.meldungTesten, explain(err, 'testen'), 'fehler')
  } finally {
    done()
  }
}

// --- Start ------------------------------------------------------------------------

// Link aus der Kommandozeile: …/registrieren#token=fre_… (das Fragment geht nie an den Server).
const fromLink = new URLSearchParams(location.hash.slice(1)).get('token')
if (fromLink) {
  ui.token.value = fromLink
  history.replaceState(null, '', location.pathname)
}

const problem = checkEnvironment()
if (problem) {
  ui.umgebung.textContent = problem
  ui.umgebung.hidden = false
  ui.knopfAnlegen.disabled = true
  ui.knopfTesten.disabled = true
} else {
  ui.form.addEventListener('submit', register)
  ui.knopfTesten.addEventListener('click', testLogin)
}
