import Foundation
import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private func m(_ month: Int, year: Int = 2026) -> YearMonth { YearMonth(year: year, month: month) }

private let metricsJSON = """
{"householdId":"h1","from":"2026-10","to":"2026-11",
 "months":[
  {"month":"2026-10","incomeCents":300000,"consumptionCents":200000,"erstIchCents":30000,"contributionsCents":0,
   "savedCents":100000,"savingsRateBp":3333,"fixedCostsCents":90000,"fixedCostShareBp":3000,
   "uncategorizedOutCents":0,"uncategorizedInCents":0,"ageOfMoneyDays":20},
  {"month":"2026-11","incomeCents":0,"consumptionCents":5000,"erstIchCents":0,"contributionsCents":0,
   "savedCents":-5000,"savingsRateBp":null,"fixedCostsCents":0,"fixedCostShareBp":null,
   "uncategorizedOutCents":1200,"uncategorizedInCents":800,"ageOfMoneyDays":null}],
 "totals":{"incomeCents":300000,"consumptionCents":205000,"erstIchCents":30000,"contributionsCents":0,
   "savedCents":95000,"savingsRateBp":3167,"fixedCostsCents":90000,"fixedCostShareBp":3000,
   "uncategorizedOutCents":1200,"uncategorizedInCents":800},
 "runway":{"cashCents":740000,"averageMonthlyConsumptionCents":100000,"fixedContributionsCents":0,
   "monthlyOutflowCents":100000,"basedOnMonths":1,"months":7.4}}
"""

private let flowJSON = """
{"householdId":"h1","from":"2026-11","to":"2026-11",
 "nodes":[{"id":"haushalt","label":"Ich","kind":"haushalt","potId":null,"potKind":null},
  {"id":"quelle:1","label":"Arbeitgeber","kind":"quelle","potId":null,"potKind":null},
  {"id":"topf:p1","label":"Depot","kind":"topf","potId":"p1","potKind":"erst_ich"}],
 "links":[{"source":"quelle:1","target":"haushalt","valueCents":1000},{"source":"haushalt","target":"topf:p1","valueCents":1000}],
 "inCents":1000,"outCents":1000}
"""

private let anomaliesJSON = """
{"householdId":"h1","month":"2026-11","items":[
 {"kind":"neues_abo","title":"Neues Abo: Streaming, 9,99 € im Monat.","potId":null,"seriesId":"s1","amountCents":-999,"referenceCents":null},
 {"kind":"ausgaben_hoch","title":"Freizeit liegt 60 % über dem Schnitt.","potId":"p2","seriesId":null,"amountCents":-24000,"referenceCents":-15000}]}
"""

private let goalsJSON = """
{"householdId":"h1","month":"2026-11","items":[
 {"potId":"p3","name":"Urlaub","targetCents":300000,"savedCents":198000,"remainingCents":102000,"progressBp":6600,
  "targetMonth":"2027-06","monthlyRateCents":22000,"projectedMonth":"2027-04","requiredMonthlyCents":14572,"status":"im_plan"}]}
"""

private let ownershipJSON = """
{"householdId":"h1","from":"2025-12","to":"2026-11","items":[
 {"assetId":"x1","name":"Auto","valueCents":800000,"costCents":240000,"recurringCostCents":90000,"monthlyAverageCents":20000,
  "annualCostOfValueBp":3000,"classification":"verbindlichkeit",
  "pots":[{"potId":"p4","name":"Kfz-Versicherung","costCents":90000},{"potId":"p5","name":"Sprit","costCents":150000}]}],
 "totalCostCents":240000,"shareOfConsumptionBp":1200}
"""

