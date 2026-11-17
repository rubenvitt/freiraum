import FreiraumAPI

// Abbildung der generierten Typen auf die Modelle der App. Enums laufen über rawValue, damit
// neue Werte im Vertrag nicht still falsch zugeordnet werden (unbekannt → Fehler beim Abbilden).

struct MappingError: Error, CustomStringConvertible {
    let description: String
}

/// Wert eines generierten Enums aus dem Rohwert; der Typ ergibt sich aus dem Aufruf.
func apiEnum<T: RawRepresentable>(_ raw: String) throws -> T where T.RawValue == String {
    guard let value = T(rawValue: raw) else { throw MappingError(description: "Wert \(raw)") }
    return value
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
        self.init(id: a.id, householdId: a.householdId, name: a.name, source: source)
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
    init(kind: String, potId: String?, personId: String?) throws {
        switch (kind, potId) {
        case ("topf", let id?): self = .pot(id)
        case ("einnahme", _): self = .income
        case ("umbuchung", _): self = .transfer
        case ("einzahlung", _): self = .contribution(personId: personId)
        case ("ausgleich", _): self = .settlement(personId: personId)
        default: throw MappingError(description: "Aufteilung \(kind)")
        }
    }

    var apiKind: Components.Schemas.Split.KindPayload {
        switch self {
        case .pot: .topf
        case .income: .einnahme
        case .transfer: .umbuchung
        case .contribution: .einzahlung
        case .settlement: .ausgleich
        }
    }

    var potId: String? {
        if case let .pot(id) = self { return id }
        return nil
    }

    var personId: String? {
        switch self {
        case let .contribution(id), let .settlement(id): id
        case .pot, .income, .transfer: nil
        }
    }
}

extension Split {
    /// Eingabe für `PUT /v1/transactions/{id}/splits` (`SplitInput` = `Split`, potId und personId optional).
    var api: Components.Schemas.SplitInput {
        .init(
            value1: .init(kind: target.apiKind, potId: target.potId, personId: target.personId, amountCents: amountCents),
            value2: .init(potId: target.potId, personId: target.personId)
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
                Split(target: try SplitTarget(kind: $0.kind.rawValue, potId: $0.potId, personId: $0.personId), amountCents: $0.amountCents)
            },
            suggestion: try t.suggestion.map { s in
                guard let source = Suggestion.Source(rawValue: s.source.rawValue) else { throw MappingError(description: "Quelle \(s.source.rawValue)") }
                return Suggestion(
                    source: source, target: try SplitTarget(kind: s.kind.rawValue, potId: s.potId, personId: s.personId),
                    confidencePct: s.confidencePct, reason: s.reason
                )
            }
        )
    }
}

extension Settlements {
    init(_ s: Components.Schemas.Settlements) throws {
        self.init(
            householdId: s.householdId,
            balances: s.balances.map {
                Balance(
                    personId: $0.personId, displayName: $0.displayName, claimedCents: $0.claimedCents,
                    repaidCents: $0.repaidCents, debtCents: $0.debtCents, paidBackCents: $0.paidBackCents,
                    openCents: $0.openCents
                )
            },
            openItems: s.openItems.map {
                Item(
                    transactionId: $0.transactionId, personId: $0.personId, bookingDate: $0.bookingDate,
                    counterpartyName: $0.counterpartyName, amountCents: $0.amountCents, openCents: $0.openCents
                )
            },
            openDebts: s.openDebts.map {
                Item(
                    transactionId: $0.transactionId, personId: $0.personId, bookingDate: $0.bookingDate,
                    counterpartyName: $0.counterpartyName, amountCents: $0.amountCents, openCents: $0.openCents
                )
            },
            manual: try s.manual.map {
                Manual(
                    id: $0.id, personId: $0.personId, kind: try apiEnum($0.kind.rawValue), amountCents: $0.amountCents,
                    settledOn: $0.settledOn, note: $0.note
                )
            }
        )
    }
}

extension ContributionRule {
    init(
        householdId: String, personId: String, validFrom: String, kind: String, amountCents: Int?, percentBp: Int?
    ) throws {
        guard let month = YearMonth(validFrom) else { throw MappingError(description: "Monat \(validFrom)") }
        self.init(
            householdId: householdId, personId: personId, validFrom: month, kind: try apiEnum(kind),
            amountCents: amountCents, percentBp: percentBp
        )
    }

    init(_ r: Components.Schemas.ContributionRule) throws {
        try self.init(
            householdId: r.householdId, personId: r.personId, validFrom: r.validFrom, kind: r.kind.rawValue,
            amountCents: r.amountCents, percentBp: r.percentBp
        )
    }
}

extension Contributions {
    init(_ c: Components.Schemas.Contributions) throws {
        guard let month = YearMonth(c.month) else { throw MappingError(description: "Monat \(c.month)") }
        self.init(
            householdId: c.householdId, month: month,
            members: try c.members.map { m in
                MemberContribution(
                    personId: m.personId, displayName: m.displayName,
                    rule: try m.rule.map { r in
                        try ContributionRule(
                            householdId: r.householdId, personId: r.personId, validFrom: r.validFrom,
                            kind: r.kind.rawValue, amountCents: r.amountCents, percentBp: r.percentBp
                        )
                    },
                    targetCents: m.targetCents, targetVisible: m.targetVisible, paidCents: m.paidCents,
                    remainingCents: m.remainingCents
                )
            }
        )
    }
}

extension Share {
    init(_ s: Components.Schemas.Share) throws {
        self.init(personId: s.personId, displayName: s.displayName, scope: try apiEnum(s.scope.rawValue))
    }
}
