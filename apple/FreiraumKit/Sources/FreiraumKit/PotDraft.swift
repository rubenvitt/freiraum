import Foundation

extension PotKind: CaseIterable {
    public static let allCases: [PotKind] = [.monatlich, .ruecklage, .ziel, .erstIch]

    public var title: String {
        switch self {
        case .monatlich: "Monatlich"
        case .ruecklage: "Rücklage"
        case .ziel: "Ziel"
        case .erstIch: "Erst ich"
        }
    }

    /// Ein Satz, wofür die Art gedacht ist.
    public var explanation: String {
        switch self {
        case .monatlich: "Laufende Ausgaben mit einem Betrag je Monat, z. B. Lebensmittel."
        case .ruecklage: "Unregelmäßige Kosten mit einem Jahresbetrag; jeden Monat kommt ein Zwölftel dazu."
        case .ziel: "Ein Betrag, der bis zu einem Monat zusammenkommen soll."
        case .erstIch: "Wird nach jeder Einnahme zuerst gefüllt, mit festem Betrag oder Anteil."
        }
    }
}

/// Neuer Topf, bereit zum Senden.
public struct PotInput: Hashable, Sendable {
    public let name: String
    public let kind: PotKind
    public let groupName: String?
    public let amountCents: Int?
    public let percentBp: Int?
    public let targetMonth: YearMonth?

    public init(
        name: String, kind: PotKind, groupName: String? = nil, amountCents: Int? = nil,
        percentBp: Int? = nil, targetMonth: YearMonth? = nil
    ) {
        self.name = name
        self.kind = kind
        self.groupName = groupName
        self.amountCents = amountCents
        self.percentBp = percentBp
        self.targetMonth = targetMonth
    }
}

/// Felder eines Topfs, die sich leeren lassen. Der generierte Client lässt `nil` weg, statt
/// `null` zu senden; deshalb nennt die App sie in `clear` (siehe `PATCH /v1/pots/{potId}`).
public enum PotField: String, Hashable, Sendable, CaseIterable {
    case groupName, amountCents, percentBp, targetMonth
}

/// Änderungen an einem Topf. nil = unverändert; geleert wird über `clear`.
public struct PotChanges: Hashable, Sendable {
    public var name: String?
    public var groupName: String?
    public var amountCents: Int?
    public var percentBp: Int?
    public var targetMonth: YearMonth?
    public var archived: Bool?
    public var clear: [PotField] = []

    public init(
        name: String? = nil, groupName: String? = nil, amountCents: Int? = nil, percentBp: Int? = nil,
        targetMonth: YearMonth? = nil, archived: Bool? = nil, clear: [PotField] = []
    ) {
        self.name = name
        self.groupName = groupName
        self.amountCents = amountCents
        self.percentBp = percentBp
        self.targetMonth = targetMonth
        self.archived = archived
        self.clear = clear
    }

    public var isEmpty: Bool {
        name == nil && groupName == nil && amountCents == nil && percentBp == nil && targetMonth == nil
            && archived == nil && clear.isEmpty
    }
}

/// Eingabe „Topf anlegen“ bzw. „Topf bearbeiten“. Beträge und Anteil als Text, wie getippt.
public struct PotDraft: Hashable, Sendable {
    /// Wie sich ein Erst-ich-Topf füllt.
    public enum ErstIchMode: String, Hashable, Sendable, CaseIterable {
        case betrag, anteil

        public var title: String { self == .betrag ? "Fester Betrag" : "Anteil" }
    }

    public var name: String = ""
    /// Nur beim Anlegen änderbar; der Server ändert die Art nicht mehr.
    public var kind: PotKind
    public var groupName: String = ""
    public var amountText: String = ""
    /// Prozent, z. B. „10“ oder „12,5“
    public var percentText: String = ""
    public var erstIchMode: ErstIchMode = .anteil
    public var hasTargetMonth: Bool = false
    public var targetMonth: YearMonth

    public init(kind: PotKind = .monatlich, today: YearMonth = .current()) {
        self.kind = kind
        self.targetMonth = today.adding(months: 12)
    }

    /// Vorbelegt mit einem vorhandenen Topf.
    public init(pot: Pot, today: YearMonth = .current()) {
        kind = pot.kind
        name = pot.name
        groupName = pot.groupName ?? ""
        amountText = pot.amountCents.map { Money.number($0, style: .compact) } ?? ""
        percentText = pot.percentBp.map(Self.percentText) ?? ""
        erstIchMode = pot.percentBp != nil || pot.amountCents == nil ? .anteil : .betrag
        hasTargetMonth = pot.targetMonth != nil
        targetMonth = pot.targetMonth ?? today.adding(months: 12)
    }

    /// „10“, „12,5“, „0,25“ aus Basispunkten.
    static func percentText(_ bp: Int) -> String {
        Money.number(bp, style: .compact)
    }

