/** Fachlicher Fehler mit deutscher Meldung; wird zentral in eine JSON-Antwort übersetzt. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
