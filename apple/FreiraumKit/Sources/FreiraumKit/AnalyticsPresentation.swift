// Aufbereitung der Auswertungen für die Anzeige (Mac). Ohne SwiftUI, damit testbar.

/// Anteile aus den Auswertungen (Basispunkte, 10 000 = 100 %) als Text: gerundet auf ganze
/// Prozent, unter 10 % mit einer Nachkommastelle. Eingaben in Prozent: `Percent`.
public enum RatioText {
    /// 2834 → „28 %“, 50 → „0,5 %“, nil → „–“. Unter 10 % mit einer Nachkommastelle.
    public static func format(_ bp: Int?) -> String {
        guard let bp else { return "–" }
        let sign = bp < 0 ? Money.minus : ""
        let magnitude = bp.magnitude
        if magnitude < 1_000 {
            // eine Nachkommastelle, kaufmännisch gerundet
            let tenths = (magnitude + 5) / 10
            let text = tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10),\(tenths % 10)"
            return "\(sign)\(text)\u{00A0}%"
        }
        return "\(sign)\((magnitude + 50) / 100)\u{00A0}%"
    }

    /// Ganze Prozent als Zahl für Diagramme (2834 → 28,34).
    public static func value(_ bp: Int) -> Double {
        Double(bp) / 100
    }

    /// Abstand zweier Anteile in Prozentpunkten: „+3 Punkte“, „−1 Punkt“, „gleich“.
    public static func points(_ deltaBp: Int) -> String {
        let points = (deltaBp.magnitude + 50) / 100
        if points == 0 { return "gleich" }
        let sign = deltaBp < 0 ? Money.minus : "+"
        return "\(sign)\(points) \(points == 1 ? "Punkt" : "Punkte")"
    }
}

/// Zeitraum der Auswertungen. Der Verlauf in den Diagrammen zeigt immer bis zu 12 Monate.
public enum AnalyticsPeriod: String, CaseIterable, Sendable, Identifiable, Hashable {
    case monat, quartal, jahr

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .monat: "Monat"
        case .quartal: "Quartal"
        case .jahr: "Jahr"
        }
    }

    public var length: Int {
        switch self {
        case .monat: 1
        case .quartal: 3
        case .jahr: 12
        }
    }

    /// Monate bis einschließlich `to`, frühestens ab dem Budgetbeginn (davor ist nichts
    /// zugeordnet und die Kennzahlen wären irreführend, siehe ADR 0005).
    public func range(to: YearMonth, budgetStart: YearMonth?) -> ClosedRange<YearMonth> {
        AnalyticsPeriod.range(months: length, to: to, budgetStart: budgetStart)
    }

    /// Verlauf für Diagramme: bis zu 12 Monate bis `to`, ab dem Budgetbeginn.
    public static func history(to: YearMonth, budgetStart: YearMonth?) -> ClosedRange<YearMonth> {
        range(months: 12, to: to, budgetStart: budgetStart)
    }

    static func range(months: Int, to: YearMonth, budgetStart: YearMonth?) -> ClosedRange<YearMonth> {
        var from = to
        for _ in 1..<max(1, months) { from = from.previous }
        if let budgetStart, budgetStart > from { from = min(budgetStart, to) }
        return from...to
    }

    /// Überschrift: „November 2026“, „Sept – Nov 2026“, „Dez 2025 – Nov 2026“.
    public static func title(_ range: ClosedRange<YearMonth>) -> String {
        let a = range.lowerBound, b = range.upperBound
        if a == b { return b.title }
        let short = { (m: YearMonth) in GermanDates.monthShort[m.month - 1] }
        if a.year == b.year { return "\(short(a)) – \(short(b)) \(b.year)" }
        return "\(short(a)) \(a.year) – \(short(b)) \(b.year)"
    }
}

/// Eine Kennzahl als Kachel: Titel, großer Wert mit Einheit, Zeile darunter.
public struct MetricTile: Hashable, Sendable, Identifiable {
    public enum Tone: Hashable, Sendable { case neutral, good, warning }

    public let id: String
    public let title: String
    public let value: String
    /// kleiner hinter dem Wert, z. B. „Monate“
    public let unit: String?
    public let detail: String
    public let tone: Tone
}