    // MARK: Abgeleitet

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var trimmedGroup: String? {
        let text = groupName.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// Ob die Art einen Betrag braucht (sonst ist er freiwillig oder entfällt).
    public var amountRequired: Bool {
        switch kind {
        case .ruecklage, .ziel: true
        case .erstIch: erstIchMode == .betrag
        case .monatlich: false
        }
    }

    public var showsAmount: Bool { kind != .erstIch || erstIchMode == .betrag }
    public var showsPercent: Bool { kind == .erstIch && erstIchMode == .anteil }
    public var showsTargetMonth: Bool { kind == .ziel }

    /// Beschriftung des Betragsfelds je Art.
    public var amountLabel: String {
        switch kind {
        case .monatlich: "Betrag je Monat"
        case .ruecklage: "Betrag je Jahr"
        case .ziel: "Zielbetrag"
        case .erstIch: "Betrag je Monat"
        }
    }

    private var isAmountEmpty: Bool { amountText.trimmingCharacters(in: .whitespaces).isEmpty }
    private var isPercentEmpty: Bool { percentText.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Plan-Betrag in Cent; nil = leer. Ungültig zeigt `problem`.
    public var amountCents: Int? {
        guard showsAmount, !isAmountEmpty, let cents = Money.parse(amountText), cents > 0 else { return nil }
        return cents
    }

    /// Anteil in Basispunkten (10 % = 1000); nil = leer oder ungültig.
    public var percentBp: Int? {
        guard showsPercent, !isPercentEmpty, let bp = Money.parse(percentText.replacingOccurrences(of: "%", with: "")),
              (1...10_000).contains(bp)
        else { return nil }
        return bp
    }

    public var plannedTargetMonth: YearMonth? { showsTargetMonth && hasTargetMonth ? targetMonth : nil }

    /// Was noch fehlt oder nicht passt, in einem Satz; nil = bereit.
    public var problem: String? {
        if trimmedName.isEmpty { return "Wie soll der Topf heißen?" }
        if trimmedName.count > 100 { return "Der Name ist zu lang (höchstens 100 Zeichen)." }
        if let group = trimmedGroup, group.count > 100 { return "Die Gruppe ist zu lang (höchstens 100 Zeichen)." }
        if showsAmount, !isAmountEmpty, amountCents == nil { return "Den Betrag verstehe ich nicht, z. B. 250 oder 49,90." }
        if amountRequired, amountCents == nil {
            switch kind {
            case .ruecklage: return "Wie viel kostet es im Jahr?"
            case .ziel: return "Wie viel soll zusammenkommen?"
            default: return "Wie viel soll jeden Monat zuerst in den Topf?"
            }
        }
        if showsPercent {
            if isPercentEmpty { return "Welcher Anteil der Einnahmen? Z. B. 10 %." }
            if percentBp == nil { return "Der Anteil muss zwischen 0,01 und 100 % liegen." }
        }
        return nil
    }

    /// Zum Anlegen; nil, solange `problem` etwas meldet.
    public var input: PotInput? {
        guard problem == nil else { return nil }
        return PotInput(
            name: trimmedName, kind: kind, groupName: trimmedGroup, amountCents: amountCents,
            percentBp: percentBp, targetMonth: plannedTargetMonth
        )
    }

    /// Unterschied zu `pot`: geänderte Werte setzen, weggefallene über `clear` leeren.
    /// nil, solange `problem` etwas meldet.
    public func changes(from pot: Pot) -> PotChanges? {
        guard problem == nil else { return nil }
        var changes = PotChanges()
        if trimmedName != pot.name { changes.name = trimmedName }
        func update<T: Equatable>(_ field: PotField, _ new: T?, _ old: T?, set: (inout PotChanges, T) -> Void) {
            guard new != old else { return }
            if let new { set(&changes, new) } else { changes.clear.append(field) }
        }
        update(.groupName, trimmedGroup, pot.groupName) { $0.groupName = $1 }
        update(.amountCents, amountCents, pot.amountCents) { $0.amountCents = $1 }
        update(.percentBp, percentBp, pot.percentBp) { $0.percentBp = $1 }
        update(.targetMonth, plannedTargetMonth, pot.targetMonth) { $0.targetMonth = $1 }
        return changes
    }
}

extension YearMonth {
    /// Monat um `months` verschoben (auch negativ).
    public func adding(months: Int) -> YearMonth {
        let index = year * 12 + (month - 1) + months
        return YearMonth(year: index / 12, month: index % 12 + 1)
    }
}

/// Reihenfolge der Töpfe ändern: die Liste, wie sie die Person sortiert.
public enum PotOrder {
    /// `ids` nach dem Verschieben (wie `Array.move(fromOffsets:toOffset:)` in SwiftUI).
    public static func move(_ ids: [String], from source: IndexSet, to destination: Int) -> [String] {
        let moving = source.sorted().map { ids[$0] }
        var rest = ids.enumerated().filter { !source.contains($0.offset) }.map(\.element)
        let before = source.filter { $0 < destination }.count
        rest.insert(contentsOf: moving, at: destination - before)
        return rest
    }
}
