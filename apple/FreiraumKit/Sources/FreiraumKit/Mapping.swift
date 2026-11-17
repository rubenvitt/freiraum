import FreiraumAPI

// Abbildung der generierten Typen auf die Modelle der App. Enums laufen über rawValue, damit
// neue Werte im Vertrag nicht still falsch zugeordnet werden (unbekannt → Fehler beim Abbilden).

struct MappingError: Error, CustomStringConvertible {
    let description: String
}

extension Household {
    init(_ h: Components.Schemas.Household) throws {
        guard let kind = Kind(rawValue: h.kind.rawValue) else { throw MappingError(description: "Haushaltsart \(h.kind.rawValue)") }
        self.init(
            id: h.id, kind: kind, name: h.name,
            members: h.members.map { Person(id: $0.id, displayName: $0.displayName) }
        )
    }
}

extension Account {
    init(_ a: Components.Schemas.Account) throws {
        guard let source = Source(rawValue: a.source.rawValue) else { throw MappingError(description: "Kontoquelle \(a.source.rawValue)") }
        self.init(
            id: a.id, householdId: a.householdId, name: a.name, source: source,
            unrecordedCashCents: a.unrecordedCashCents
        )
    }
}

extension PotKind {
    init(raw: String) throws {
        guard let kind = PotKind(rawValue: raw) else { throw MappingError(description: "Topfart \(raw)") }
        self = kind
    }
}

extension Pot {
    init(_ p: Components.Schemas.Pot) throws {
        self.init(
            id: p.id, householdId: p.householdId, name: p.name, kind: try PotKind(raw: p.kind.rawValue),
            groupName: p.groupName, amountCents: p.amountCents, percentBp: p.percentBp,
            targetMonth: p.targetMonth.flatMap(YearMonth.init), sortOrder: p.sortOrder, archived: p.archived
        )
    }
}

extension BudgetMonth {
    init(_ b: Components.Schemas.BudgetMonth) throws {
        guard let month = YearMonth(b.month) else { throw MappingError(description: "Monat \(b.month)") }
        self.init(
            householdId: b.householdId, month: month, startMonth: YearMonth(b.budgetStartMonth),
            closed: b.closedAt != nil,
            readyToAssignCents: b.readyToAssignCents, inflowsCents: b.inflowsCents,
            unconfirmedTransactions: b.unconfirmedTransactions,
            pots: try b.pots.map { p in
                BudgetPot(
                    potId: p.potId, name: p.name, kind: try PotKind(raw: p.kind.rawValue), groupName: p.groupName,
                    archived: p.archived, carryoverCents: p.carryoverCents, assignedCents: p.assignedCents,
                    activityCents: p.activityCents, availableCents: p.availableCents, planCents: p.planCents,
                    neededCents: p.neededCents
                )
            }
        )
    }
}

extension SplitTarget {
    init(kind: String, potId: String?, counterAccountId: String? = nil) throws {
        switch (kind, potId, counterAccountId) {
        case ("topf", let id?, _): self = .pot(id)
        case ("einnahme", _, _): self = .income
        case ("umbuchung", _, let account?): self = .transferTo(account)
        case ("umbuchung", _, nil): self = .transfer
        default: throw MappingError(description: "Aufteilung \(kind)")
        }
    }

    var apiKind: Components.Schemas.SplitInput.KindPayload {
        switch self {
        case .pot: .topf
        case .income: .einnahme
        case .transfer, .transferTo: .umbuchung
        }
    }

    var potId: String? {
        if case let .pot(id) = self { return id }
        return nil
    }

    var counterAccountId: String? {
        if case let .transferTo(id) = self { return id }
        return nil
    }
}

extension Split {
    var api: Components.Schemas.SplitInput {
        .init(
            kind: target.apiKind, potId: target.potId, personId: nil,
            counterAccountId: target.counterAccountId, amountCents: amountCents
        )
    }
}

extension Transaction {
    init(_ t: Components.Schemas.Transaction) throws {
        guard let status = Status(rawValue: t.status.rawValue) else { throw MappingError(description: "Status \(t.status.rawValue)") }
        self.init(
            id: t.id, accountId: t.accountId, bookingDate: t.bookingDate, amountCents: t.amountCents,
            counterpartyName: t.counterpartyName, purpose: t.purpose, status: status,
            splits: try t.splits.map {
                Split(
                    target: try SplitTarget(kind: $0.kind.rawValue, potId: $0.potId, counterAccountId: $0.counterAccountId),
                    amountCents: $0.amountCents
                )
            },
            suggestion: try t.suggestion.map { s in
                guard let source = Suggestion.Source(rawValue: s.source.rawValue) else { throw MappingError(description: "Quelle \(s.source.rawValue)") }
                return Suggestion(
                    source: source,
                    target: try SplitTarget(kind: s.kind.rawValue, potId: s.potId, counterAccountId: s.counterAccountId),
                    confidencePct: s.confidencePct, reason: s.reason
                )
            }
        )
    }
}
