import Foundation
import FreiraumAPI

// Auswertungen eines Haushalts (ADR 0005, in der App seit FREI-21). Der Server rechnet jede
// Kennzahl, die App zeichnet nur. Anteile kommen als Basispunkte (10 000 = 100 %), ohne
// Einkommen als nil.

/// Kennzahlen eines Monats oder eines Zeitraums.
public struct MetricValues: Hashable, Sendable, Codable {
    public let incomeCents: Int
    /// Konsum, positiv = ausgegeben
    public let consumptionCents: Int
    public let erstIchCents: Int
    /// Einzahlungen ins Gemeinsame vom privaten Konto, positiv = abgeflossen
    public let contributionsCents: Int
    public let savedCents: Int
    public let savingsRateBp: Int?
    public let fixedCostsCents: Int
    public let fixedCostShareBp: Int?
    public let uncategorizedOutCents: Int
    public let uncategorizedInCents: Int

    public init(
        incomeCents: Int = 0, consumptionCents: Int = 0, erstIchCents: Int = 0, contributionsCents: Int = 0,
        savedCents: Int = 0, savingsRateBp: Int? = nil, fixedCostsCents: Int = 0, fixedCostShareBp: Int? = nil,
        uncategorizedOutCents: Int = 0, uncategorizedInCents: Int = 0
    ) {
        self.incomeCents = incomeCents
        self.consumptionCents = consumptionCents
        self.erstIchCents = erstIchCents
        self.contributionsCents = contributionsCents
        self.savedCents = savedCents
        self.savingsRateBp = savingsRateBp
        self.fixedCostsCents = fixedCostsCents
        self.fixedCostShareBp = fixedCostShareBp
        self.uncategorizedOutCents = uncategorizedOutCents
        self.uncategorizedInCents = uncategorizedInCents
    }
}

public struct MonthMetrics: Hashable, Sendable, Codable, Identifiable {
    public var id: YearMonth { month }
    public let month: YearMonth
    public let values: MetricValues
    /// Alter des Geldes am Monatsende (im laufenden Monat: heute); nil ohne bekannte Eingänge.
    public let ageOfMoneyDays: Int?

    public init(month: YearMonth, values: MetricValues, ageOfMoneyDays: Int? = nil) {
        self.month = month
        self.values = values
        self.ageOfMoneyDays = ageOfMoneyDays
    }
}

public struct Runway: Hashable, Sendable, Codable {
    /// Geld des Haushalts heute
    public let cashCents: Int
    public let averageMonthlyConsumptionCents: Int?
    public let fixedContributionsCents: Int
    /// Konsum im Schnitt + feste Einzahlungen; nil ohne Historie
    public let monthlyOutflowCents: Int?
    public let basedOnMonths: Int
    /// Monate ohne Einkommen, eine Nachkommastelle; nil ohne Historie
    public let months: Double?

    public init(
        cashCents: Int, averageMonthlyConsumptionCents: Int? = nil, fixedContributionsCents: Int = 0,
        monthlyOutflowCents: Int? = nil, basedOnMonths: Int = 0, months: Double? = nil
    ) {
        self.cashCents = cashCents
        self.averageMonthlyConsumptionCents = averageMonthlyConsumptionCents
        self.fixedContributionsCents = fixedContributionsCents
        self.monthlyOutflowCents = monthlyOutflowCents
        self.basedOnMonths = basedOnMonths
        self.months = months
    }
}

public struct Metrics: Hashable, Sendable, Codable {
    public let householdId: String
    public let from: YearMonth
    public let to: YearMonth
    public let months: [MonthMetrics]
    public let totals: MetricValues
    public let runway: Runway

    public init(householdId: String, from: YearMonth, to: YearMonth, months: [MonthMetrics], totals: MetricValues, runway: Runway) {
        self.householdId = householdId
        self.from = from
        self.to = to
        self.months = months
        self.totals = totals
        self.runway = runway
    }
}

/// Geldfluss als Sankey: Quellen → Haushalt → Gruppen → Töpfe. Die Mitte ist ausgeglichen.
public struct MoneyFlow: Hashable, Sendable, Codable {
    public struct Node: Hashable, Sendable, Codable, Identifiable {
        public enum Kind: String, Sendable, Codable { case quelle, haushalt, gruppe, topf, rest }