@Suite struct AnalyticsServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func kennzahlenMitZeitraumUndNullwerten() async throws {
        let transport = FakeTransport { _ in (200, metricsJSON) }
        let metrics = try await service(transport).metrics(householdId: "h1", from: m(10), to: m(11))
        #expect(transport.requests.first?.path == "/v1/households/h1/analytics/metrics?from=2026-10&to=2026-11")
        #expect(metrics.months.count == 2)
        #expect(metrics.months[0].values.savingsRateBp == 3_333)
        #expect(metrics.months[0].ageOfMoneyDays == 20)
        #expect(metrics.months[1].values.savingsRateBp == nil)
        #expect(metrics.months[1].ageOfMoneyDays == nil)
        #expect(metrics.totals.savedCents == 95_000)
        #expect(metrics.runway.months == 7.4)
    }

    @Test func geldflussMitTopfart() async throws {
        let transport = FakeTransport { _ in (200, flowJSON) }
        let flow = try await service(transport).flow(householdId: "h1", from: m(11), to: m(11))
        #expect(transport.requests.first?.path == "/v1/households/h1/analytics/flow?from=2026-11&to=2026-11")
        #expect(flow.nodes.map(\.kind) == [.haushalt, .quelle, .topf])
        #expect(flow.nodes[2].potKind == .erstIch)
        #expect(flow.links.count == 2)
    }

    @Test func auffaelligkeitenZieleBesitz() async throws {
        let transport = FakeTransport { path in
            if path.contains("anomalies") { return (200, anomaliesJSON) }
            if path.contains("goals") { return (200, goalsJSON) }
            return (200, ownershipJSON)
        }
        let s = service(transport)
        let anomalies = try await s.anomalies(householdId: "h1", month: m(11))
        #expect(anomalies.map(\.kind) == [.neuesAbo, .ausgabenHoch])
        let goals = try await s.goals(householdId: "h1")
        #expect(goals.first?.status == .imPlan)
        #expect(goals.first?.projectedMonth == m(4, year: 2027))
        let costs = try await s.ownershipCosts(householdId: "h1", from: m(12, year: 2025), to: m(11))
        #expect(costs.items.first?.classification == .verbindlichkeit)
        #expect(costs.items.first?.pots.count == 2)
        #expect(transport.requests.map(\.path) == [
            "/v1/households/h1/analytics/anomalies?month=2026-11",
            "/v1/households/h1/analytics/goals",
            "/v1/households/h1/analytics/ownership-costs?from=2025-12&to=2026-11",
        ])
    }

    @Test func unbekannteArtIstEinFehler() async throws {
        let transport = FakeTransport { _ in
            (200, #"{"householdId":"h1","month":"2026-11","items":[{"kind":"neu_erfunden","title":"x","potId":null,"seriesId":null,"amountCents":0,"referenceCents":null}]}"#)
        }
        await #expect(throws: APIError.self) {
            _ = try await service(transport).anomalies(householdId: "h1", month: m(11))
        }
    }
}

@Suite struct AnalyticsPresentationTests {
    @Test func anteileAlsText() {
        #expect(RatioText.format(2_834) == "28\u{00A0}%")
        #expect(RatioText.format(2_850) == "29\u{00A0}%")
        #expect(RatioText.format(950) == "9,5\u{00A0}%")
        #expect(RatioText.format(1_000) == "10\u{00A0}%")
        #expect(RatioText.format(-1_200) == "\u{2212}12\u{00A0}%")
        #expect(RatioText.format(nil) == "–")
        #expect(RatioText.points(300) == "+3 Punkte")
        #expect(RatioText.points(-100) == "\u{2212}1 Punkt")
        #expect(RatioText.points(20) == "gleich")
    }

    @Test func zeitraumBeginntFruehestensMitDemBudget() {
        #expect(AnalyticsPeriod.monat.range(to: m(11), budgetStart: nil) == m(11)...m(11))
        #expect(AnalyticsPeriod.quartal.range(to: m(11), budgetStart: nil) == m(9)...m(11))
        #expect(AnalyticsPeriod.jahr.range(to: m(11), budgetStart: nil) == m(12, year: 2025)...m(11))
        #expect(AnalyticsPeriod.jahr.range(to: m(11), budgetStart: m(10)) == m(10)...m(11))
        // Monat vor dem Budgetbeginn: nur dieser Monat.
        #expect(AnalyticsPeriod.quartal.range(to: m(8), budgetStart: m(10)) == m(8)...m(8))
        #expect(AnalyticsPeriod.title(m(11)...m(11)) == "November 2026")
        #expect(AnalyticsPeriod.title(m(9)...m(11)) == "Sept – Nov 2026")
        #expect(AnalyticsPeriod.title(m(12, year: 2025)...m(11)) == "Dez 2025 – Nov 2026")
    }

