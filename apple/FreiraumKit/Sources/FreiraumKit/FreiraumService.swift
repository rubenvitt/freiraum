import Foundation
import FreiraumAPI
import OpenAPIRuntime
import OpenAPIURLSession

/// Zugriff auf das Backend. Dünne Schicht über dem generierten Client: bildet auf die Modelle
/// der App ab und wirft `APIError` mit der Meldung des Servers.
public final class FreiraumService: Sendable {
    public let baseURL: URL
    // Nicht privat, damit Erweiterungen in eigenen Dateien (z. B. BudgetStart.swift) ihn nutzen.
    let client: Client

    /// - Parameters:
    ///   - baseURL: z. B. `https://freiraum.example.org` (ohne Pfad)
    ///   - token: liefert das aktuelle Sitzungs-Token oder nil
    public init(
        baseURL: URL,
        token: @escaping @Sendable () async -> String?,
        transport: any ClientTransport = URLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.client = Client(
            serverURL: baseURL,
            // Der Server schreibt Zeitpunkte mit Millisekunden (toISOString).
            configuration: Configuration(dateTranscoder: .iso8601WithFractionalSeconds),
            transport: transport,
            middlewares: [BearerMiddleware(token: token), ErrorMiddleware()]
        )
    }

    /// Relying-Party-ID, falls der Server keine nennt: der Hostname.
    private var fallbackRelyingPartyId: String { baseURL.host ?? "" }

    func call<T>(_ body: () async throws -> T) async throws(APIError) -> T {
        do {
            return try await body()
        } catch {
            throw APIError.wrap(error)
        }
    }

    func unexpected(_ output: some Any) -> APIError {
        .unexpected(String(describing: output).prefix(200).description)
    }

    // MARK: - Anmeldung

    /// Schritt 1 der Registrierung: Einladungs-Token gegen eine Challenge tauschen.
    public func registrationChallenge(invitationToken: String) async throws(APIError) -> PasskeyRegistrationChallenge {
        try await call {
            let out = try await client.postV1AuthRegistrationOptions(body: .json(.init(invitationToken: invitationToken)))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            let start = try ok.body.json
            guard let challenge = Base64URL.decode(start.options.challenge),
                  let userId = Base64URL.decode(start.options.user.id)
            else { throw APIError.unexpected("Challenge ist kein Base64url") }
            return PasskeyRegistrationChallenge(
                challengeId: start.challengeId,
                relyingPartyId: start.options.rp.id ?? fallbackRelyingPartyId,
                challenge: challenge, userId: userId, userName: start.options.user.name
            )
        }
    }

    /// Schritt 2 der Registrierung: Passkey prüfen lassen, Sitzung erhalten.
    public func register(
        _ challenge: PasskeyRegistrationChallenge, invitationToken: String, result: PasskeyRegistration
    ) async throws(APIError) -> Session {
        let id = Base64URL.encode(result.credentialId)
        let credential = Components.Schemas.RegistrationCredential(
            id: id, rawId: id, _type: .publicKey,
            response: .init(
                clientDataJSON: Base64URL.encode(result.clientDataJSON),
                attestationObject: Base64URL.encode(result.attestationObject),
                transports: ["internal", "hybrid"]
            ),
            authenticatorAttachment: .platform,
            clientExtensionResults: .init()
        )
        return try await call {
            let out = try await client.postV1AuthRegistrationVerify(body: .json(.init(
                challengeId: challenge.challengeId, invitationToken: invitationToken, credential: credential
            )))
            guard case let .created(created) = out else { throw unexpected(out) }
            return Session(try created.body.json)
        }
    }

    /// Schritt 1 der Anmeldung: Challenge holen (auffindbare Passkeys, ohne Benutzername).
    public func loginChallenge() async throws(APIError) -> PasskeyLoginChallenge {
        try await call {
            let out = try await client.postV1AuthLoginOptions()
            guard case let .ok(ok) = out else { throw unexpected(out) }
            let start = try ok.body.json
            guard let challenge = Base64URL.decode(start.options.challenge) else {
                throw APIError.unexpected("Challenge ist kein Base64url")
            }
            return PasskeyLoginChallenge(
                challengeId: start.challengeId,
                relyingPartyId: start.options.rpId ?? fallbackRelyingPartyId,
                challenge: challenge
            )
        }
    }

    /// Schritt 2 der Anmeldung: Signatur prüfen lassen, Sitzung erhalten.
    public func login(_ challenge: PasskeyLoginChallenge, result: PasskeyAssertion) async throws(APIError) -> Session {
        let id = Base64URL.encode(result.credentialId)
        let credential = Components.Schemas.AuthenticationCredential(
            id: id, rawId: id, _type: .publicKey,
            response: .init(
                clientDataJSON: Base64URL.encode(result.clientDataJSON),
                authenticatorData: Base64URL.encode(result.authenticatorData),
                signature: Base64URL.encode(result.signature),
                userHandle: result.userId.map(Base64URL.encode)
            ),
            authenticatorAttachment: .platform,
            clientExtensionResults: .init()
        )
        return try await call {
            let out = try await client.postV1AuthLoginVerify(body: .json(.init(
                challengeId: challenge.challengeId, credential: credential
            )))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return Session(try ok.body.json)
        }
    }