        public let id: String
        public let label: String
        public let kind: Kind
        public let potId: String?
        public let potKind: PotKind?

        public init(id: String, label: String, kind: Kind, potId: String? = nil, potKind: PotKind? = nil) {
            self.id = id
            self.label = label
            self.kind = kind
            self.potId = potId
            self.potKind = potKind
        }
    }

    public struct Link: Hashable, Sendable, Codable {
        public let source: String
        public let target: String
        /// immer positiv
        public let valueCents: Int

        public init(source: String, target: String, valueCents: Int) {
            self.source = source
            self.target = target
            self.valueCents = valueCents
        }
    }

    public let householdId: String
    public let from: YearMonth
    public let to: YearMonth
    public let nodes: [Node]
    public let links: [Link]
    public let inCents: Int
    public let outCents: Int

    public init(householdId: String, from: YearMonth, to: YearMonth, nodes: [Node], links: [Link], inCents: Int, outCents: Int) {
        self.householdId = householdId
        self.from = from
        self.to = to
        self.nodes = nodes
        self.links = links
        self.inCents = inCents
        self.outCents = outCents
    }
}

public struct Anomaly: Hashable, Sendable, Codable {
    public enum Kind: String, Sendable, Codable {
        case ausgabenHoch = "ausgaben_hoch"
        case neuesAbo = "neues_abo"
        case preisErhoeht = "preis_erhoeht"
    }

    public let kind: Kind
    /// Ein Satz für die Anzeige, vom Server formuliert.
    public let title: String
    public let potId: String?
    public let seriesId: String?
    public let amountCents: Int
    public let referenceCents: Int?

    public init(kind: Kind, title: String, potId: String? = nil, seriesId: String? = nil, amountCents: Int, referenceCents: Int? = nil) {
        self.kind = kind
        self.title = title
        self.potId = potId
        self.seriesId = seriesId
        self.amountCents = amountCents
        self.referenceCents = referenceCents
    }
}

public struct GoalForecast: Hashable, Sendable, Codable, Identifiable {
    public enum Status: String, Sendable, Codable {
        case erreicht
        case imPlan = "im_plan"
        case verspaetet
        case ohneSparrate = "ohne_sparrate"
    }

    public var id: String { potId }
    public let potId: String
    public let name: String
    public let targetCents: Int
    public let savedCents: Int
    public let remainingCents: Int
    public let progressBp: Int
    public let targetMonth: YearMonth?
    public let monthlyRateCents: Int
    public let projectedMonth: YearMonth?
    public let requiredMonthlyCents: Int?
    public let status: Status

    public init(
        potId: String, name: String, targetCents: Int, savedCents: Int, remainingCents: Int, progressBp: Int,
        targetMonth: YearMonth? = nil, monthlyRateCents: Int = 0, projectedMonth: YearMonth? = nil,
        requiredMonthlyCents: Int? = nil, status: Status
    ) {
        self.potId = potId
        self.name = name
        self.targetCents = targetCents
        self.savedCents = savedCents
        self.remainingCents = remainingCents
        self.progressBp = progressBp
        self.targetMonth = targetMonth
        self.monthlyRateCents = monthlyRateCents
        self.projectedMonth = projectedMonth
        self.requiredMonthlyCents = requiredMonthlyCents
        self.status = status
    }
}

public struct AssetCosts: Hashable, Sendable, Codable, Identifiable {
    public enum Classification: String, Sendable, Codable { case verbindlichkeit, vermoegenswert, neutral }

    public struct PotCost: Hashable, Sendable, Codable, Identifiable {
        public var id: String { potId }
        public let potId: String
        public let name: String
        public let costCents: Int

        public init(potId: String, name: String, costCents: Int) {
            self.potId = potId
            self.name = name
            self.costCents = costCents
        }
    }

    public var id: String { assetId }
    public let assetId: String
    public let name: String
    public let valueCents: Int?
    /// Nettokosten im Zeitraum, positiv = kostet
    public let costCents: Int
    public let recurringCostCents: Int
    public let monthlyAverageCents: Int
    public let annualCostOfValueBp: Int?
    public let classification: Classification
    public let pots: [PotCost]

