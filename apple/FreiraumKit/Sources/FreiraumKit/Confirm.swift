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
    /// Sieht nach einer Abhebung am Automaten aus
    public let isWithdrawal: Bool
    /// Abhebung, die noch nicht ins Bargeld gebucht ist: die App bietet „Ins Bargeld“ an
    public let offersCash: Bool

    /// - Parameter accounts: Konten des Haushalts (für Namen von Gegenkonten und das Bargeldkonto)
    public init(
        transaction t: Transaction, account: Account?, household: Household?, pots: [Pot],
        accounts: [Account] = [], today: String? = nil
    ) {
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
            suggestion = ConfirmCard.label(s.target, pots: pots, accounts: accounts)
            reason = s.reason.isEmpty ? nil : s.reason
            confidence = s.confidencePct >= 90 ? "sicher" : s.confidencePct >= 60 ? "ziemlich sicher" : "unsicher"
        } else {
            suggestion = nil
            reason = "Noch kein Vorschlag. Ordne die Buchung selbst zu, daraus wird eine Regel."
            confidence = nil
        }
        canConfirm = t.status == .vorgeschlagen && t.suggestion != nil
        let withdrawal = ConfirmCard.looksLikeWithdrawal(t)
        let cashIds = Set(accounts.filter { $0.source == .bar }.map(\.id))
        var bookedAsCash = false
        if case let .transferTo(id)? = t.suggestion?.target {
            bookedAsCash = cashIds.contains(id)
        }
        let offers = withdrawal && !bookedAsCash
        isWithdrawal = withdrawal
        offersCash = offers
        if offers {
            note = "Bargeld ist noch keine Ausgabe: ins Bargeld buchen und Ausgaben später mit dem Plus erfassen."
        } else if withdrawal {
            note = "Zählt als Bargeld, bis du Ausgaben mit dem Plus erfasst."
        } else {
            note = nil
        }
    }

    /// Abhebung am Automaten: ein Ausgang mit typischen Wörtern in Gegenpartei oder Zweck.
    public static func looksLikeWithdrawal(_ t: Transaction) -> Bool {
        guard t.amountCents < 0 else { return false }
        let text = "\(t.counterpartyName ?? "") \(t.purpose ?? "")".lowercased()
        return ["bargeld", "geldautomat", "auszahlung", "abhebung"].contains { text.contains($0) }
    }

    /// Anzeigename eines Ziels.
    public static func label(_ target: SplitTarget, pots: [Pot], accounts: [Account] = []) -> String {
        switch target {
        case let .pot(id):
            return pots.first { $0.id == id }?.name ?? "Unbekannter Topf"
        case .income:
            return "Einnahme"
        case .transfer:
            return "Umbuchung"
        case let .transferTo(id):
            guard let account = accounts.first(where: { $0.id == id }) else { return "Umbuchung" }
            return account.source == .bar ? "Ins Bargeld" : "Umbuchung → \(account.name)"
        }
    }
}

/// Mögliche Ziele für eine Buchung: aktive Töpfe des Haushalts, Einnahme, Umbuchung.
public struct TargetOption: Hashable, Sendable, Identifiable {
    public var id: SplitTarget { target }
    public let target: SplitTarget
    public let label: String
    public let group: String

    /// - Parameter cashAccounts: Bargeldkonten des Haushalts; bei Ausgängen gibt es „Ins Bargeld“
    public static func options(pots: [Pot], forIncome: Bool, cashAccounts: [Account] = []) -> [TargetOption] {
        let active = pots.filter { !$0.archived }.sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
        var result = active.map { TargetOption(target: .pot($0.id), label: $0.name, group: $0.groupName ?? "Töpfe") }
        let cash = forIncome ? [] : cashAccounts.filter { $0.source == .bar }
        var special = cash.map {
            TargetOption(
                target: .transferTo($0.id), label: cash.count == 1 ? "Ins Bargeld" : "Ins Bargeld (\($0.name))",
                group: "Sonstiges"
            )
        }
        special += [
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