    public func logout() async throws(APIError) {
        try await call {
            let out = try await client.postV1AuthLogout()
            guard case .noContent = out else { throw unexpected(out) }
        }
    }

    public func me() async throws(APIError) -> Person {
        try await call {
            let out = try await client.getV1Me()
            guard case let .ok(ok) = out else { throw unexpected(out) }
            let p = try ok.body.json
            return Person(id: p.id, displayName: p.displayName)
        }
    }

    // MARK: - Haushalte, Konten, Töpfe, Budget

    public func households() async throws(APIError) -> [Household] {
        try await call {
            let out = try await client.getV1Households()
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(Household.init)
        }
    }

    public func accounts() async throws(APIError) -> [Account] {
        try await call {
            let out = try await client.getV1Accounts()
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(Account.init)
        }
    }

    /// Bargeldkonto im Haushalt anlegen (für Barausgaben).
    public func createCashAccount(householdId: String, name: String = "Bargeld") async throws(APIError) -> Account {
        try await call {
            let out = try await client.postV1Accounts(body: .json(.init(householdId: householdId, name: name, source: .bar)))
            guard case let .created(created) = out else { throw unexpected(out) }
            return try Account(try created.body.json)
        }
    }

    public func pots(householdId: String) async throws(APIError) -> [Pot] {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdPots(path: .init(householdId: householdId))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(Pot.init)
        }
    }

    public func budget(householdId: String, month: YearMonth) async throws(APIError) -> BudgetMonth {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdBudgetMonth(
                path: .init(householdId: householdId, month: month.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetMonth(try ok.body.json)
        }
    }

    /// Zuweisung eines Topfs für einen Monat setzen. Der Server lehnt Erhöhungen ab, die
    /// „Noch ohne Aufgabe“ negativ machen würden (422).
    public func assign(householdId: String, month: YearMonth, potId: String, assignedCents: Int) async throws(APIError) {
        try await call {
            let out = try await client.putV1HouseholdsHouseholdIdBudgetMonthPotsPotId(
                path: .init(householdId: householdId, month: month.description, potId: potId),
                body: .json(.init(assignedCents: assignedCents))
            )
            guard case .ok = out else { throw unexpected(out) }
        }
    }

    // MARK: - Buchungen

    /// Buchungen, die auf Bestätigung warten (neueste zuerst).
    public func pendingTransactions(householdId: String? = nil, limit: Int = 500) async throws(APIError) -> [Transaction] {
        try await call {
            let out = try await client.getV1TransactionsPending(query: .init(householdId: householdId, limit: limit))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(Transaction.init)
        }
    }

    /// Vorschlag mit einem Tipp übernehmen.
    public func confirm(transactionId: String) async throws(APIError) -> Transaction {
        try await call {
            let out = try await client.postV1TransactionsTransactionIdConfirm(path: .init(transactionId: transactionId))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try Transaction(try ok.body.json)
        }
    }

    /// Aufteilung festlegen und bestätigen. Weicht eine einfache Zuordnung vom Vorschlag ab,
    /// lernt der Server daraus eine Regel (außer `learn` ist false).
    public func setSplits(transactionId: String, splits: [Split], learn: Bool = true) async throws(APIError) -> Transaction {
        try await call {
            let out = try await client.putV1TransactionsTransactionIdSplits(
                path: .init(transactionId: transactionId),
                body: .json(.init(splits: splits.map(\.api), learn: learn))
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try Transaction(try ok.body.json.transaction)
        }
    }

    /// Barausgabe erfassen. Idempotent über `clientId`.
    public func recordCashExpense(accountId: String, expense: CashExpense) async throws(APIError) -> Transaction {
        try await call {
            let out = try await client.postV1AccountsAccountIdCashExpenses(
                path: .init(accountId: accountId),
                body: .json(.init(
                    clientId: expense.clientId, bookingDate: expense.bookingDate, amountCents: expense.amountCents,
                    description: expense.description, potId: expense.potId
                ))
            )
            switch out {
            case let .created(created): return try Transaction(try created.body.json)
            case let .ok(ok): return try Transaction(try ok.body.json)
            default: throw unexpected(out)
            }
        }
    }
}

extension Session {
    init(_ s: Components.Schemas.Session) {
        self.init(token: s.token, expiresAt: s.expiresAt, person: Person(id: s.person.id, displayName: s.person.displayName))
    }
}
