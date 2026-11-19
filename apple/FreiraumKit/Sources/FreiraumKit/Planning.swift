import FreiraumAPI

// Planungsansicht am Mac (FREI-21): Budget eines Monats als Tabelle nach Gruppen, Geld zwischen
// Töpfen umschichten, Monat abschließen. Der Server bleibt führend: Er lehnt eine Erhöhung ab,
// die „Noch ohne Aufgabe“ negativ machen würde (422), und prüft den Abschluss (409). Die App
// zeigt dann seine Meldung.

/// Budget eines Monats, aufbereitet für die Planungstabelle.
public struct PlanningState: Hashable, Sendable {
    public struct Row: Hashable, Sendable, Identifiable {
        public var id: String { potId }
        public let potId: String
        public let name: String
        public let kind: PotKind
        public let assignedCents: Int
        public let activityCents: Int
        public let availableCents: Int
        public let planCents: Int
        public let neededCents: Int
        public let assigned: String
        public let activity: String
        public let available: String
        /// „Plan 150 €“, „fehlt 40 €“, „Erst ich“
        public let note: String?
        public let tone: OverviewState.Tone
        public let archived: Bool
    }

    public struct Group: Hashable, Sendable, Identifiable {
        /// Gruppenname oder "" für Töpfe ohne Gruppe
        public let id: String
        public let title: String
        public let rows: [Row]
        public let assigned: String
        public let activity: String
        public let available: String
    }

    public let householdId: String
    public let month: YearMonth
    public let closed: Bool
    public let readyToAssignCents: Int
    public let readyToAssign: String
    public let inflows: String
    public let unconfirmedTransactions: Int
    public let groups: [Group]
    /// Summe dessen, was laut Plan noch fehlt
    public let neededCents: Int
    /// Wählbare Quellen und Ziele zum Umschichten (aktive Töpfe in Tabellenreihenfolge)
    public let movable: [Row]
    public let closing: ClosingState

    public init(budget: BudgetMonth, pots: [Pot], current: YearMonth = .current()) {
        let order = Dictionary(pots.map { ($0.id, $0.sortOrder) }, uniquingKeysWith: { a, _ in a })
        let visible = budget.pots
            .filter { !$0.archived || $0.availableCents != 0 || $0.activityCents != 0 || $0.assignedCents != 0 }
            .sorted { (order[$0.potId] ?? .max, $0.name) < (order[$1.potId] ?? .max, $1.name) }

        householdId = budget.householdId
        month = budget.month
        closed = budget.closed
        readyToAssignCents = budget.readyToAssignCents
        readyToAssign = Money.format(budget.readyToAssignCents)
        inflows = Money.format(budget.inflowsCents)
        unconfirmedTransactions = budget.unconfirmedTransactions
        neededCents = visible.reduce(0) { $0 + max(0, $1.neededCents) }

        let rows = visible.map(Self.row)
        // Erst ich zuerst (wie in der Übersicht), dann Gruppen in der Reihenfolge ihres ersten Topfs.
        var titles: [String] = []
        var members: [String: [Row]] = [:]
        for (b, row) in zip(visible, rows) {
            let key = b.kind == .erstIch ? "\u{0}erst_ich" : (b.groupName ?? "")
            if members[key] == nil { titles.append(key) }
            members[key, default: []].append(row)
        }
        titles.sort { a, b in
            func rank(_ k: String) -> Int { k == "\u{0}erst_ich" ? 0 : k.isEmpty ? 2 : 1 }
            return rank(a) < rank(b)
        }
        groups = titles.map { key in
            let list = members[key] ?? []
            let title = key == "\u{0}erst_ich" ? "Erst ich" : key.isEmpty ? "Ohne Gruppe" : key
            return Group(
                id: key, title: title, rows: list,
                assigned: Money.format(list.reduce(0) { $0 + $1.assignedCents }),
                activity: Money.format(list.reduce(0) { $0 + $1.activityCents }),
                available: Money.format(list.reduce(0) { $0 + $1.availableCents })
            )
        }
        movable = groups.flatMap(\.rows).filter { !$0.archived }
        closing = ClosingState(budget: budget, current: current)
    }

    static func row(_ b: BudgetPot) -> Row {
        var note: String?
        if b.neededCents > 0 {
            note = "fehlt \(Money.format(b.neededCents))"
        } else if b.planCents != 0 {
            note = "Plan \(Money.format(b.planCents))"
        }
        let tone: OverviewState.Tone
        if b.availableCents < 0 {
            tone = .overspent
        } else if b.neededCents > 0 {
            tone = .low
        } else {
            tone = .ok
        }
        return Row(
            potId: b.potId, name: b.name, kind: b.kind, assignedCents: b.assignedCents, activityCents: b.activityCents,
            availableCents: b.availableCents, planCents: b.planCents, neededCents: b.neededCents,
            assigned: Money.format(b.assignedCents), activity: Money.format(b.activityCents),
            available: Money.format(b.availableCents), note: note, tone: tone, archived: b.archived
        )
    }

    public func row(_ potId: String) -> Row? {
        groups.lazy.flatMap(\.rows).first { $0.potId == potId }
    }
}

/// Ob und wie sich der Monat abschließen oder wieder öffnen lässt. Die endgültige Prüfung
/// (Reihenfolge der Monate, nur der zuletzt abgeschlossene lässt sich öffnen) macht der Server.
public struct ClosingState: Hashable, Sendable {
    public let canClose: Bool
    public let canReopen: Bool
    /// Erklärung unter dem Knopf
    public let note: String