    private func month(_ mm: Int, rate: Int?, fixed: Int? = 2_500, age: Int? = nil) -> MonthMetrics {
        MonthMetrics(
            month: m(mm),
            values: MetricValues(incomeCents: rate == nil ? 0 : 300_000, savedCents: (rate ?? 0) * 30,
                                 savingsRateBp: rate, fixedCostsCents: 75_000, fixedCostShareBp: fixed),
            ageOfMoneyDays: age
        )
    }

    private func state(summary: MetricValues, months: [MonthMetrics], runway: Runway, to: Int = 11) -> AnalyticsState {
        let summaryMetrics = Metrics(householdId: "h1", from: m(to), to: m(to), months: months.filter { $0.month == m(to) },
                                     totals: summary, runway: runway)
        let history = Metrics(householdId: "h1", from: months.first?.month ?? m(to), to: m(to), months: months,
                              totals: summary, runway: runway)
        let flow = MoneyFlow(householdId: "h1", from: m(to), to: m(to), nodes: [], links: [], inCents: 0, outCents: 0)
        return AnalyticsState(summary: summaryMetrics, history: history, flow: flow, anomalies: [], goals: [], ownership: nil)
    }

    @Test func kachelnMitVergleich() {
        let months = [month(8, rate: 2_200, age: 30), month(9, rate: 2_600, age: 33), month(10, rate: 2_500, age: 35),
                      month(11, rate: 2_800, age: 41)]
        let summary = MetricValues(incomeCents: 735_000, savedCents: 205_800, savingsRateBp: 2_800,
                                   fixedCostsCents: 197_500, fixedCostShareBp: 2_687)
        let s = state(summary: summary, months: months, runway: Runway(cashCents: 1_000_000, months: 7.4))
        #expect(s.tiles.map(\.id) == ["sparquote", "fixkosten", "runway", "alter"])
        // Schnitt der Monate davor: (2200 + 2600 + 2500) / 3 = 2433 → +3,67 Punkte → „+4 Punkte“
        #expect(s.tiles[0].value == "28\u{00A0}%")
        #expect(s.tiles[0].detail == "+4 Punkte zum Schnitt davor")
        #expect(s.tiles[0].tone == .good)
        #expect(s.tiles[1].value == "27\u{00A0}%")
        #expect(s.tiles[1].detail == "1.975\u{00A0}€ von 7.350\u{00A0}€")
        #expect(s.tiles[2].value == "7,4")
        #expect(s.tiles[2].unit == "Monate")
        #expect(s.tiles[3].value == "41")
        #expect(s.tiles[3].detail == "+6 Tage seit Oktober")
        #expect(s.savingsRate.map(\.label) == ["Aug", "Sept", "Okt", "Nov"])
        #expect(s.savingsRate.last?.isCurrent == true)
        #expect(s.savingsRate.first?.value == 22)
        #expect(s.ageOfMoney.last?.value == 41)
    }

    @Test func ohneHistorieUndOhneEinkommen() {
        let summary = MetricValues(consumptionCents: 5_000, uncategorizedOutCents: 1_200, uncategorizedInCents: 800)
        let s = state(summary: summary, months: [month(11, rate: nil, fixed: nil)], runway: Runway(cashCents: 0))
        #expect(s.tiles[0].value == "–")
        #expect(s.tiles[0].detail == "Noch kein Einkommen zugeordnet")
        #expect(s.tiles[2].value == "–")
        #expect(s.tiles[2].unit == nil)
        #expect(s.tiles[3].value == "–")
        #expect(s.savingsRate.first?.value == nil)
        #expect(s.flowSummary == "Im Zeitraum ist noch nichts geflossen.")
        #expect(s.uncategorizedNote?.hasPrefix("Noch nicht zugeordnet: 8\u{00A0}€ Eingänge und 12\u{00A0}€ Ausgänge.") == true)
    }

