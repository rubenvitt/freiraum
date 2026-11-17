import Foundation

// Einzahlungen ins Gemeinsame (ADR 0006): Regel je Person, Soll und Ist je Monat, Freigaben.
// Alle Beträge in Cent, Anteile in Basispunkten (4000 = 40 %).

/// Einzahlungsregel einer Person fürs Gemeinsame, gültig ab einem Monat bis zur nächsten.
public struct ContributionRule: Hashable, Sendable, Codable {
    public enum Kind: String, Hashable, Sendable, Codable, CaseIterable {
        /// fester Betrag je Monat (0 = Pause)
        case fest
        /// Anteil der eigenen Einnahmen im Monat (Netto)
        case prozent

        public var title: String { self == .fest ? "Fester Betrag" : "Anteil vom Netto" }
    }

    public let householdId: String
    public let personId: String
    public let validFrom: YearMonth
    public let kind: Kind
    public let amountCents: Int?
    public let percentBp: Int?

    public init(
        householdId: String, personId: String, validFrom: YearMonth, kind: Kind,
        amountCents: Int? = nil, percentBp: Int? = nil
    ) {
        self.householdId = householdId
        self.personId = personId
        self.validFrom = validFrom
        self.kind = kind
        self.amountCents = amountCents
        self.percentBp = percentBp
    }

    /// „400 € im Monat“, „Pause“, „40 % vom Netto“
    public var text: String {
        switch kind {
        case .fest:
            let cents = amountCents ?? 0
            return cents == 0 ? "Pause" : "\(Money.format(cents)) im Monat"
        case .prozent:
            return "\(Percent.format(percentBp ?? 0)) vom Netto"
        }
    }

    /// Jüngste Regel der Person, die im Monat gilt (`validFrom` ≤ `month`).
    public static func active(in rules: [ContributionRule], personId: String, month: YearMonth) -> ContributionRule? {
        rules.filter { $0.personId == personId && $0.validFrom <= month }.max { $0.validFrom < $1.validFrom }
    }
}

/// Neue Regel zum Speichern.
public enum ContributionRuleInput: Hashable, Sendable {
    case fixed(cents: Int)
    case percent(bp: Int)

    public var kind: ContributionRule.Kind {
        switch self {
        case .fixed: .fest
        case .percent: .prozent
        }
    }
}

/// Soll und Ist einer Person in einem Monat.
public struct MemberContribution: Hashable, Sendable, Identifiable {
    public var id: String { personId }
    public let personId: String
    public let displayName: String
    /// Regel, die im Monat gilt; nil = keine
    public let rule: ContributionRule?
    /// Soll; nil ohne Regel oder ohne Freigabe
    public let targetCents: Int?
    /// false bei „Prozent vom Netto“ der anderen Person ohne Freigabe `einzahlung_soll`
    public let targetVisible: Bool
    /// Ist: Einzahlungen im Monat
    public let paidCents: Int
    /// Soll − Ist, ≥ 0; nil, wenn das Soll unbekannt ist
    public let remainingCents: Int?

    public init(
        personId: String, displayName: String, rule: ContributionRule?, targetCents: Int?,
        targetVisible: Bool, paidCents: Int, remainingCents: Int?
    ) {
        self.personId = personId
        self.displayName = displayName
        self.rule = rule
        self.targetCents = targetCents
        self.targetVisible = targetVisible
        self.paidCents = paidCents
        self.remainingCents = remainingCents
    }
}

public struct Contributions: Hashable, Sendable {
    public let householdId: String
    public let month: YearMonth
    public let members: [MemberContribution]

    public init(householdId: String, month: YearMonth, members: [MemberContribution]) {
        self.householdId = householdId
        self.month = month
        self.members = members
    }
}

// MARK: - Freigaben

/// Was eine Person der anderen aus ihrem privaten Haushalt zeigt (ADR 0006, „Freigaben“).
public enum ShareScope: String, Hashable, Sendable, Codable, CaseIterable {
    case erstIch = "erst_ich"
    case ruecklagen
    case einzahlungSoll = "einzahlung_soll"
    case budget
    case sparquote
}

public struct Share: Hashable, Sendable {
    /// Bei erteilten Freigaben die empfangende, bei erhaltenen die freigebende Person.
    public let personId: String
    public let displayName: String
    public let scope: ShareScope

    public init(personId: String, displayName: String, scope: ShareScope) {
        self.personId = personId
        self.displayName = displayName
        self.scope = scope
    }
}

public struct Shares: Hashable, Sendable {
    public let granted: [Share]
    public let received: [Share]

    public init(granted: [Share] = [], received: [Share] = []) {
        self.granted = granted
        self.received = received
    }

