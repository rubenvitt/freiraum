import Foundation
import HTTPTypes
import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private let startJSON = """
{"householdId":"h1","month":"2026-10","openingBalanceCents":123456,"accounts":[
 {"accountId":"a1","name":"Girokonto","balance":{"cents":150000,"date":"2026-11-10","source":"manuell"},
  "openingBalanceCents":123456},
 {"accountId":"a2","name":"Bargeld","balance":null,"openingBalanceCents":null}]}
"""

@Suite struct BudgetStartServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func liestBudgetbeginnMitKontostaenden() async throws {
        let transport = FakeTransport { _ in (200, startJSON) }
        let start = try await service(transport).budgetStart(householdId: "h1")
        #expect(transport.requests.first?.method == .get)
        #expect(transport.requests.first?.path == "/v1/households/h1/budget-start")
        #expect(start.month == YearMonth(year: 2026, month: 10))
        #expect(start.openingBalanceCents == 123_456)
        #expect(start.accounts.count == 2)
        #expect(start.accounts[0].balance == AccountBalance(cents: 150_000, date: "2026-11-10", source: .manuell))
        #expect(start.accounts[0].openingBalanceCents == 123_456)
        #expect(start.accounts[1].balance == nil)
        #expect(start.accounts[1].openingBalanceCents == nil)
        #expect(start.accountsWithoutBalance.map(\.accountId) == ["a2"])
    }

    @Test func setztStartmonat() async throws {
        let transport = FakeTransport { _ in (200, startJSON) }
        _ = try await service(transport).setBudgetStart(householdId: "h1", month: YearMonth(year: 2026, month: 10))
        let request = try #require(transport.requests.first)
        #expect(request.method == .put)
        #expect(request.path == "/v1/households/h1/budget-start")
        #expect(request.body?["month"] as? String == "2026-10")
    }

    @Test func erfasstKontostandMitVorzeichen() async throws {
        let transport = FakeTransport { _ in (200, startJSON) }
        _ = try await service(transport).setBalance(accountId: "a1", cents: -12_345, date: "2026-11-10")
        let request = try #require(transport.requests.first)
        #expect(request.method == .put)
        #expect(request.path == "/v1/accounts/a1/balance")
        #expect(request.body?["balanceCents"] as? Int == -12_345)
        #expect(request.body?["date"] as? String == "2026-11-10")
    }

    @Test func legtKontoAn() async throws {
        let transport = FakeTransport { _ in
            (201, """
            {"id":"a3","householdId":"h1","name":"Girokonto","source":"bank","iban":null,"currency":"EUR",
             "createdAt":"2026-11-17T10:00:00.000Z","lastImportAt":null,"balance":null}
            """)
        }
        let account = try await service(transport).createAccount(householdId: "h1", name: "Girokonto", source: .bank)
        #expect(account.id == "a3")
        #expect(account.source == .bank)
        let body = try #require(transport.requests.first?.body)
        #expect(body["source"] as? String == "bank")
        #expect(body["name"] as? String == "Girokonto")
    }

    @Test func konfliktWirdVerstaendlich() async {
        let transport = FakeTransport { _ in
            (409, #"{"error":{"code":"zuweisungen_vor_budgetbeginn","message":"Im Monat 2026-09 gibt es schon Zuweisungen. Erst dort auf 0 setzen, dann den Budgetbeginn verschieben."}}"#)
        }
        do {
            _ = try await service(transport).setBudgetStart(householdId: "h1", month: YearMonth(year: 2026, month: 10))
            Issue.record("Fehler erwartet")
        } catch {
            #expect((error as? APIError)?.code == "zuweisungen_vor_budgetbeginn")
            let text = BudgetStartMessages.explain(error)
            #expect(text.hasPrefix("Im Monat September 2026 gibt es schon Zuweisungen."))
            #expect(text.contains("Übersicht"))
        }
    }
}

@Suite struct BudgetStartPresentationTests {
    let today = "2026-11-17"

    @Test func abgeschlossenerMonatSperrtStart() {
        let error = APIError.server(status: 409, code: "budgetbeginn_fest", message: "Server-Text")
        let text = BudgetStartMessages.explain(error)
        #expect(text.contains("abgeschlossen"))
        #expect(text.contains("wieder"))
    }

    @Test func andereFehlerBehaltenDieMeldung() {
        let error = APIError.server(status: 422, code: "kontostand_in_zukunft", message: "Ein Kontostand gilt für heute oder einen vergangenen Tag.")
        #expect(BudgetStartMessages.explain(error) == "Ein Kontostand gilt für heute oder einen vergangenen Tag.")
    }

    @Test func startmonateNeuesteZuerst() {
        let november = YearMonth(year: 2026, month: 11)
        let months = BudgetStartChoices.months(current: november, back: 3)
        #expect(months.map(\.description) == ["2026-12", "2026-11", "2026-10", "2026-09", "2026-08"])
    }

    @Test func alterStartBleibtWaehlbar() {
        let november = YearMonth(year: 2026, month: 11)
        let old = YearMonth(year: 2025, month: 1)
        let months = BudgetStartChoices.months(current: november, selected: old, back: 2)
        #expect(months.last == old)
        #expect(months.count == 5)
        #expect(BudgetStartChoices.months(current: november, selected: november, back: 2).count == 4)
    }

    @Test func kontostandLeerMitHeute() {
        let draft = BalanceDraft(today: today)
        #expect(draft.date == today)
        #expect(draft.problem == "Wie viel ist auf dem Konto?")
        #expect(draft.cents == nil)
    }

    @Test func kontostandVorbelegtImMinus() {
        let draft = BalanceDraft(balance: AccountBalance(cents: -123_456, date: "2026-11-01"), today: today)
        #expect(draft.amountText == "1.234,56")
        #expect(draft.negative)
        #expect(draft.date == "2026-11-01")
        #expect(draft.cents == -123_456)
        #expect(draft.problem == nil)
    }

    @Test func kontostandPrueft() {
        var draft = BalanceDraft(today: today)
        draft.amountText = "12,345"
        #expect(draft.problem == "Den Betrag verstehe ich nicht, z. B. 1.234,56.")
        draft.amountText = "0"
        #expect(draft.cents == 0)
        #expect(draft.problem == nil)
        draft.date = "2026-11-18"
        #expect(draft.problem == "Der Stichtag darf nicht in der Zukunft liegen.")
        draft.date = "2026-02-31"
        #expect(draft.problem == "Der Stichtag ist ungültig.")
    }

    @Test func zusammenfassungNenntFehlendeKonten() {
        let november = YearMonth(year: 2026, month: 11)
        let none = BudgetStart(householdId: "h1", month: november, openingBalanceCents: 0, accounts: [])
        #expect(none.summary.hasPrefix("Noch kein Konto."))
        let one = BudgetStart(householdId: "h1", month: november, openingBalanceCents: 0, accounts: [
            .init(accountId: "a1", name: "Girokonto"),
        ])
        #expect(one.summary.contains("November 2026"))
        #expect(one.summary.hasSuffix("Ein Konto hat noch keinen Kontostand und zählt mit 0."))
        let done = BudgetStart(householdId: "h1", month: november, openingBalanceCents: 5_000, accounts: [
            .init(accountId: "a1", name: "Girokonto", balance: AccountBalance(cents: 5_000, date: "2026-11-01"), openingBalanceCents: 5_000),
        ])
        #expect(done.summary == "Zählt im November 2026 zu „Noch ohne Aufgabe“, nicht zu den Einnahmen.")
    }
}
