import Foundation

/// Eine Karte im Ablauf „Buchungen bestätigen“.
public struct ConfirmCard: Hashable, Sendable, Identifiable {
    public let id: String
    /// „Mo, 16. Nov · Girokonto“
    public let when: String
    /// Gegenpartei, sonst Verwendungszweck
    public let title: String
    /// „−34,18 €“
    public let amount: String
    public let isIncome: Bool
    /// Vorschlag, z. B. „Lebensmittel“; nil = kein Vorschlag
    public let suggestion: String?
    /// „Ich“ oder „Gemeinsam“
    public let household: String
    public let isShared: Bool
    /// Begründung des Vorschlags in einem Satz
    public let reason: String?
    /// „sicher“, „ziemlich sicher“, „unsicher“
    public let confidence: String?
    /// Hinweis, z. B. bei Bargeldabhebung
    public let note: String?
    /// „Passt“ geht nur mit Vorschlag
    public let canConfirm: Bool

    public init(transaction t: Transaction, account: Account?, household: Household?, pots: [Pot], today: String? = nil) {
        id = t.id
        let day = GermanDates.bookingDay(t.bookingDate, today: today)
        when = account.map { "\(day) · \($0.name)" } ?? day
        let name = t.counterpartyName?.trimmed ?? t.purpose?.trimmed
        title = name.flatMap { $0.isEmpty ? nil : $0 } ?? "Ohne Angaben"
        amount = Money.format(t.amountCents, style: .exact, sign: true)
        isIncome = t.amountCents > 0
        self.household = household?.shortLabel ?? ""
        isShared = household?.kind == .gemeinsam
        if let s = t.suggestion {
            suggestion = ConfirmCard.label(s.target, pots: pots)
            reason = s.reason.isEmpty ? nil : s.reason
            confidence = s.confidencePct >= 90 ? "sicher" : s.confidencePct >= 60 ? "ziemlich sicher" : "unsicher"
        } else {
            suggestion = nil
            reason = "Noch kein Vorschlag. Ordne die Buchung selbst zu, daraus wird eine Regel."
            confidence = nil
        }
        canConfirm = t.status == .vorgeschlagen && t.suggestion != nil
        let text = "\(t.counterpartyName ?? "") \(t.purpose ?? "")".lowercased()
        if t.amountCents < 0 && (text.contains("bargeld") || text.contains("geldautomat") || text.contains("auszahlung")) {
            note = "Bargeld ist noch keine Ausgabe: als Umbuchung zuordnen und Ausgaben mit dem Plus erfassen."
        } else {
            note = nil
        }
    }

    /// Anzeigename eines Ziels.
    public static func label(_ target: SplitTarget, pots: [Pot]) -> String {
        switch target {
        case let .pot(id): pots.first { $0.id == id }?.name ?? "Unbekannter Topf"
        case .income: "Einnahme"
        case .transfer: "Umbuchung"
        }
    }
}

/// Mögliche Ziele für eine Buchung: aktive Töpfe des Haushalts, Einnahme, Umbuchung.
public struct TargetOption: Hashable, Sendable, Identifiable {
    public var id: SplitTarget { target }
    public let target: SplitTarget
    public let label: String
    public let group: String

    public static func options(pots: [Pot], forIncome: Bool) -> [TargetOption] {
        let active = pots.filter { !$0.archived }.sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
        var result = active.map { TargetOption(target: .pot($0.id), label: $0.name, group: $0.groupName ?? "Töpfe") }
        let special = [
            TargetOption(target: .income, label: "Einnahme", group: "Sonstiges"),
            TargetOption(target: .transfer, label: "Umbuchung", group: "Sonstiges"),
        ]
        result = forIncome ? special + result : result + special
        return result
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