/// Ein Punkt im Verlauf (Balken oder Linie).
public struct TrendPoint: Hashable, Sendable, Identifiable {
    public var id: YearMonth { month }
    public let month: YearMonth
    /// „Nov“
    public let label: String
    /// nil = kein Wert (z. B. ohne Einkommen)
    public let value: Double?
    /// Beschriftung über dem Balken, z. B. „28 %“
    public let text: String
    /// letzter (angezeigter) Monat
    public let isCurrent: Bool
}

/// Zeile einer Auffälligkeit.
public struct AnomalyRow: Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// „Ausgaben hoch“, „Neues Abo“, „Preis erhöht“
    public let badge: String
    public let systemImage: String

    public init(_ anomaly: Anomaly, index: Int) {
        id = "\(anomaly.kind.rawValue):\(anomaly.potId ?? anomaly.seriesId ?? "")#\(index)"
        title = anomaly.title
        switch anomaly.kind {
        case .ausgabenHoch:
            badge = "Ausgaben hoch"
            systemImage = "chart.line.uptrend.xyaxis"
        case .neuesAbo:
            badge = "Neues Abo"
            systemImage = "repeat"
        case .preisErhoeht:
            badge = "Preis erhöht"
            systemImage = "arrow.up.right"
        }
    }
}

/// Zeile eines Ziels mit Prognose.
public struct GoalRow: Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// „1.980 € von 3.000 €“
    public let amount: String
    /// 0…1
    public let progress: Double
    public let detail: String
    public let onTrack: Bool

    public init(_ g: GoalForecast) {
        id = g.potId
        name = g.name
        amount = "\(Money.format(g.savedCents)) von \(Money.format(g.targetCents))"
        progress = min(1, max(0, Double(g.progressBp) / 10_000))
        let target = g.targetMonth.map { " (Ziel: \($0.title))" } ?? ""
        let needed = g.requiredMonthlyCents.map { "Nötig: \(Money.format($0)) im Monat." }
        switch g.status {
        case .erreicht:
            detail = "Erreicht."
            onTrack = true
        case .imPlan:
            let when = g.projectedMonth.map { "Bei heutiger Sparrate erreicht im \($0.title)" } ?? "Im Plan"
            detail = "\(when)\(target)."
            onTrack = true
        case .verspaetet:
            let when = g.projectedMonth.map { "Bei heutiger Sparrate erst im \($0.title)" } ?? "Verspätet"
            detail = ["\(when)\(target).", needed].compactMap { $0 }.joined(separator: " ")
            onTrack = false
        case .ohneSparrate:
            detail = ["Noch keine Sparrate in den letzten 3 Monaten.", needed].compactMap { $0 }.joined(separator: " ")
            onTrack = false
        }
    }
}

/// Zeile eines Besitzes mit seinen Kosten.
public struct AssetRow: Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// Kosten im Zeitraum, z. B. „1.234 €“
    public let cost: String
    /// „Ø 103 € im Monat · davon wiederkehrend 800 €“
    public let detail: String
    /// „Verbindlichkeit“ usw.
    public let classification: String
    public let isLiability: Bool
    /// „Kostet 12 % seines Werts im Jahr“; nil ohne Wert
    public let valueNote: String?
    public let pots: [String]

    public init(_ a: AssetCosts) {
        id = a.assetId
        name = a.name
        cost = Money.format(a.costCents)
        var parts = ["Ø \(Money.format(a.monthlyAverageCents)) im Monat"]
        if a.recurringCostCents != 0 { parts.append("davon wiederkehrend \(Money.format(a.recurringCostCents))") }
        detail = parts.joined(separator: " · ")
        switch a.classification {
        case .verbindlichkeit: classification = "Verbindlichkeit"
        case .vermoegenswert: classification = "Vermögenswert"
        case .neutral: classification = "Neutral"
        }
        isLiability = a.classification == .verbindlichkeit
        if let value = a.valueCents, let bp = a.annualCostOfValueBp {
            valueNote = bp >= 0
                ? "Wert \(Money.format(value)), kostet \(RatioText.format(bp)) davon im Jahr"
                : "Wert \(Money.format(value)), bringt \(RatioText.format(-bp)) davon im Jahr"
        } else {
            valueNote = a.valueCents.map { "Wert \(Money.format($0))" }
        }
        pots = a.pots.map { "\($0.name) \(Money.format($0.costCents))" }
    }
}

