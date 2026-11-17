import Foundation

// Fachliche Modelle der App, unabhängig vom generierten Client. Die Abbildung steht in
// Mapping.swift. Alle Beträge in Cent.

public struct Person: Hashable, Sendable, Codable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

public struct Household: Hashable, Sendable, Codable, Identifiable {
    public enum Kind: String, Sendable, Codable { case privat, gemeinsam }

    public let id: String
    public let kind: Kind
    public let name: String
    public let members: [Person]

    public init(id: String, kind: Kind, name: String, members: [Person]) {
        self.id = id
        self.kind = kind
        self.name = name
        self.members = members
    }

    /// Kurzname im Umschalter und auf Vorschlägen: „Ich“ oder „Gemeinsam“.
    public var shortLabel: String { kind == .privat ? "Ich" : "Gemeinsam" }
}

public struct Account: Hashable, Sendable, Codable, Identifiable {
    public enum Source: String, Sendable, Codable { case bank, bar, manuell }

    public let id: String
    public let householdId: String
    public let name: String
    public let source: Source

    public init(id: String, householdId: String, name: String, source: Source) {
        self.id = id
        self.householdId = householdId
        self.name = name
        self.source = source
    }
}

public enum PotKind: String, Sendable, Codable {
    case monatlich, ruecklage, ziel
    case erstIch = "erst_ich"
}

public struct Pot: Hashable, Sendable, Codable, Identifiable {
    public let id: String
    public let householdId: String
    public let name: String
    public let kind: PotKind
    public let groupName: String?
    /// monatlich: je Monat; ruecklage: je Jahr; ziel: Zielbetrag; erst_ich: je Monat
    public let amountCents: Int?
    public let percentBp: Int?
    public let targetMonth: YearMonth?
    public let sortOrder: Int
    public let archived: Bool

    public init(
        id: String, householdId: String, name: String, kind: PotKind, groupName: String? = nil,
        amountCents: Int? = nil, percentBp: Int? = nil, targetMonth: YearMonth? = nil,
        sortOrder: Int = 0, archived: Bool = false
    ) {
        self.id = id
        self.householdId = householdId
        self.name = name
        self.kind = kind
        self.groupName = groupName
        self.amountCents = amountCents
        self.percentBp = percentBp
        self.targetMonth = targetMonth
        self.sortOrder = sortOrder
        self.archived = archived
    }
}

public struct BudgetPot: Hashable, Sendable, Codable, Identifiable {
    public var id: String { potId }
    public let potId: String
    public let name: String
    public let kind: PotKind
    public let groupName: String?
    public let archived: Bool
    public let carryoverCents: Int
    public let assignedCents: Int
    public let activityCents: Int
    public let availableCents: Int
    public let planCents: Int
    public let neededCents: Int

    public init(
        potId: String, name: String, kind: PotKind, groupName: String? = nil, archived: Bool = false,
        carryoverCents: Int = 0, assignedCents: Int = 0, activityCents: Int = 0,
        availableCents: Int = 0, planCents: Int = 0, neededCents: Int = 0
    ) {
        self.potId = potId
        self.name = name
        self.kind = kind
        self.groupName = groupName
        self.archived = archived
        self.carryoverCents = carryoverCents
        self.assignedCents = assignedCents
        self.activityCents = activityCents
        self.availableCents = availableCents
        self.planCents = planCents
        self.neededCents = neededCents
    }
}

public struct BudgetMonth: Hashable, Sendable, Codable {
    public let householdId: String
    public let month: YearMonth
    /// Budgetbeginn des Haushalts; Monate davor sind leer.
    public let startMonth: YearMonth?
    public let closed: Bool
    /// „Noch ohne Aufgabe“
    public let readyToAssignCents: Int
    public let inflowsCents: Int
    public let unconfirmedTransactions: Int
    public let pots: [BudgetPot]

    public init(
        householdId: String, month: YearMonth, startMonth: YearMonth? = nil, closed: Bool = false, readyToAssignCents: Int,
        inflowsCents: Int = 0, unconfirmedTransactions: Int = 0, pots: [BudgetPot]
    ) {
        self.householdId = householdId
        self.month = month
        self.startMonth = startMonth
        self.closed = closed
        self.readyToAssignCents = readyToAssignCents
        self.inflowsCents = inflowsCents
        self.unconfirmedTransactions = unconfirmedTransactions
        self.pots = pots
    }
}

/// Ziel einer Aufteilung: ein Topf, „Einnahme“ (fließt in „Noch ohne Aufgabe“), „Umbuchung“
/// (zwischen eigenen Konten, ohne Wirkung aufs Budget), Einzahlung ins Gemeinsame oder Ausgleich
/// zwischen privatem und gemeinsamem Konto. Bei Einzahlung und Ausgleich nennt `personId` auf
/// gemeinsamen Konten, von wem bzw. an wen das Geld geht; auf privaten Konten ist sie leer.
public enum SplitTarget: Hashable, Sendable, Codable {
    case pot(String)
    case income
    case transfer
    case contribution(personId: String?)
    case settlement(personId: String?)
}

public struct Split: Hashable, Sendable, Codable {
    public let target: SplitTarget
    public let amountCents: Int

    public init(target: SplitTarget, amountCents: Int) {
        self.target = target
        self.amountCents = amountCents
    }
}

public struct Suggestion: Hashable, Sendable, Codable {
    /// abgleich = Überweisung zwischen eigenen Konten, über die IBAN erkannt
    public enum Source: String, Sendable, Codable { case regel, abgleich, llm }

    public let source: Source
    public let target: SplitTarget
    public let confidencePct: Int
    public let reason: String

    public init(source: Source, target: SplitTarget, confidencePct: Int, reason: String) {
        self.source = source
        self.target = target
        self.confidencePct = confidencePct
        self.reason = reason
    }
}

public struct Transaction: Hashable, Sendable, Codable, Identifiable {
    public enum Status: String, Sendable, Codable { case importiert, vorgeschlagen, bestaetigt }

    public let id: String
    public let accountId: String
    public let bookingDate: String
    public let amountCents: Int
    public let counterpartyName: String?
    public let purpose: String?
    public let status: Status
    public let splits: [Split]
    public let suggestion: Suggestion?

    public init(
        id: String, accountId: String, bookingDate: String, amountCents: Int,
        counterpartyName: String? = nil, purpose: String? = nil, status: Status,
        splits: [Split] = [], suggestion: Suggestion? = nil
    ) {
        self.id = id
        self.accountId = accountId
        self.bookingDate = bookingDate
        self.amountCents = amountCents
        self.counterpartyName = counterpartyName
        self.purpose = purpose
        self.status = status
        self.splits = splits
        self.suggestion = suggestion
    }
}
