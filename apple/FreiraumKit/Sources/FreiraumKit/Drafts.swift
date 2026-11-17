import Foundation

/// Eine Barausgabe, bereit zum Senden. Die `clientId` entsteht einmal je Eingabe und schützt
/// vor doppelten Buchungen, wenn die App nach einem Netzfehler erneut sendet.
public struct CashExpense: Hashable, Sendable, Codable {
    public let clientId: String
    public let bookingDate: String
    public let amountCents: Int
    public let description: String?
    public let potId: String

    public init(clientId: String, bookingDate: String, amountCents: Int, description: String?, potId: String) {
        self.clientId = clientId
        self.bookingDate = bookingDate
        self.amountCents = amountCents
        self.description = description
        self.potId = potId
    }
}

/// Eingabe „Barausgabe erfassen“: Betrag als Text, wofür, Topf, Tag.
public struct CashExpenseDraft: Hashable, Sendable {
    public let clientId: String
    public var amountText: String = ""
    public var description: String = ""
    public var potId: String?
    public var bookingDate: String

    public init(clientId: String = UUID().uuidString.lowercased(), bookingDate: String = GermanDates.isoDate(Date())) {
        self.clientId = clientId
        self.bookingDate = bookingDate
    }

    public var amountCents: Int? {
        guard let cents = Money.parse(amountText), cents > 0 else { return nil }
        return cents
    }

    /// Was noch fehlt, in einem Satz; nil = bereit.
    public var problem: String? {
        if amountText.trimmingCharacters(in: .whitespaces).isEmpty { return "Wie viel hast du ausgegeben?" }
        if amountCents == nil { return "Den Betrag verstehe ich nicht, z. B. 4,50." }
        if potId == nil { return "Aus welchem Topf?" }
        return nil
    }

    public var expense: CashExpense? {
        guard let amountCents, let potId else { return nil }
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        return CashExpense(
            clientId: clientId, bookingDate: bookingDate, amountCents: amountCents,
            description: text.isEmpty ? nil : String(text.prefix(300)), potId: potId
        )
    }
}

/// Aufteilung einer Buchung auf mehrere Ziele. Die Person gibt Beträge ohne Vorzeichen ein;
/// das Vorzeichen kommt von der Buchung (Ausgabe negativ, Eingang positiv).
public struct SplitDraft: Hashable, Sendable {
    public struct Row: Hashable, Sendable, Identifiable {
        public let id: UUID
        public var target: SplitTarget?
        public var amountText: String

        public init(id: UUID = UUID(), target: SplitTarget? = nil, amountText: String = "") {
            self.id = id
            self.target = target
            self.amountText = amountText
        }

        var cents: Int? { Money.parse(amountText) }
    }

    public let transactionAmountCents: Int
    public var rows: [Row]

    /// Start: Vorschlag (falls vorhanden) mit dem ganzen Betrag, dazu eine leere Zeile.
    public init(transaction: Transaction) {
        transactionAmountCents = transaction.amountCents
        let total = Money.number(abs(transaction.amountCents), style: .exact)
        rows = [Row(target: transaction.suggestion?.target, amountText: total), Row()]
    }

    /// Betrag der Buchung ohne Vorzeichen.
    public var totalCents: Int { abs(transactionAmountCents) }

    /// Summe der eingegebenen Beträge (ohne Vorzeichen); ungültige Zeilen zählen nicht.
    public var enteredCents: Int { rows.compactMap(\.cents).reduce(0, +) }

    /// Was noch zu verteilen ist (negativ = zu viel).
    public var remainingCents: Int { totalCents - enteredCents }

    /// Zeilen mit Betrag > 0.
    private var activeRows: [Row] { rows.filter { ($0.cents ?? 0) > 0 } }

    public var problem: String? {
        if rows.contains(where: { !$0.amountText.trimmingCharacters(in: .whitespaces).isEmpty && $0.cents == nil }) {
            return "Ein Betrag ist ungültig, z. B. 4,50."
        }
        if activeRows.isEmpty { return "Mindestens ein Betrag ist nötig." }
        if activeRows.contains(where: { $0.target == nil }) { return "Jeder Betrag braucht ein Ziel." }
        if remainingCents > 0 { return "Noch \(Money.format(remainingCents)) zu verteilen." }
        if remainingCents < 0 { return "\(Money.format(-remainingCents)) zu viel verteilt." }
        return nil
    }

    /// Aufteilungen mit Vorzeichen der Buchung; gleiche Ziele werden zusammengefasst.
    public var splits: [Split]? {
        guard problem == nil else { return nil }
        let sign = transactionAmountCents < 0 ? -1 : 1
        var order: [SplitTarget] = []
        var sums: [SplitTarget: Int] = [:]
        for row in activeRows {
            guard let target = row.target, let cents = row.cents else { return nil }
            if sums[target] == nil { order.append(target) }
            sums[target, default: 0] += cents
        }
        return order.map { Split(target: $0, amountCents: sign * (sums[$0] ?? 0)) }
    }

    /// Rest in die erste leere Zeile übernehmen.
    public mutating func fillRemainder() {
        guard remainingCents > 0 else { return }
        let text = Money.number(remainingCents, style: .exact)
        if let i = rows.firstIndex(where: { $0.amountText.trimmingCharacters(in: .whitespaces).isEmpty }) {
            rows[i].amountText = text
        } else {
            rows.append(Row(amountText: text))
        }
    }
}