    public func hasGranted(_ scope: ShareScope, to personId: String) -> Bool {
        granted.contains { $0.scope == scope && $0.personId == personId }
    }
}

// MARK: - Darstellung

/// Anteile in Basispunkten als Text.
public enum Percent {
    /// 4000 → „40 %“, 1250 → „12,5 %“
    public static func format(_ bp: Int) -> String {
        number(bp) + "\u{00A0}%"
    }

    /// 4000 → „40“, 1250 → „12,5“ (für Eingabefelder)
    public static func number(_ bp: Int) -> String {
        Money.number(bp, style: .compact)
    }

    /// „40“, „12,5“, „0,25 %“ → Basispunkte; nil bei leer, ungültig oder außerhalb 0,01–100 %.
    public static func parse(_ text: String) -> Int? {
        guard let bp = Money.parse(text.replacingOccurrences(of: "%", with: "")), (1...10_000).contains(bp) else { return nil }
        return bp
    }
}

/// Soll und Ist beider Personen, aufbereitet für die Übersicht des gemeinsamen Haushalts.
public struct ContributionsState: Hashable, Sendable {
    public struct Row: Hashable, Sendable, Identifiable {
        public let id: String
        public let isMe: Bool
        /// „Du“ oder der Name der anderen Person
        public let name: String
        /// „400 € im Monat“, „40 % vom Netto“, „Keine Regel“
        public let rule: String
        /// „Soll 400 €“, „Soll nicht freigegeben“; nil ohne Regel
        public let target: String?
        /// „Ist 250 €“
        public let paid: String
        /// „noch 150 € offen“, „Soll erreicht“, „Pause“; nil, wenn das Soll unbekannt ist
        public let status: String?
        /// Ist ÷ Soll, 0…1; nil, wenn das Soll unbekannt oder 0 ist
        public let progress: Double?
        public let done: Bool
    }

    public let month: YearMonth
    public let rows: [Row]
    /// Eigene Regel fehlt: Hinweis „Lege deine Regel fest“
    public let missingOwnRule: Bool

    /// - Parameter me: angemeldete Person; ihre Zeile steht oben.
    public init(_ contributions: Contributions, me: String?) {
        month = contributions.month
        let sorted = contributions.members.enumerated().sorted { a, b in
            let aMe = a.element.personId == me, bMe = b.element.personId == me
            return aMe != bMe ? aMe : a.offset < b.offset
        }.map(\.element)
        rows = sorted.map { Self.row($0, isMe: $0.personId == me) }
        missingOwnRule = contributions.members.contains { $0.personId == me && $0.rule == nil }
    }

    static func row(_ m: MemberContribution, isMe: Bool) -> Row {
        let paid = "Ist \(Money.format(m.paidCents))"
        guard let rule = m.rule else {
            return Row(
                id: m.personId, isMe: isMe, name: isMe ? "Du" : m.displayName, rule: "Keine Regel",
                target: nil, paid: paid, status: nil, progress: nil, done: false
            )
        }
        guard m.targetVisible, let target = m.targetCents else {
            return Row(
                id: m.personId, isMe: isMe, name: isMe ? "Du" : m.displayName, rule: rule.text,
                target: "Soll nicht freigegeben", paid: paid, status: nil, progress: nil, done: false
            )
        }
        let remaining = m.remainingCents ?? max(0, target - m.paidCents)
        let status: String
        let progress: Double?
        if target == 0 {
            status = "Pause"
            progress = nil
        } else {
            status = remaining == 0 ? "Soll erreicht" : "noch \(Money.format(remaining)) offen"
            progress = min(1, max(0, Double(m.paidCents) / Double(target)))
        }
        return Row(
            id: m.personId, isMe: isMe, name: isMe ? "Du" : m.displayName, rule: rule.text,
            target: "Soll \(Money.format(target))", paid: paid, status: status, progress: progress,
            done: remaining == 0
        )
    }
}

/// Regeln beider Personen mit Historie, je Person die jüngste zuerst.
public struct ContributionHistory: Hashable, Sendable {
    public struct Entry: Hashable, Sendable, Identifiable {
        public var id: String { "\(personId)-\(validFrom)" }
        public let personId: String
        public let validFrom: YearMonth
        /// „ab November 2026“
        public let since: String
        public let text: String
        /// gilt im angezeigten Monat
        public let active: Bool
        /// beginnt nach dem angezeigten Monat
        public let upcoming: Bool
        /// eigene Regel: lässt sich löschen
        public let deletable: Bool
    }