/// Alles, was die Auswertung eines Haushalts zeigt, fertig aufbereitet.
public struct AnalyticsState: Hashable, Sendable {
    public let period: ClosedRange<YearMonth>
    public let periodTitle: String
    public let tiles: [MetricTile]
    public let savingsRate: [TrendPoint]
    public let fixedCostShare: [TrendPoint]
    public let ageOfMoney: [TrendPoint]
    public let anomalies: [AnomalyRow]
    public let goals: [GoalRow]
    public let assets: [AssetRow]
    /// „Besitz kostet 2.345 €, 14 % des Konsums.“; nil ohne Besitz
    public let assetSummary: String?
    /// Satz unter dem Geldfluss, z. B. „7.350 € kamen herein, 6.900 € flossen hinaus.“
    public let flowSummary: String
    /// Hinweis, wenn Ein- oder Ausgänge noch nicht zugeordnet sind
    public let uncategorizedNote: String?

    /// - Parameters:
    ///   - summary: Kennzahlen des gewählten Zeitraums
    ///   - history: Kennzahlen der letzten bis zu 12 Monate (für Verlauf und Vergleich)
    public init(
        summary: Metrics, history: Metrics, flow: MoneyFlow, anomalies: [Anomaly], goals: [GoalForecast],
        ownership: OwnershipCosts?
    ) {
        period = summary.from...summary.to
        periodTitle = AnalyticsPeriod.title(period)
        let totals = summary.totals

        // Vergleich mit den Monaten vor dem Zeitraum (nur solche mit Wert).
        let before = history.months.filter { $0.month < summary.from }
        let rates = before.compactMap(\.values.savingsRateBp)
        let rateDetail: String
        var rateTone = MetricTile.Tone.neutral
        if let rate = totals.savingsRateBp, !rates.isEmpty {
            let average = rates.reduce(0, +) / rates.count
            rateDetail = "\(RatioText.points(rate - average)) zum Schnitt davor"
            rateTone = rate >= average ? .good : .warning
        } else if totals.incomeCents > 0 {
            rateDetail = "\(Money.format(totals.savedCents)) von \(Money.format(totals.incomeCents)) gespart"
        } else {
            rateDetail = "Noch kein Einkommen zugeordnet"
        }

        let fixedDetail = totals.incomeCents > 0
            ? "\(Money.format(totals.fixedCostsCents)) von \(Money.format(totals.incomeCents))"
            : "Noch kein Einkommen zugeordnet"

        let runway = summary.runway
        let runwayValue: String
        let runwayDetail: String
        if let months = runway.months {
            let tenths = Int((months * 10).rounded())
            runwayValue = tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10),\(tenths % 10)"
            runwayDetail = runway.fixedContributionsCents > 0
                ? "ohne Einkommen, mit \(Money.format(runway.fixedContributionsCents)) Einzahlung im Monat"
                : "ohne Einkommen, bei heutigen Ausgaben"
        } else {
            runwayValue = "–"
            runwayDetail = "Braucht einen abgeschlossenen Monat mit Ausgaben"
        }

        let ages = history.months.filter { $0.month <= summary.to }
        let age = ages.last?.ageOfMoneyDays
        var ageDetail = "Wie lange ausgegebenes Geld schon da war"
        var ageTone = MetricTile.Tone.neutral
        if let age, ages.count >= 2, let prior = ages.dropLast().last, let previous = prior.ageOfMoneyDays {
            let delta = age - previous
            let sign = delta > 0 ? "+" : delta < 0 ? Money.minus : "±"
            ageDetail = "\(sign)\(delta.magnitude) \(delta.magnitude == 1 ? "Tag" : "Tage") seit \(prior.month.name)"
            ageTone = delta >= 0 ? .good : .warning
        }

