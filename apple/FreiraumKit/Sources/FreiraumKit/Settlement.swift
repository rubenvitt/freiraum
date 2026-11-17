import Foundation

/// Ausgleich im gemeinsamen Haushalt (`GET /v1/households/{id}/settlements`). Forderung: Eine
/// Person hat privat etwas Gemeinsames bezahlt. Schuld: Das gemeinsame Konto hat etwas Privates
/// einer Person bezahlt. Beides verrechnet sich zum Saldo je Person.
public struct Settlements: Hashable, Sendable, Codable {
    public struct Balance: Hashable, Sendable, Codable, Identifiable {
        public var id: String { personId }
        public let personId: String
        public let displayName: String
        /// privat bezahlte gemeinsame Ausgaben
        public let claimedCents: Int
        /// davon erstattet (Überweisung, von Hand)
        public let repaidCents: Int
        /// vom gemeinsamen Konto bezahlte private Ausgaben
        public let debtCents: Int
        /// davon zurückgezahlt
        public let paidBackCents: Int
        /// Saldo: positiv = das Gemeinsame schuldet der Person, negativ = die Person dem Gemeinsamen
        public let openCents: Int

        public init(
            personId: String, displayName: String, claimedCents: Int = 0, repaidCents: Int = 0,
            debtCents: Int = 0, paidBackCents: Int = 0, openCents: Int
        ) {
            self.personId = personId
            self.displayName = displayName
            self.claimedCents = claimedCents
            self.repaidCents = repaidCents
            self.debtCents = debtCents
            self.paidBackCents = paidBackCents
            self.openCents = openCents
        }
    }

    /// Offene Forderung oder offene Schuld aus einer Buchung.
    public struct Item: Hashable, Sendable, Codable, Identifiable {
        public var id: String { transactionId }
        public let transactionId: String
        public let personId: String
        public let bookingDate: String
        public let counterpartyName: String?
        /// Anteil der Buchung (ohne Vorzeichen gemeint: was die Person ausgelegt hat bzw. schuldet)
        public let amountCents: Int
        public let openCents: Int

        public init(
            transactionId: String, personId: String, bookingDate: String, counterpartyName: String? = nil,
            amountCents: Int, openCents: Int
        ) {
            self.transactionId = transactionId
            self.personId = personId
            self.bookingDate = bookingDate
            self.counterpartyName = counterpartyName
            self.amountCents = amountCents
            self.openCents = openCents
        }
    }

    /// Von Hand verbuchter Ausgleich: Geld außerhalb der Konten (z. B. bar) oder mit der
    /// Einzahlung verrechnet (FREI-28).
    public struct Manual: Hashable, Sendable, Codable, Identifiable {
        public enum Kind: String, Hashable, Sendable, Codable { case zahlung, verrechnung }

        public let id: String
        public let personId: String
        public let kind: Kind
        /// positiv = das Gemeinsame erstattet der Person; negativ = die Person zahlt zurück (nur bei Verrechnung)
        public let amountCents: Int
        public let settledOn: String
        public let note: String?

        public init(id: String, personId: String, kind: Kind = .zahlung, amountCents: Int, settledOn: String, note: String? = nil) {
            self.id = id
            self.personId = personId
            self.kind = kind
            self.amountCents = amountCents
            self.settledOn = settledOn
            self.note = note
        }
    }

    public let householdId: String
    public let balances: [Balance]
    /// Forderungen: privat bezahlte gemeinsame Ausgaben, noch nicht erstattet
    public let openItems: [Item]
    /// Schulden: private Ausgaben vom gemeinsamen Konto, noch nicht zurückgezahlt
    public let openDebts: [Item]
    public let manual: [Manual]

    public init(householdId: String, balances: [Balance], openItems: [Item] = [], openDebts: [Item] = [], manual: [Manual] = []) {
        self.householdId = householdId
        self.balances = balances
        self.openItems = openItems
        self.openDebts = openDebts
        self.manual = manual
    }
}

