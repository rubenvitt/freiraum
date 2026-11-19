// Geldfluss als Liste „woher/wohin“ für schmale Bildschirme (iPhone), statt eines Sankeys.
// Ohne SwiftUI, damit testbar.

/// Zu- und Abflüsse eines Haushalts, je Seite nach Betrag absteigend, mit Anteil an der Seite.
///
/// Gibt es genau einen Haushaltsknoten, sind „woher“ seine Zuflüsse (Quellen, Einzahlungen) und
/// „wohin“ seine direkten Abflüsse: Gruppen statt einzelner Töpfe, Einzahlung ins Gemeinsame,
/// Töpfe ohne Gruppe und „Übrig“. Sonst (Geldfluss über mehrere Haushalte) zählen die Knoten ohne
/// Zufluss als „woher“ und die ohne Abfluss als „wohin“. „Übrig“ steht immer zuletzt.
public struct FlowList: Hashable, Sendable {
    public struct Row: Hashable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let kind: MoneyFlow.Node.Kind
        public let potKind: PotKind?
        public let valueCents: Int
        /// „1.200 €“
        public let amount: String
        /// Anteil an der Seite als Text, „34 %“
        public let share: String
        /// Anteil an der Seite, 0…1 (für Balken)
        public let fraction: Double
        /// Zufluss aus Erspartem (Quelle „quelle:erspartes“): Monat lebte von Reserven
        public let fromSavings: Bool
    }

    public let incoming: [Row]
    public let outgoing: [Row]
    /// Summe „woher“; nil ohne Zufluss
    public let incomingTotal: String?
    /// Summe „wohin“; nil ohne Abfluss
    public let outgoingTotal: String?

    public var isEmpty: Bool { incoming.isEmpty && outgoing.isEmpty }

    public init(flow: MoneyFlow) {
        let nodes = Dictionary(flow.nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let order = Dictionary(flow.nodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        let households = flow.nodes.filter { $0.kind == .haushalt }

        var inValues: [String: Int] = [:]
        var outValues: [String: Int] = [:]
        if households.count == 1, let household = households.first {
            for link in flow.links {
                if link.target == household.id { inValues[link.source, default: 0] += link.valueCents }
                if link.source == household.id { outValues[link.target, default: 0] += link.valueCents }
            }
        } else {
            let sources = Set(flow.links.map(\.source))
            let targets = Set(flow.links.map(\.target))
            for link in flow.links {
                if !targets.contains(link.source) { inValues[link.source, default: 0] += link.valueCents }
                if !sources.contains(link.target) { outValues[link.target, default: 0] += link.valueCents }
            }
        }

        func rows(_ values: [String: Int]) -> [Row] {
            let total = values.values.reduce(0, +)
            guard total > 0 else { return [] }
            let sorted = values.compactMap { id, value in nodes[id].map { ($0, value) } }
                .filter { $0.1 > 0 }
                .sorted { a, b in
                    let aRest = a.0.kind == .rest
                    let bRest = b.0.kind == .rest
                    if aRest != bRest { return bRest }
                    if a.1 != b.1 { return a.1 > b.1 }
                    return order[a.0.id, default: 0] < order[b.0.id, default: 0]
                }
            return sorted.map { node, value in
                Row(
                    id: node.id, label: node.label, kind: node.kind, potKind: node.potKind, valueCents: value,
                    amount: Money.format(value),
                    share: RatioText.format((value * 10_000 + total / 2) / total),
                    fraction: Double(value) / Double(total),
                    fromSavings: node.kind == .quelle && node.localId == "quelle:erspartes"
                )
            }
        }

        incoming = rows(inValues)
        outgoing = rows(outValues)
        let inTotal = incoming.reduce(0) { $0 + $1.valueCents }
        let outTotal = outgoing.reduce(0) { $0 + $1.valueCents }
        incomingTotal = inTotal > 0 ? Money.format(inTotal) : nil
        outgoingTotal = outTotal > 0 ? Money.format(outTotal) : nil
    }
}
