/// Was die Übersicht eines Haushalts zeigt, fertig aufbereitet (ohne SwiftUI, damit testbar).
public struct OverviewState: Hashable, Sendable {
    public enum Tone: Hashable, Sendable {
        /// genug da
        case ok
        /// höchstens ein Fünftel übrig
        case low
        /// überzogen
        case overspent
    }

    public struct PotRow: Hashable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// z. B. „noch 62 € von 150 €“
        public let detail: String
        /// rechts: verfügbarer Betrag
        public let available: String
        /// Füllstand 0…1
        public let progress: Double
        public let tone: Tone
    }

    public struct ErstIchRow: Hashable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let amount: String
        /// Plan für den Monat erfüllt
        public let done: Bool
    }

    public let month: YearMonth
    public let householdLabel: String
    /// „Noch ohne Aufgabe“ in Cent
    public let readyToAssignCents: Int
    public let readyToAssign: String
    public let pendingCount: Int
    public let erstIch: [ErstIchRow]
    /// Alle Erst-ich-Töpfe mit Plan sind gefüllt
    public let erstIchDone: Bool
    public let pots: [PotRow]
    /// Töpfe, denen laut Plan noch Geld fehlt (für „Verteilen“)
    public let neededCents: Int
    public let closed: Bool

    public init(budget: BudgetMonth, household: Household, pots: [Pot], pendingCount: Int) {
        let info = Dictionary(pots.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let order = Dictionary(pots.map { ($0.id, $0.sortOrder) }, uniquingKeysWith: { a, _ in a })
        let visible = budget.pots
            .filter { !$0.archived || $0.availableCents != 0 || $0.activityCents != 0 }
            .sorted { (order[$0.potId] ?? .max, $0.name) < (order[$1.potId] ?? .max, $1.name) }

        month = budget.month
        householdLabel = household.shortLabel
        readyToAssignCents = budget.readyToAssignCents
        readyToAssign = Money.number(budget.readyToAssignCents)
        self.pendingCount = pendingCount
        closed = budget.closed

        let erst = visible.filter { $0.kind == .erstIch }
        erstIch = erst.map {
            ErstIchRow(
                id: $0.potId, name: $0.name, amount: Money.format($0.assignedCents),
                done: $0.planCents > 0 && $0.neededCents == 0
            )
        }
        erstIchDone = !erst.isEmpty && erst.allSatisfy { $0.planCents == 0 || $0.neededCents == 0 }
        self.pots = visible.filter { $0.kind != .erstIch }.map { Self.row($0, pot: info[$0.potId]) }
        neededCents = visible.reduce(0) { $0 + max(0, $1.neededCents) }
    }

    static func row(_ b: BudgetPot, pot: Pot?) -> PotRow {
        let available = b.availableCents
        let detail: String
        let progress: Double
        var tone: Tone = .ok

        switch b.kind {
        case .ruecklage, .ziel:
            // Ziel bzw. Jahresbetrag aus dem Topf, sonst nur der Stand.
            let goal = pot?.amountCents ?? 0
            if goal > 0 {
                var text = "\(Money.format(max(0, available))) von \(Money.format(goal))"
                if b.kind == .ziel, let target = pot?.targetMonth { text += " bis \(target.name) \(target.year)" }
                if b.kind == .ruecklage { text += " im Jahr" }
                detail = text
                progress = Double(max(0, available)) / Double(goal)
            } else {
                detail = b.kind == .ziel ? "Ziel ohne Betrag" : "Rücklage"
                progress = available > 0 ? 1 : 0
            }
        case .monatlich, .erstIch:
            let base = b.carryoverCents + b.assignedCents
            if base > 0 {
                detail = "noch \(Money.format(max(0, available))) von \(Money.format(base))"
                progress = Double(max(0, available)) / Double(base)
                if progress <= 0.2 { tone = .low }
            } else if b.activityCents == 0 {
                detail = b.planCents > 0 ? "Plan: \(Money.format(b.planCents))" : "nichts zugewiesen"
                progress = 0
            } else {
                detail = "ohne Zuweisung"
                progress = 0
            }
        }
        if available < 0 {
            tone = .overspent
            return PotRow(
                id: b.potId, name: b.name, detail: "\(Money.format(-available)) überzogen",
                available: Money.format(available), progress: 1, tone: tone
            )
        }
        return PotRow(
            id: b.potId, name: b.name, detail: detail, available: Money.format(available),
            progress: min(1, max(0, progress)), tone: tone
        )
    }
}

/// Text für „Buchungen warten“ (Übersicht, Benachrichtigung, Widget).
public enum PendingText {
    /// „4 Buchungen warten“ / „1 Buchung wartet“ / nil bei 0
    public static func title(_ count: Int) -> String? {
        switch count {
        case ..<1: nil
        case 1: "1 Buchung wartet"
        default: "\(count) Buchungen warten"
        }
    }

    /// Geschätzte Dauer: etwa 10 Sekunden je Buchung, aufgerundet auf Minuten.
    public static func estimate(_ count: Int) -> String {
        let minutes = max(1, (count * 10 + 59) / 60)
        return minutes == 1 ? "etwa 1 Minute" : "etwa \(minutes) Minuten"
    }

    public static func subtitle(_ count: Int, withSuggestions: Int) -> String {
        let ready = withSuggestions == count ? "Vorschläge sind fertig" :
            withSuggestions == 0 ? "Noch ohne Vorschlag" : "\(withSuggestions) mit Vorschlag"
        return "\(ready) · \(estimate(count))"
    }
}