/// Was die App zum Ausgleich zeigt, fertig aufbereitet (ohne SwiftUI, damit testbar).
/// Aus Sicht der angemeldeten Person: „du“ statt des eigenen Namens.
public struct SettlementState: Hashable, Sendable {
    public enum Direction: Hashable, Sendable {
        /// Das Gemeinsame schuldet der Person etwas.
        case owedToPerson
        /// Die Person schuldet dem Gemeinsamen etwas.
        case personOwes
        case settled
    }

    public struct BalanceRow: Hashable, Sendable, Identifiable {
        public let id: String
        /// „Du“ oder der Name
        public let name: String
        public let isMe: Bool
        public let direction: Direction
        /// „Das Gemeinsame schuldet dir 23,40 €“, „Alisa schuldet dem Gemeinsamen 12 €“, „Du bist ausgeglichen“
        public let sentence: String
        /// Saldo ohne Vorzeichen, z. B. „23,40 €“; leer, wenn ausgeglichen
        public let amount: String
        /// „ausgelegt 50 € · erstattet 20 € · …“, nur Werte ungleich 0
        public let detail: String?
        /// Wie sich der Saldo erledigt
        public let hint: String?
    }

    public struct ItemRow: Hashable, Sendable, Identifiable {
        public let id: String
        public let title: String
        /// „Di, 3. Nov · Alisa“
        public let subtitle: String
        /// offener Betrag, z. B. „12,00 €“
        public let open: String
        /// „von 30,00 €“, wenn schon ein Teil erledigt ist
        public let ofTotal: String?
    }