    public init(
        assetId: String, name: String, valueCents: Int? = nil, costCents: Int, recurringCostCents: Int = 0,
        monthlyAverageCents: Int = 0, annualCostOfValueBp: Int? = nil, classification: Classification, pots: [PotCost] = []
    ) {
        self.assetId = assetId
        self.name = name
        self.valueCents = valueCents
        self.costCents = costCents
        self.recurringCostCents = recurringCostCents
        self.monthlyAverageCents = monthlyAverageCents
        self.annualCostOfValueBp = annualCostOfValueBp
        self.classification = classification
        self.pots = pots
    }
}

public struct OwnershipCosts: Hashable, Sendable, Codable {
    public let householdId: String
    public let from: YearMonth
    public let to: YearMonth
    public let items: [AssetCosts]
    public let totalCostCents: Int
    public let shareOfConsumptionBp: Int?

    public init(householdId: String, from: YearMonth, to: YearMonth, items: [AssetCosts], totalCostCents: Int, shareOfConsumptionBp: Int? = nil) {
        self.householdId = householdId
        self.from = from
        self.to = to
        self.items = items
        self.totalCostCents = totalCostCents
        self.shareOfConsumptionBp = shareOfConsumptionBp
    }
}

// MARK: - Dienst

extension FreiraumService {
    /// Kennzahlen je Monat im Zeitraum (höchstens 120 Monate), dazu der Runway.
    public func metrics(householdId: String, from: YearMonth, to: YearMonth) async throws(APIError) -> Metrics {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdAnalyticsMetrics(
                path: .init(householdId: householdId),
                query: .init(from: from.description, to: to.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try Metrics(try ok.body.json)
        }
    }

    /// Geldfluss im Zeitraum.
    public func flow(householdId: String, from: YearMonth, to: YearMonth) async throws(APIError) -> MoneyFlow {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdAnalyticsFlow(
                path: .init(householdId: householdId),
                query: .init(from: from.description, to: to.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try MoneyFlow(try ok.body.json)
        }
    }

    /// Auffälligkeiten eines Monats.
    public func anomalies(householdId: String, month: YearMonth) async throws(APIError) -> [Anomaly] {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdAnalyticsAnomalies(
                path: .init(householdId: householdId),
                query: .init(month: month.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(Anomaly.init)
        }
    }

    /// Ziel-Töpfe mit Prognose (immer zum laufenden Monat).
    public func goals(householdId: String) async throws(APIError) -> [GoalForecast] {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdAnalyticsGoals(path: .init(householdId: householdId))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try ok.body.json.items.map(GoalForecast.init)
        }
    }

    /// Besitzkosten im Zeitraum.
    public func ownershipCosts(householdId: String, from: YearMonth, to: YearMonth) async throws(APIError) -> OwnershipCosts {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdAnalyticsOwnershipCosts(
                path: .init(householdId: householdId),
                query: .init(from: from.description, to: to.description)
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try OwnershipCosts(try ok.body.json)
        }
    }
}

// MARK: - Abbildung

private func parseMonth(_ text: String) throws -> YearMonth {
    guard let value = YearMonth(text) else { throw MappingError(description: "Monat \(text)") }
    return value
}

extension MetricValues {
    init(_ t: Components.Schemas.MetricsTotals) {
        self.init(
            incomeCents: t.incomeCents, consumptionCents: t.consumptionCents, erstIchCents: t.erstIchCents,
            contributionsCents: t.contributionsCents, savedCents: t.savedCents, savingsRateBp: t.savingsRateBp,
            fixedCostsCents: t.fixedCostsCents, fixedCostShareBp: t.fixedCostShareBp,
            uncategorizedOutCents: t.uncategorizedOutCents, uncategorizedInCents: t.uncategorizedInCents
        )
    }
}

extension MonthMetrics {
    init(_ m: Components.Schemas.MonthMetrics) throws {
        self.init(
            month: try parseMonth(m.month),
            values: MetricValues(
                incomeCents: m.incomeCents, consumptionCents: m.consumptionCents, erstIchCents: m.erstIchCents,
                contributionsCents: m.contributionsCents, savedCents: m.savedCents, savingsRateBp: m.savingsRateBp,
                fixedCostsCents: m.fixedCostsCents, fixedCostShareBp: m.fixedCostShareBp,
                uncategorizedOutCents: m.uncategorizedOutCents, uncategorizedInCents: m.uncategorizedInCents
            ),
            ageOfMoneyDays: m.ageOfMoneyDays
        )
    }
}

extension Metrics {
    init(_ m: Components.Schemas.Metrics) throws {
        let r = m.runway
        self.init(
            householdId: m.householdId, from: try parseMonth(m.from), to: try parseMonth(m.to),
            months: try m.months.map(MonthMetrics.init),
            totals: MetricValues(m.totals),
            runway: Runway(
                cashCents: r.cashCents, averageMonthlyConsumptionCents: r.averageMonthlyConsumptionCents,
                fixedContributionsCents: r.fixedContributionsCents, monthlyOutflowCents: r.monthlyOutflowCents,
                basedOnMonths: r.basedOnMonths, months: r.months
            )
        )
    }
}

extension MoneyFlow {
    init(_ f: Components.Schemas.Flow) throws {
        self.init(
            householdId: f.householdId, from: try parseMonth(f.from), to: try parseMonth(f.to),
            nodes: try f.nodes.map { n in
                guard let kind = Node.Kind(rawValue: n.kind.rawValue) else {
                    throw MappingError(description: "Knotenart \(n.kind.rawValue)")
                }
                return Node(
                    id: n.id, label: n.label, kind: kind, potId: n.potId,
                    potKind: try n.potKind.map { try PotKind(raw: $0.rawValue) }
                )
            },
            links: f.links.map { Link(source: $0.source, target: $0.target, valueCents: $0.valueCents) },
            inCents: f.inCents, outCents: f.outCents
        )
    }
}

extension Anomaly {
    init(_ a: Components.Schemas.Anomaly) throws {
        guard let kind = Kind(rawValue: a.kind.rawValue) else { throw MappingError(description: "Auffälligkeit \(a.kind.rawValue)") }
        self.init(
            kind: kind, title: a.title, potId: a.potId, seriesId: a.seriesId,
            amountCents: a.amountCents, referenceCents: a.referenceCents
        )
    }
}

extension GoalForecast {
    init(_ g: Components.Schemas.GoalForecast) throws {
        guard let status = Status(rawValue: g.status.rawValue) else { throw MappingError(description: "Zielstatus \(g.status.rawValue)") }
        self.init(
            potId: g.potId, name: g.name, targetCents: g.targetCents, savedCents: g.savedCents,
            remainingCents: g.remainingCents, progressBp: g.progressBp,
            targetMonth: g.targetMonth.flatMap(YearMonth.init), monthlyRateCents: g.monthlyRateCents,
            projectedMonth: g.projectedMonth.flatMap(YearMonth.init), requiredMonthlyCents: g.requiredMonthlyCents,
            status: status
        )
    }
}

extension OwnershipCosts {
    init(_ o: Components.Schemas.OwnershipCosts) throws {
        self.init(
            householdId: o.householdId, from: try parseMonth(o.from), to: try parseMonth(o.to),
            items: try o.items.map { a in
                guard let c = AssetCosts.Classification(rawValue: a.classification.rawValue) else {
                    throw MappingError(description: "Einordnung \(a.classification.rawValue)")
                }
                return AssetCosts(
                    assetId: a.assetId, name: a.name, valueCents: a.valueCents, costCents: a.costCents,
                    recurringCostCents: a.recurringCostCents, monthlyAverageCents: a.monthlyAverageCents,
                    annualCostOfValueBp: a.annualCostOfValueBp, classification: c,
                    pots: a.pots.map { AssetCosts.PotCost(potId: $0.potId, name: $0.name, costCents: $0.costCents) }
                )
            },
            totalCostCents: o.totalCostCents, shareOfConsumptionBp: o.shareOfConsumptionBp
        )
    }
}
