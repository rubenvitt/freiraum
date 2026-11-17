import Foundation
import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private let nov = YearMonth(year: 2026, month: 11)
private let oct = YearMonth(year: 2026, month: 10)

private func budget(
    month: YearMonth = nov, closed: Bool = false, ready: Int = 10_000, unconfirmed: Int = 0, pots: [BudgetPot]? = nil
) -> BudgetMonth {
    BudgetMonth(
        householdId: "h1", month: month, startMonth: YearMonth(year: 2026, month: 9), closed: closed,
        readyToAssignCents: ready, inflowsCents: 300_000, unconfirmedTransactions: unconfirmed,
        pots: pots ?? [
            BudgetPot(potId: "miete", name: "Miete", kind: .monatlich, groupName: "Wohnen", assignedCents: 90_000,
                      activityCents: -90_000, availableCents: 0, planCents: 90_000),
            BudgetPot(potId: "depot", name: "Depot", kind: .erstIch, assignedCents: 30_000, activityCents: -30_000,
                      availableCents: 0, planCents: 30_000),
            BudgetPot(potId: "essen", name: "Essen", kind: .monatlich, groupName: "Alltag", assignedCents: 40_000,
                      activityCents: -25_000, availableCents: 15_000, planCents: 40_000),
            BudgetPot(potId: "strom", name: "Strom", kind: .monatlich, groupName: "Wohnen", assignedCents: 5_000,
                      activityCents: -8_000, availableCents: -3_000, planCents: 8_000, neededCents: 3_000),
            BudgetPot(potId: "rad", name: "Fahrrad", kind: .ziel, assignedCents: 0, availableCents: 20_000),
            BudgetPot(potId: "alt", name: "Alt", kind: .monatlich, archived: true),
        ]
    )
}

private let pots = [
    Pot(id: "depot", householdId: "h1", name: "Depot", kind: .erstIch, sortOrder: 0),
    Pot(id: "miete", householdId: "h1", name: "Miete", kind: .monatlich, groupName: "Wohnen", sortOrder: 1),
    Pot(id: "strom", householdId: "h1", name: "Strom", kind: .monatlich, groupName: "Wohnen", sortOrder: 2),
    Pot(id: "essen", householdId: "h1", name: "Essen", kind: .monatlich, groupName: "Alltag", sortOrder: 3),
    Pot(id: "rad", householdId: "h1", name: "Fahrrad", kind: .ziel, sortOrder: 4),
]

@Suite struct PlanningStateTests {
    @Test func gruppenUndSummen() {
        let state = PlanningState(budget: budget(), pots: pots, current: nov)
        #expect(state.groups.map(\.title) == ["Erst ich", "Wohnen", "Alltag", "Ohne Gruppe"])
        #expect(state.groups[1].rows.map(\.name) == ["Miete", "Strom"])
        #expect(state.groups[1].assigned == "950\u{00A0}€")
        #expect(state.groups[1].available == "\u{2212}30\u{00A0}€")
        // Archiviert und leer: nicht in der Tabelle.
        #expect(state.row("alt") == nil)
        #expect(state.readyToAssign == "100\u{00A0}€")
        #expect(state.neededCents == 3_000)
        #expect(state.movable.map(\.potId) == ["depot", "miete", "strom", "essen", "rad"])
    }

    @Test func zeilenTonUndHinweis() throws {
        let state = PlanningState(budget: budget(), pots: pots, current: nov)
        let strom = try #require(state.row("strom"))
        #expect(strom.tone == .overspent)
        #expect(strom.note == "fehlt 30\u{00A0}€")
        let essen = try #require(state.row("essen"))
        #expect(essen.tone == .ok)
        #expect(essen.note == "Plan 400\u{00A0}€")
        #expect(essen.activity == "\u{2212}250\u{00A0}€")
    }

    @Test func abschluss() {
        #expect(!ClosingState(budget: budget(month: nov), current: nov).canClose)
        #expect(ClosingState(budget: budget(month: nov), current: nov).note == "Abschließen geht, wenn der Monat vorbei ist.")
        let open = ClosingState(budget: budget(month: oct, unconfirmed: 2), current: nov)
        #expect(!open.canClose)
        #expect(open.note == "Erst die 2 wartenden Buchungen bestätigen.")
        #expect(ClosingState(budget: budget(month: oct), current: nov).canClose)
        let closed = ClosingState(budget: budget(month: oct, closed: true), current: nov)
        #expect(!closed.canClose)
        #expect(closed.canReopen)
        let before = ClosingState(budget: budget(month: YearMonth(year: 2026, month: 8)), current: nov)
        #expect(!before.canClose)
        #expect(before.note == "Vor dem Budgetbeginn (September 2026).")
    }
}