    public struct ManualRow: Hashable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let subtitle: String
        public let amount: String
        /// Eigener Eintrag: lässt sich zurücknehmen (fremde lehnt der Server mit 403 ab).
        public let deletable: Bool
        /// Mit der Einzahlung verrechnet: Zurücknehmen ändert Ist und privates Budget.
        public let isOffset: Bool
    }

    public let balances: [BalanceRow]
    /// Kurzfassung für die Übersicht, z. B. „Du schuldest dem Gemeinsamen 12 €“
    public let summary: String
    public let allSettled: Bool
    public let claims: [ItemRow]
    public let debts: [ItemRow]
    public let manual: [ManualRow]

    public init(_ s: Settlements, me: Person?, today: String? = nil) {
        let names = Dictionary(s.balances.map { ($0.personId, $0.displayName) }, uniquingKeysWith: { a, _ in a })
        func name(_ personId: String) -> String {
            personId == me?.id ? "Du" : names[personId] ?? "Unbekannt"
        }

        // Eigene Zeile zuerst, dann wie geliefert.
        let ordered = s.balances.filter { $0.personId == me?.id } + s.balances.filter { $0.personId != me?.id }
        balances = ordered.map { Self.row($0, isMe: $0.personId == me?.id) }
        allSettled = s.balances.allSatisfy { $0.openCents == 0 }

        let mine = balances.first { $0.isMe }
        let others = balances.filter { !$0.isMe && $0.direction != .settled }
        if allSettled {
            summary = "Alles ausgeglichen"
        } else if let mine, mine.direction != .settled {
            summary = mine.sentence
        } else if let first = others.first {
            summary = first.sentence
        } else {
            summary = "Alles ausgeglichen"
        }

        func item(_ i: Settlements.Item) -> ItemRow {
            let title = i.counterpartyName?.trimmed
            let day = GermanDates.bookingDay(i.bookingDate, today: today)
            let open = abs(i.openCents)
            let total = abs(i.amountCents)
            return ItemRow(
                id: i.transactionId,
                title: title.flatMap { $0.isEmpty ? nil : $0 } ?? "Ohne Angaben",
                subtitle: "\(day) · \(name(i.personId))",
                open: Money.format(open, style: .exact),
                ofTotal: open == total ? nil : "von \(Money.format(total, style: .exact))"
            )
        }
        claims = s.openItems.map(item)
        debts = s.openDebts.map(item)
        manual = s.manual.map { m in
            let what: String
            switch (m.kind, m.amountCents < 0) {
            case (.zahlung, _): what = "Erstattung erhalten"
            case (.verrechnung, false): what = "Erstattung mit Einzahlung verrechnet"
            case (.verrechnung, true): what = "Rückzahlung mit Einzahlung verrechnet"
            }
            let note = m.note.map(\.trimmed).flatMap { $0.isEmpty ? nil : $0 }
            return ManualRow(
                id: m.id,
                title: note ?? what,
                subtitle: "\(GermanDates.bookingDay(m.settledOn, today: today)) · \(name(m.personId))"
                    + (note == nil ? "" : " · \(what)"),
                amount: Money.format(abs(m.amountCents), style: .exact),
                deletable: me != nil && m.personId == me?.id,
                isOffset: m.kind == .verrechnung
            )
        }
    }

    static func row(_ b: Settlements.Balance, isMe: Bool) -> BalanceRow {
        let who = isMe ? "Du" : b.displayName
        let amount = Money.format(abs(b.openCents), style: .exact)
        let direction: Direction = b.openCents > 0 ? .owedToPerson : b.openCents < 0 ? .personOwes : .settled
        let sentence: String
        let hint: String?
        switch direction {
        case .owedToPerson:
            sentence = "Das Gemeinsame schuldet \(isMe ? "dir" : b.displayName) \(amount)"
            hint = "Erstattung per Überweisung vom gemeinsamen Konto, beim Bestätigen als Erstattung zuordnen."
        case .personOwes:
            sentence = "\(who) \(isMe ? "schuldest" : "schuldet") dem Gemeinsamen \(amount)"
            hint = isMe
                ? "Überweise den Betrag aufs gemeinsame Konto und ordne die Überweisung beim Bestätigen als Rückzahlung zu, nicht als Einzahlung."
                : "Rückzahlung per Überweisung aufs gemeinsame Konto."
        case .settled:
            sentence = "\(who) \(isMe ? "bist" : "ist") ausgeglichen"
            hint = nil
        }
        var parts: [String] = []
        if b.claimedCents != 0 { parts.append("ausgelegt \(Money.format(b.claimedCents))") }
        if b.repaidCents != 0 { parts.append("erstattet \(Money.format(b.repaidCents))") }
        if b.debtCents != 0 { parts.append("vom gemeinsamen Konto \(Money.format(b.debtCents))") }
        if b.paidBackCents != 0 { parts.append("zurückgezahlt \(Money.format(b.paidBackCents))") }
        return BalanceRow(
            id: b.personId, name: who, isMe: isMe, direction: direction, sentence: sentence,
            amount: direction == .settled ? "" : amount,
            detail: parts.isEmpty ? nil : parts.joined(separator: " · "), hint: hint
        )
    }
}

// MARK: - Von Hand verbuchen

/// Ausgleich von Hand zum Senden (`POST /v1/households/{id}/settlements`). Der Betrag ist immer
/// positiv; die Richtung einer Verrechnung ergibt der Server aus dem Saldo.
public struct SettlementInput: Hashable, Sendable {
    public let amountCents: Int
    public let kind: Settlements.Manual.Kind
    public let settledOn: String
    public let note: String?

    public init(amountCents: Int, kind: Settlements.Manual.Kind, settledOn: String, note: String? = nil) {
        self.amountCents = amountCents
        self.kind = kind
        self.settledOn = settledOn
        self.note = note
    }
}