        tiles = [
            MetricTile(id: "sparquote", title: "Sparquote", value: RatioText.format(totals.savingsRateBp), unit: nil,
                       detail: rateDetail, tone: rateTone),
            MetricTile(id: "fixkosten", title: "Fixkosten am Einkommen", value: RatioText.format(totals.fixedCostShareBp),
                       unit: nil, detail: fixedDetail, tone: .neutral),
            MetricTile(id: "runway", title: "Runway", value: runwayValue, unit: runway.months == nil ? nil : "Monate",
                       detail: runwayDetail, tone: .neutral),
            MetricTile(id: "alter", title: "Alter des Geldes", value: age.map(String.init) ?? "–",
                       unit: age == nil ? nil : (age == 1 ? "Tag" : "Tage"), detail: ageDetail, tone: ageTone),
        ]

        let shown = history.months.filter { $0.month <= summary.to }
        let last = shown.last?.month
        savingsRate = shown.map { m in
            TrendPoint(month: m.month, label: GermanDates.monthShort[m.month.month - 1],
                       value: m.values.savingsRateBp.map(RatioText.value), text: RatioText.format(m.values.savingsRateBp),
                       isCurrent: m.month == last)
        }
        fixedCostShare = shown.map { m in
            TrendPoint(month: m.month, label: GermanDates.monthShort[m.month.month - 1],
                       value: m.values.fixedCostShareBp.map(RatioText.value), text: RatioText.format(m.values.fixedCostShareBp),
                       isCurrent: m.month == last)
        }
        ageOfMoney = shown.map { m in
            TrendPoint(month: m.month, label: GermanDates.monthShort[m.month.month - 1],
                       value: m.ageOfMoneyDays.map(Double.init), text: m.ageOfMoneyDays.map { "\($0) T" } ?? "–",
                       isCurrent: m.month == last)
        }

        self.anomalies = anomalies.enumerated().map { AnomalyRow($0.element, index: $0.offset) }
        self.goals = goals.map(GoalRow.init)
        assets = ownership?.items.map(AssetRow.init) ?? []
        if let ownership, !ownership.items.isEmpty {
            var text = "Besitz kostet \(Money.format(ownership.totalCostCents)) im Zeitraum"
            if let share = ownership.shareOfConsumptionBp { text += ", \(RatioText.format(share)) des Konsums" }
            assetSummary = text + "."
        } else {
            assetSummary = nil
        }

        flowSummary = flow.links.isEmpty
            ? "Im Zeitraum ist noch nichts geflossen."
            : "\(Money.format(flow.inCents)) kamen herein, \(Money.format(flow.outCents)) flossen hinaus."
        var notes: [String] = []
        if totals.uncategorizedInCents > 0 { notes.append("\(Money.format(totals.uncategorizedInCents)) Eingänge") }
        if totals.uncategorizedOutCents > 0 { notes.append("\(Money.format(totals.uncategorizedOutCents)) Ausgänge") }
        uncategorizedNote = notes.isEmpty ? nil
            : "Noch nicht zugeordnet: \(notes.joined(separator: " und ")). Eingänge zählen erst als Einkommen, wenn sie zugeordnet sind."
    }
}

/// Was die Menüleiste am Mac zeigt.
public struct MenuBarState: Hashable, Sendable {
    /// Text neben dem Symbol: „215 €“
    public let label: String
    /// „Noch ohne Aufgabe“ in Cent
    public let readyToAssignCents: Int
    public let readyToAssign: String
    public let householdLabel: String
    /// „4 Buchungen warten“; nil ohne wartende
    public let pending: String?
    public let pendingCount: Int
    /// Nächste Auffälligkeit des Monats; nil ohne
    public let nextAnomaly: String?
    /// Weitere Auffälligkeiten: „und 2 weitere“
    public let moreAnomalies: String?

    public init(budget: BudgetMonth?, household: Household?, pendingCount: Int, anomalies: [Anomaly]) {
        readyToAssignCents = budget?.readyToAssignCents ?? 0
        readyToAssign = budget.map { Money.format($0.readyToAssignCents) } ?? "–"
        label = budget.map { Money.format($0.readyToAssignCents) } ?? "Freiraum"
        householdLabel = household?.shortLabel ?? ""
        self.pendingCount = pendingCount
        pending = PendingText.title(pendingCount)
        nextAnomaly = anomalies.first?.title
        moreAnomalies = anomalies.count > 1 ? "und \(anomalies.count - 1) weitere" : nil
    }
}
