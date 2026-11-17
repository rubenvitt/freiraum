import Foundation
import Testing
@testable import FreiraumKit

/// Gegen ein laufendes Backend mit erfundenen Testdaten, nur wenn FREIRAUM_LIVE_URL und
/// FREIRAUM_LIVE_TOKEN gesetzt sind. Erwartet: privater Haushalt mit Bankkonto, Töpfen
/// „Lebensmittel“ (monatlich) und „Investieren“ (erst_ich, 300 €), Regel Supermarkt → Lebensmittel
/// und drei offene Buchungen im laufenden Monat (Lohn 2.500 €, Supermarkt −42,50 €, Bargeld −50 €).
@Suite(.enabled(if: ProcessInfo.processInfo.environment["FREIRAUM_LIVE_TOKEN"] != nil), .serialized)
struct LiveTests {
    let service: FreiraumService = {
        let env = ProcessInfo.processInfo.environment
        let token = env["FREIRAUM_LIVE_TOKEN"]
        return FreiraumService(baseURL: URL(string: env["FREIRAUM_LIVE_URL"] ?? "http://localhost:3999")!, token: { token })
    }()

    @Test func ablaufWieInDerApp() async throws {
        let month = YearMonth.current()
        let households = try await service.households()
        let household = try #require(households.first { $0.kind == .privat })
        let pots = try await service.pots(householdId: household.id)
        let lebensmittel = try #require(pots.first { $0.name == "Lebensmittel" })
        #expect(pots.contains { $0.kind == .ziel && $0.targetMonth == YearMonth(year: 2027, month: 7) })

        var pending = try await service.pendingTransactions(householdId: household.id)
        #expect(pending.count == 3)
        let supermarkt = try #require(pending.first { $0.counterpartyName == "Supermarkt Beispiel" })
        #expect(supermarkt.suggestion?.target == .pot(lebensmittel.id))
        let lohn = try #require(pending.first { $0.amountCents == 250_000 })
        let bargeld = try #require(pending.first { $0.purpose == "Bargeldauszahlung" })

        let confirmed = try await service.confirm(transactionId: supermarkt.id)
        #expect(confirmed.status == .bestaetigt)
        _ = try await service.setSplits(transactionId: lohn.id, splits: [Split(target: .income, amountCents: 250_000)])
        _ = try await service.setSplits(transactionId: bargeld.id, splits: [Split(target: .transfer, amountCents: -5_000)], learn: false)
        pending = try await service.pendingTransactions(householdId: household.id)
        #expect(pending.isEmpty)

        let cash = try await service.createCashAccount(householdId: household.id)
        #expect(cash.source == .bar)
        let expense = CashExpense(
            clientId: UUID().uuidString.lowercased(), bookingDate: GermanDates.isoDate(Date()),
            amountCents: 450, description: "Bäcker", potId: lebensmittel.id
        )
        let first = try await service.recordCashExpense(accountId: cash.id, expense: expense)
        let again = try await service.recordCashExpense(accountId: cash.id, expense: expense)
        #expect(first.id == again.id)
        #expect(first.amountCents == -450)

        try await service.assign(householdId: household.id, month: month, potId: lebensmittel.id, assignedCents: 40_000)
        let budget = try await service.budget(householdId: household.id, month: month)
        // 2.500 € Lohn − 300 € Erst ich (Automatik) − 400 € Lebensmittel
        #expect(budget.readyToAssignCents == 180_000)
        let pot = try #require(budget.pots.first { $0.potId == lebensmittel.id })
        #expect(pot.availableCents == 40_000 - 4_250 - 450)

        let state = OverviewState(budget: budget, household: household, pots: pots, pendingCount: 0)
        #expect(state.readyToAssign == "1.800")
        #expect(state.erstIchDone)
        let snapshot = WidgetSnapshot(budget: budget, household: household, pendingCount: 0)
        #expect(snapshot.tightestPots.first?.name == "Lebensmittel")

        await #expect(throws: APIError.self) {
            try await service.assign(householdId: household.id, month: month, potId: lebensmittel.id, assignedCents: 10_000_000)
        }
        let me = try await service.me()
        #expect(me.displayName == "Person A")
    }
}