/// Eingabe „Von Hand verbuchen“ für den eigenen Saldo. Gibt es nur, wenn er offen ist:
/// - Forderung (das Gemeinsame schuldet mir): bar erhalten oder mit der Einzahlung verrechnen.
/// - Schuld (ich schulde dem Gemeinsamen): nur mit der Einzahlung verrechnen; eine Rückzahlung
///   außerhalb der Konten bestätigt sonst niemand.
/// Höchstens so viel, wie offen ist (sonst 422 vom Server).
public struct SettlementDraft: Hashable, Sendable, Identifiable {
    /// Es gibt höchstens einen Entwurf zugleich (für `.sheet(item:)`).
    public var id: String { "ausgleich" }
    /// Eigener Saldo: positiv = Forderung, negativ = Schuld
    public let openCents: Int
    public var kind: Settlements.Manual.Kind
    /// Euro, vorbelegt mit dem ganzen offenen Betrag
    public var amountText: String
    /// Tag als JJJJ-MM-TT; bei einer Verrechnung zählt sein Monat für Ist und Budget
    public var settledOn: String
    public var note: String = ""

    /// nil, wenn der eigene Saldo ausgeglichen ist oder die Person nicht im Haushalt ist.
    public init?(_ s: Settlements, me: Person?, today: String = GermanDates.isoDate(Date())) {
        guard let me, let open = s.balances.first(where: { $0.personId == me.id })?.openCents, open != 0 else {
            return nil
        }
        openCents = open
        kind = open > 0 ? .zahlung : .verrechnung
        amountText = Money.number(abs(open))
        settledOn = today
    }

    /// Höchstbetrag in Cent
    public var maxCents: Int { abs(openCents) }

    public var isClaim: Bool { openCents > 0 }

    /// Was zur Wahl steht: bei einer Forderung beides, bei einer Schuld nur die Verrechnung.
    public var kinds: [Settlements.Manual.Kind] { isClaim ? [.zahlung, .verrechnung] : [.verrechnung] }

    /// Titel der Ansicht und des Knopfs
    public var title: String {
        isClaim ? "Erstattung verbuchen" : "Rückzahlung verrechnen"
    }

    public static func title(_ kind: Settlements.Manual.Kind) -> String {
        switch kind {
        case .zahlung: "Bar erhalten"
        case .verrechnung: "Mit Einzahlung verrechnen"
        }
    }

    /// Erklärung unter der Auswahl, je nach Art und Richtung
    public var hint: String {
        switch (kind, isClaim) {
        case (.zahlung, _):
            return "Für Geld, das du außerhalb der Konten bekommen hast, z. B. bar. Dein Budget ändert sich dadurch nicht."
        case (.verrechnung, true):
            return "Statt einer Erstattung zählt der Betrag als Einzahlung ins Gemeinsame, im Monat des Tags: 450 € überwiesen + 50 € verrechnet = 500 € Ist. Dein privates Budget rechnet das mit."
        case (.verrechnung, false):
            return "Ein Teil deiner Einzahlung zählt als Rückzahlung, im Monat des Tags: 500 € überwiesen − 50 € verrechnet = 450 € Ist. Dein privates Budget rechnet das mit."
        }
    }

    private var isAmountEmpty: Bool { amountText.trimmingCharacters(in: .whitespaces).isEmpty }

    public var amountCents: Int? {
        guard let cents = Money.parse(amountText), cents > 0 else { return nil }
        return cents
    }

    /// Was noch fehlt oder nicht passt, in einem Satz; nil = bereit.
    public var problem: String? {
        if isAmountEmpty { return isClaim ? "Wie viel hast du erhalten?" : "Wie viel verrechnest du?" }
        guard let cents = amountCents else { return "Den Betrag verstehe ich nicht, z. B. 20 oder 12,50." }
        if cents > maxCents { return "Offen sind nur \(Money.format(maxCents, style: .exact))." }
        if !kinds.contains(kind) { return "Eine Rückzahlung lässt sich nur mit der Einzahlung verrechnen." }
        if note.count > 300 { return "Die Notiz ist zu lang (höchstens 300 Zeichen)." }
        return nil
    }

    public var input: SettlementInput? {
        guard problem == nil, let cents = amountCents else { return nil }
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return SettlementInput(amountCents: cents, kind: kind, settledOn: settledOn, note: text.isEmpty ? nil : text)
    }
}
