import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing
@testable import FreiraumKit

/// Transport-Ersatz: merkt sich Anfragen und antwortet mit vorgegebenem Status und JSON.
final class FakeTransport: ClientTransport, @unchecked Sendable {
    struct Recorded {
        let method: HTTPRequest.Method
        let path: String
        let authorization: String?
        let body: [String: Any]?
    }

    private let lock = NSLock()
    private var _requests: [Recorded] = []
    var requests: [Recorded] { lock.withLock { _requests } }
    let respond: @Sendable (String) -> (Int, String)

    init(respond: @escaping @Sendable (String) -> (Int, String)) {
        self.respond = respond
    }

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
        var json: [String: Any]?
        if let body {
            let data = try await Data(collecting: body, upTo: 1 << 20)
            json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        let path = request.path ?? ""
        lock.withLock {
            _requests.append(Recorded(method: request.method, path: path, authorization: request.headerFields[.authorization], body: json))
        }
        let (status, text) = respond(path)
        var response = HTTPResponse(status: .init(code: status))
        response.headerFields[.contentType] = "application/json"
        return (response, HTTPBody(text))
    }
}

private let transactionJSON = """
{"id":"t1","accountId":"a1","sourceId":null,"bookingDate":"2026-11-03","valueDate":null,"amountCents":-450,
 "currency":"EUR","counterpartyName":"Bäcker","counterpartyIban":null,"purpose":null,"status":"bestaetigt",
 "recurringSeriesId":null,"splits":[{"kind":"topf","potId":"p1","amountCents":-450}],"suggestion":null}
"""

@Suite struct ServiceTests {
    func service(_ transport: FakeTransport, token: String? = "frs_test") -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { token }, transport: transport)
    }

    @Test func sendetTokenUndBildetBudgetAb() async throws {
        let transport = FakeTransport { _ in
            (200, """
            {"householdId":"h1","month":"2026-11","closedAt":null,"readyToAssignCents":21500,"inflowsCents":250000,
             "assignedCents":0,"activityCents":0,"overspentPreviousCents":0,"assignedInFutureCents":0,
             "unconfirmedTransactions":2,"pots":[{"potId":"p1","name":"Freizeit","kind":"monatlich","groupName":null,
             "archived":false,"carryoverCents":0,"assignedCents":15000,"assignmentSource":"manuell","activityCents":-8800,
             "availableCents":6200,"planCents":15000,"neededCents":0}]}
            """)
        }
        let budget = try await service(transport).budget(householdId: "h1", month: YearMonth(year: 2026, month: 11))
        #expect(budget.readyToAssignCents == 21_500)
        #expect(budget.pots.first?.availableCents == 6_200)
        #expect(budget.pots.first?.kind == .monatlich)
        let request = try #require(transport.requests.first)
        #expect(request.path == "/v1/households/h1/budget/2026-11")
        #expect(request.authorization == "Bearer frs_test")
    }

    @Test func barausgabeNeuUndWiederholt() async throws {
        let transport = FakeTransport { _ in (201, transactionJSON) }
        let expense = CashExpense(clientId: "c1", bookingDate: "2026-11-03", amountCents: 450, description: "Bäcker", potId: "p1")
        let t = try await service(transport).recordCashExpense(accountId: "a1", expense: expense)
        #expect(t.splits == [Split(target: .pot("p1"), amountCents: -450)])
        let body = try #require(transport.requests.first?.body)
        #expect(transport.requests.first?.path == "/v1/accounts/a1/cash-expenses")
        #expect(body["clientId"] as? String == "c1")
        #expect(body["amountCents"] as? Int == 450)

        let again = FakeTransport { _ in (200, transactionJSON) }
        let same = try await service(again).recordCashExpense(accountId: "a1", expense: expense)
        #expect(same.id == "t1")
    }

    @Test func aufteilungOhneTopfLaesstPotIdWeg() async throws {
        let transport = FakeTransport { _ in
            (200, "{\"transaction\":\(transactionJSON),\"rule\":null,\"resuggested\":0}")
        }
        _ = try await service(transport).setSplits(
            transactionId: "t1", splits: [Split(target: .transfer, amountCents: -5_000)], learn: false
        )
        let body = try #require(transport.requests.first?.body)
        let splits = try #require(body["splits"] as? [[String: Any]])
        #expect(splits.first?["kind"] as? String == "umbuchung")
        #expect(splits.first?["potId"] == nil)
        #expect(body["learn"] as? Bool == false)
    }

    @Test func fehlermeldungDesServers() async {
        let transport = FakeTransport { _ in
            (422, #"{"error":{"code":"kein_bargeldkonto","message":"Barausgaben lassen sich nur in einem Bargeldkonto erfassen."}}"#)
        }
        let expense = CashExpense(clientId: "c1", bookingDate: "2026-11-03", amountCents: 450, description: nil, potId: "p1")
        await #expect(throws: APIError.server(
            status: 422, code: "kein_bargeldkonto", message: "Barausgaben lassen sich nur in einem Bargeldkonto erfassen."
        )) {
            _ = try await service(transport).recordCashExpense(accountId: "a1", expense: expense)
        }
    }

    @Test func abgelaufeneSitzung() async {
        let transport = FakeTransport { _ in (401, #"{"error":{"code":"nicht_angemeldet","message":"Bitte melde dich an."}}"#) }
        await #expect(throws: APIError.unauthorized(message: "Bitte melde dich an.")) {
            _ = try await service(transport, token: nil).households()
        }
        #expect(transport.requests.first?.authorization == nil)
    }

    @Test func passkeyAnmeldung() async throws {
        let challenge = Base64URL.encode(Data([1, 2, 3, 250, 251, 252]))
        let transport = FakeTransport { path in
            if path.hasSuffix("/options") {
                return (200, #"{"challengeId":"c-1","options":{"challenge":"\#(challenge)","rpId":"freiraum.test"}}"#)
            }
            return (200, #"{"token":"frs_neu","expiresAt":"2027-02-15T10:00:00.000Z","person":{"id":"p","displayName":"Person A","createdAt":"2026-11-01T10:00:00.000Z"}}"#)
        }
        let svc = service(transport, token: nil)
        let login = try await svc.loginChallenge()
        #expect(login.relyingPartyId == "freiraum.test")
        #expect(login.challenge == Data([1, 2, 3, 250, 251, 252]))
        let session = try await svc.login(login, result: PasskeyAssertion(
            credentialId: Data([9, 9]), clientDataJSON: Data("{}".utf8), authenticatorData: Data([1]),
            signature: Data([2]), userId: Data([3])
        ))
        #expect(session.token == "frs_neu")
        #expect(session.person.displayName == "Person A")
        let body = try #require(transport.requests.last?.body)
        #expect(body["challengeId"] as? String == "c-1")
        let credential = try #require(body["credential"] as? [String: Any])
        #expect(credential["id"] as? String == "CQk")
        #expect(credential["type"] as? String == "public-key")
    }

    @Test func base64url() {
        let data = Data([0xFB, 0xFF, 0xBF])
        #expect(Base64URL.encode(data) == "-_-_")
        #expect(Base64URL.decode("-_-_") == data)
        #expect(Base64URL.decode("CQk") == Data([9, 9]))
        #expect(Base64URL.decode("A") == nil)
    }
}