    public struct PersonRules: Hashable, Sendable, Identifiable {
        public var id: String { personId }
        public let personId: String
        public let name: String
        public let isMe: Bool
        public let entries: [Entry]
    }

    public let people: [PersonRules]

    /// - Parameters:
    ///   - members: Mitglieder des gemeinsamen Haushalts (für die Namen und die Reihenfolge)
    ///   - me: angemeldete Person; sie steht oben und darf nur ihre eigenen Regeln löschen
    ///   - month: angezeigter Monat (welche Regel gilt)
    public init(rules: [ContributionRule], members: [Person], me: String?, month: YearMonth) {
        var order = members.map(\.id)
        for id in rules.map(\.personId) where !order.contains(id) { order.append(id) }
        if let me, let index = order.firstIndex(of: me) {
            let first = order.remove(at: index)
            order.insert(first, at: 0)
        }
        let names = Dictionary(members.map { ($0.id, $0.displayName) }, uniquingKeysWith: { a, _ in a })

        people = order.map { personId in
            let active = ContributionRule.active(in: rules, personId: personId, month: month)
            let entries = rules.filter { $0.personId == personId }
                .sorted { $0.validFrom > $1.validFrom }
                .map { rule in
                    Entry(
                        personId: personId, validFrom: rule.validFrom, since: "ab \(rule.validFrom.title)",
                        text: rule.text, active: rule == active, upcoming: rule.validFrom > month,
                        deletable: personId == me
                    )
                }
            let isMe = personId == me
            return PersonRules(personId: personId, name: isMe ? "Du" : names[personId] ?? "Andere Person", isMe: isMe, entries: entries)
        }
    }
}

/// Eingabe der eigenen Regel.
public struct ContributionRuleDraft: Hashable, Sendable {
    public var kind: ContributionRule.Kind = .fest
    /// Euro, z. B. „400“ oder „450,50“; „0“ = Pause
    public var amountText: String = ""
    /// Prozent, z. B. „40“ oder „12,5“
    public var percentText: String = ""
    public var validFrom: YearMonth

    /// Vorbelegt mit der Regel, die gerade gilt; gültig ab `month`.
    public init(rule: ContributionRule?, month: YearMonth) {
        validFrom = month
        guard let rule else { return }
        kind = rule.kind
        amountText = rule.amountCents.map { Money.number($0) } ?? ""
        percentText = rule.percentBp.map(Percent.number) ?? ""
    }

    private var isAmountEmpty: Bool { amountText.trimmingCharacters(in: .whitespaces).isEmpty }
    private var isPercentEmpty: Bool { percentText.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Betrag in Cent (0 = Pause); nil bei leer, ungültig oder Art „Prozent“.
    public var amountCents: Int? {
        guard kind == .fest, !isAmountEmpty else { return nil }
        return Money.parse(amountText)
    }

    /// Anteil in Basispunkten; nil bei leer, ungültig oder Art „fest“.
    public var percentBp: Int? {
        guard kind == .prozent, !isPercentEmpty else { return nil }
        return Percent.parse(percentText)
    }

    /// Was noch fehlt oder nicht passt, in einem Satz; nil = bereit.
    public var problem: String? {
        switch kind {
        case .fest:
            if isAmountEmpty { return "Wie viel zahlst du jeden Monat ein? 0 € heißt Pause." }
            if amountCents == nil { return "Den Betrag verstehe ich nicht, z. B. 400 oder 450,50." }
        case .prozent:
            if isPercentEmpty { return "Welcher Anteil deines Netto? Z. B. 40 %." }
            if percentBp == nil { return "Der Anteil muss zwischen 0,01 und 100 % liegen." }
        }
        return nil
    }

    public var input: ContributionRuleInput? {
        if let cents = amountCents { return .fixed(cents: cents) }
        if let bp = percentBp { return .percent(bp: bp) }
        return nil
    }
}

/// Hinweise zur Freigabe `einzahlung_soll`.
public enum ContributionPrivacy {
    /// Fußnote unter dem Schalter „Soll freigeben“.
    public static func hint(rule: ContributionRule?, partner: String) -> String {
        guard let rule, rule.kind == .prozent, let bp = rule.percentBp else {
            return "Ein fester Betrag ist für \(partner) ohnehin sichtbar. Die Freigabe wirkt erst bei einer Regel in Prozent: Dann sieht \(partner) dein Soll und damit, wie viel du verdienst."
        }
        let percent = Percent.format(bp)
        return "Ohne Freigabe sieht \(partner) deine Regel (\(percent)) und was du eingezahlt hast, aber nicht dein Soll. Überweist du genau das Soll, lässt sich dein Netto trotzdem ausrechnen: Ist ÷ \(percent)."
    }
}
