import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HTTPTypes
import OpenAPIRuntime

/// Fehler aus der API mit der deutschen Meldung des Servers.
public enum APIError: Error, Equatable, Sendable, LocalizedError {
    /// 401: Sitzung abgelaufen oder ungültig, neu anmelden.
    case unauthorized(message: String)
    /// Fachlicher oder Anfragefehler mit Code und Meldung des Servers.
    case server(status: Int, code: String, message: String)
    /// Antwort, die nicht zum Vertrag passt.
    case unexpected(String)
    /// Keine Verbindung zum Server.
    case offline(String)

    public var errorDescription: String? {
        switch self {
        case let .unauthorized(message): message
        case let .server(_, _, message): message
        case let .unexpected(detail): "Unerwartete Antwort vom Server (\(detail))."
        case let .offline(detail): "Keine Verbindung zum Server. \(detail)"
        }
    }

    public var code: String? {
        if case let .server(_, code, _) = self { return code }
        return nil
    }

    /// Fehler aus dem generierten Client auspacken (Middleware-Fehler kommen als ClientError).
    static func wrap(_ error: any Error) -> APIError {
        if let api = error as? APIError { return api }
        if let client = error as? ClientError {
            return wrap(client.underlyingError)
        }
        if let url = error as? URLError {
            return .offline(url.localizedDescription)
        }
        return .unexpected(String(describing: error))
    }
}

/// Wandelt Fehlerantworten (≥ 400) in `APIError` mit der Meldung des Servers, bevor der
/// generierte Client sie dekodiert. Dadurch braucht nicht jeder Aufruf alle Fehlerfälle.
struct ErrorMiddleware: ClientMiddleware {
    private struct Body: Decodable {
        struct Inner: Decodable {
            let code: String
            let message: String
        }

        let error: Inner
    }

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let (response, responseBody) = try await next(request, body, baseURL)
        let status = response.status.code
        guard status >= 400 else { return (response, responseBody) }
        var parsed: Body.Inner?
        if let responseBody {
            let data = try? await Data(collecting: responseBody, upTo: 64 * 1024)
            parsed = data.flatMap { try? JSONDecoder().decode(Body.self, from: $0) }?.error
        }
        if status == 401 {
            throw APIError.unauthorized(message: parsed?.message ?? "Bitte melde dich an.")
        }
        throw APIError.server(
            status: status,
            code: parsed?.code ?? "http_\(status)",
            message: parsed?.message ?? "Der Server hat mit \(status) geantwortet."
        )
    }
}

/// Setzt das Bearer-Token der Sitzung.
struct BearerMiddleware: ClientMiddleware {
    let token: @Sendable () async -> String?

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if let token = await token() {
            request.headerFields[.authorization] = "Bearer \(token)"
        }
        return try await next(request, body, baseURL)
    }
}