@Suite struct MoveMoneyTests {
    @Test func zwischenToepfenErstSenkenDannErhoehen() throws {
        let steps = try MoveMoney.steps(in: budget(), from: .pot("essen"), to: "strom", amountCents: 3_000)
        #expect(steps == [
            MoveMoney.Step(potId: "essen", assignedCents: 37_000, previousCents: 40_000),
            MoveMoney.Step(potId: "strom", assignedCents: 8_000, previousCents: 5_000),
        ])
    }

    @Test func ausNochOhneAufgabePrueftDerServer() throws {
        // Mehr als „Noch ohne Aufgabe“: die App lässt es zu, der Server antwortet mit seiner Meldung.
        let steps = try MoveMoney.steps(in: budget(ready: 1_000), from: .readyToAssign, to: "strom", amountCents: 5_000)
        #expect(steps == [MoveMoney.Step(potId: "strom", assignedCents: 10_000, previousCents: 5_000)])
    }

    @Test func ungueltigeEingaben() {
        #expect(throws: MoveMoney.Problem.amountNotPositive) {
            try MoveMoney.steps(in: budget(), from: .readyToAssign, to: "strom", amountCents: 0)
        }
        #expect(throws: MoveMoney.Problem.sameSourceAndTarget) {
            try MoveMoney.steps(in: budget(), from: .pot("strom"), to: "strom", amountCents: 100)
        }
        #expect(throws: MoveMoney.Problem.unknownPot) {
            try MoveMoney.steps(in: budget(), from: .readyToAssign, to: "alt", amountCents: 100)
        }
        #expect(throws: MoveMoney.Problem.monthClosed) {
            try MoveMoney.steps(in: budget(closed: true), from: .readyToAssign, to: "strom", amountCents: 100)
        }
        #expect(throws: MoveMoney.Problem.notEnoughInPot(name: "Essen", availableCents: 15_000)) {
            try MoveMoney.steps(in: budget(), from: .pot("essen"), to: "strom", amountCents: 20_000)
        }
        #expect(MoveMoney.Problem.notEnoughInPot(name: "Essen", availableCents: 15_000).description
            == "In „Essen“ sind nur 150\u{00A0}€ verfügbar.")
    }
}

private let budgetJSON = """
{"householdId":"h1","month":"2026-11","budgetStartMonth":"2026-09","closedAt":null,"readyToAssignCents":0,
 "openingBalanceCents":0,"inflowsCents":0,"contributionsCents":0,"assignedCents":0,"activityCents":0,
 "overspentPreviousCents":0,"assignedInFutureCents":0,"unconfirmedTransactions":0,"pots":[]}
"""

@Suite struct PlanningServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func umschichtenNimmtBeiFehlerZurueck() async throws {
        let transport = FakeTransport { path in
            if path.hasSuffix("/pots/strom") {
                return (422, #"{"error":{"code":"nicht_genug","message":"Nicht genug Geld ohne Aufgabe."}}"#)
            }
            return (200, budgetJSON)
        }
        let steps = [
            MoveMoney.Step(potId: "essen", assignedCents: 37_000, previousCents: 40_000),
            MoveMoney.Step(potId: "strom", assignedCents: 8_000, previousCents: 5_000),
        ]
        await #expect(throws: APIError.server(status: 422, code: "nicht_genug", message: "Nicht genug Geld ohne Aufgabe.")) {
            _ = try await service(transport).move(householdId: "h1", month: nov, steps: steps)
        }
        let calls = transport.requests.map { "\($0.path) \($0.body?["assignedCents"] as? Int ?? -1)" }
        #expect(calls == [
            "/v1/households/h1/budget/2026-11/pots/essen 37000",
            "/v1/households/h1/budget/2026-11/pots/strom 8000",
            "/v1/households/h1/budget/2026-11/pots/essen 40000",
        ])
    }

    @Test func abschliessenUndOeffnen() async throws {
        let transport = FakeTransport { _ in (201, budgetJSON) }
        _ = try await service(transport).closeMonth(householdId: "h1", month: oct)
        #expect(transport.requests.last?.method == .post)
        #expect(transport.requests.last?.path == "/v1/households/h1/budget/2026-10/closing")

        let reopen = FakeTransport { _ in (200, budgetJSON) }
        _ = try await service(reopen).reopenMonth(householdId: "h1", month: oct)
        #expect(reopen.requests.last?.method == .delete)
        #expect(reopen.requests.last?.path == "/v1/households/h1/budget/2026-10/closing")
    }

    @Test func abschlussAbgelehntMitMeldung() async throws {
        let transport = FakeTransport { _ in
            (409, #"{"error":{"code":"vormonat_offen","message":"Erst den Monat 2026-09 abschließen, Monate werden der Reihe nach abgeschlossen."}}"#)
        }
        await #expect(throws: APIError.server(
            status: 409, code: "vormonat_offen",
            message: "Erst den Monat 2026-09 abschließen, Monate werden der Reihe nach abgeschlossen."
        )) {
            _ = try await service(transport).closeMonth(householdId: "h1", month: oct)
        }
    }
}