    @Test func runwayMitFesterEinzahlung() {
        let s = state(summary: MetricValues(), months: [],
                      runway: Runway(cashCents: 500_000, fixedContributionsCents: 60_000, months: 3))
        #expect(s.tiles[2].value == "3")
        #expect(s.tiles[2].detail == "ohne Einkommen, mit 600\u{00A0}€ Einzahlung im Monat")
    }

    @Test func zieleUndBesitz() {
        let late = GoalRow(GoalForecast(
            potId: "p1", name: "Haus", targetCents: 5_000_000, savedCents: 1_000_000, remainingCents: 4_000_000,
            progressBp: 2_000, targetMonth: m(12, year: 2027), monthlyRateCents: 100_000,
            projectedMonth: m(3, year: 2030), requiredMonthlyCents: 307_693, status: .verspaetet
        ))
        #expect(late.amount == "10.000\u{00A0}€ von 50.000\u{00A0}€")
        #expect(late.progress == 0.2)
        #expect(late.detail == "Bei heutiger Sparrate erst im März 2030 (Ziel: Dezember 2027). Nötig: 3.076,93\u{00A0}€ im Monat.")
        #expect(!late.onTrack)
        let none = GoalRow(GoalForecast(potId: "p2", name: "Rad", targetCents: 100_000, savedCents: 0, remainingCents: 100_000,
                                        progressBp: 0, status: .ohneSparrate))
        #expect(none.detail == "Noch keine Sparrate in den letzten 3 Monaten.")
        let done = GoalRow(GoalForecast(potId: "p3", name: "Laptop", targetCents: 100_000, savedCents: 120_000,
                                        remainingCents: 0, progressBp: 12_000, status: .erreicht))
        #expect(done.progress == 1)
        #expect(done.detail == "Erreicht.")

        let car = AssetRow(AssetCosts(
            assetId: "x1", name: "Auto", valueCents: 800_000, costCents: 240_000, recurringCostCents: 90_000,
            monthlyAverageCents: 20_000, annualCostOfValueBp: 3_000, classification: .verbindlichkeit,
            pots: [.init(potId: "p4", name: "Sprit", costCents: 150_000)]
        ))
        #expect(car.cost == "2.400\u{00A0}€")
        #expect(car.detail == "Ø 200\u{00A0}€ im Monat · davon wiederkehrend 900\u{00A0}€")
        #expect(car.classification == "Verbindlichkeit")
        #expect(car.isLiability)
        #expect(car.valueNote == "Wert 8.000\u{00A0}€, kostet 30\u{00A0}% davon im Jahr")
        #expect(car.pots == ["Sprit 1.500\u{00A0}€"])
    }

    @Test func menueleiste() {
        let budget = BudgetMonth(householdId: "h1", month: m(11), readyToAssignCents: 21_500, pots: [])
        let household = Household(id: "h1", kind: .privat, name: "Privat", members: [])
        let anomalies = [Anomaly(kind: .neuesAbo, title: "Neues Abo: Streaming.", amountCents: -999),
                         Anomaly(kind: .preisErhoeht, title: "Strom ist teurer.", amountCents: -9_000)]
        let state = MenuBarState(budget: budget, household: household, pendingCount: 4, anomalies: anomalies)
        #expect(state.label == "215\u{00A0}€")
        #expect(state.householdLabel == "Ich")
        #expect(state.pending == "4 Buchungen warten")
        #expect(state.nextAnomaly == "Neues Abo: Streaming.")
        #expect(state.moreAnomalies == "und 1 weitere")

        let empty = MenuBarState(budget: nil, household: nil, pendingCount: 0, anomalies: [])
        #expect(empty.label == "Freiraum")
        #expect(empty.pending == nil)
        #expect(empty.nextAnomaly == nil)
    }
}