    public init(budget: BudgetMonth, current: YearMonth = .current()) {
        if budget.closed {
            canClose = false
            canReopen = true
            note = "Abgeschlossen. Zuweisungen sind gesperrt. Öffnen geht nur beim zuletzt abgeschlossenen Monat."
        } else if let start = budget.startMonth, budget.month < start {
            canClose = false
            canReopen = false
            note = "Vor dem Budgetbeginn (\(start.title))."
        } else if budget.month >= current {
            canClose = false
            canReopen = false
            note = "Abschließen geht, wenn der Monat vorbei ist."
        } else if budget.unconfirmedTransactions > 0 {
            canClose = false
            canReopen = false
            let n = budget.unconfirmedTransactions
            note = n == 1 ? "Erst die wartende Buchung bestätigen." : "Erst die \(n) wartenden Buchungen bestätigen."
        } else {
            canClose = true
            canReopen = false
            note = "Hält den Stand fest. Danach nimmt der Monat keine Zuweisungen mehr an."
        }
    }
}

/// Geld zwischen „Noch ohne Aufgabe“ und Töpfen umschichten.
public enum MoveMoney {
    public enum Source: Hashable, Sendable {
        /// aus „Noch ohne Aufgabe“
        case readyToAssign
        case pot(String)
    }

    /// Eine Umschichtung, wie `POST …/budget/{Monat}/moves` sie nimmt. Der Server senkt die
    /// Quelle und erhöht das Ziel in einer Transaktion: Lehnt er ab, ändert sich nichts.
    public struct Request: Hashable, Sendable {
        /// nil = aus „Noch ohne Aufgabe“
        public let fromPotId: String?
        public let toPotId: String
        public let amountCents: Int

        public init(fromPotId: String?, toPotId: String, amountCents: Int) {
            self.fromPotId = fromPotId
            self.toPotId = toPotId
            self.amountCents = amountCents
        }
    }

    public enum Problem: Error, Equatable, Sendable, CustomStringConvertible {
        case amountNotPositive
        case sameSourceAndTarget
        case unknownPot
        case monthClosed
        case notEnoughInPot(name: String, availableCents: Int)

        public var description: String {
            switch self {
            case .amountNotPositive: "Bitte einen Betrag über 0 eingeben."
            case .sameSourceAndTarget: "Quelle und Ziel sind derselbe Topf."
            case .unknownPot: "Diesen Topf gibt es im Monat nicht."
            case .monthClosed: "Der Monat ist abgeschlossen."
            case let .notEnoughInPot(name, available):
                "In „\(name)“ sind nur \(Money.format(max(0, available))) verfügbar."
            }
        }
    }

    /// Umschichtung prüfen, soweit die App es aus dem Budget sieht. Aus „Noch ohne Aufgabe“ prüft
    /// erst der Server, ob genug da ist, und liefert sonst seine Meldung.
    public static func request(
        in budget: BudgetMonth, from source: Source, to targetId: String, amountCents: Int
    ) throws(Problem) -> Request {
        guard amountCents > 0 else { throw .amountNotPositive }
        guard !budget.closed else { throw .monthClosed }
        guard let target = budget.pots.first(where: { $0.potId == targetId }), !target.archived else { throw .unknownPot }
        guard case let .pot(sourceId) = source else {
            return Request(fromPotId: nil, toPotId: target.potId, amountCents: amountCents)
        }
        guard sourceId != targetId else { throw .sameSourceAndTarget }
        guard let from = budget.pots.first(where: { $0.potId == sourceId }) else { throw .unknownPot }
        guard from.availableCents >= amountCents else {
            throw .notEnoughInPot(name: from.name, availableCents: from.availableCents)
        }
        return Request(fromPotId: sourceId, toPotId: target.potId, amountCents: amountCents)
    }
}

// MARK: - Dienst

extension FreiraumService {
    /// Zuweisung setzen und das Budget danach liefern.
    public func setAssignment(householdId: String, month: YearMonth, potId: String, assignedCents: Int) async throws(APIError) -> BudgetMonth {
        try await call {
            let out = try await client.putV1HouseholdsHouseholdIdBudgetMonthPotsPotId(
                path: .init(householdId: householdId, month: month.description, potId: potId),
                body: .json(.init(assignedCents: assignedCents))
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetMonth(try ok.body.json)
        }
    }

    /// Monat abschließen. Der Server lehnt mit 409 ab, wenn der Monat noch läuft, ein früherer
    /// offen ist oder Buchungen warten.
    public func closeMonth(householdId: String, month: YearMonth) async throws(APIError) -> BudgetMonth {
        try await call {
            let out = try await client.postV1HouseholdsHouseholdIdBudgetMonthClosing(
                path: .init(householdId: householdId, month: month.description)
            )
            guard case let .created(created) = out else { throw unexpected(out) }
            return try BudgetMonth(try created.body.json)
        }
    }

    /// Abschluss zurücknehmen (nur der zuletzt abgeschlossene Monat, sonst 409).
    public func reopenMonth(householdId: String, month: YearMonth) async throws(APIError) -> BudgetMonth {
        try await call {
            let out = try await client.deleteV1HouseholdsHouseholdIdBudgetMonthClosing(
                path: .init(householdId: householdId, month: month.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetMonth(try ok.body.json)
        }
    }

    /// Umschichten in einem Schritt. Lehnt der Server ab (etwa 422, weil „Noch ohne Aufgabe“
    /// nicht reicht), ändert sich nichts, und sein Fehler kommt durch.
    public func move(householdId: String, month: YearMonth, _ move: MoveMoney.Request) async throws(APIError) -> BudgetMonth {
        try await call {
            let out = try await client.postV1HouseholdsHouseholdIdBudgetMonthMoves(
                path: .init(householdId: householdId, month: month.description),
                body: .json(.init(fromPotId: move.fromPotId, toPotId: move.toPotId, amountCents: move.amountCents))
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetMonth(try ok.body.json)
        }
    }
}
