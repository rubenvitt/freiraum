/// Layout eines Sankey-Diagramms für den Geldfluss, ohne SwiftUI (testbar unter Linux).
///
/// Spalten ergeben sich aus dem längsten Weg von einer Quelle. Knoten ohne Ausgang (Töpfe,
/// „Übrig“) stehen immer in der letzten Spalte, auch wenn sie direkt am Haushalt hängen. Alle
/// Spalten teilen einen Maßstab (Pixel je Cent), damit gleiche Beträge gleich dick sind. Die
/// Reihenfolge innerhalb einer Spalte ist die der API (Gruppen und Töpfe wie im Budget).
public struct SankeyLayout: Hashable, Sendable {
    public struct Node: Hashable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let kind: MoneyFlow.Node.Kind
        public let potKind: PotKind?
        public let column: Int
        /// Durchfluss: das Größere aus Zu- und Abfluss
        public let valueCents: Int
        public let x0: Double
        public let x1: Double
        public let y0: Double
        public let y1: Double

        public var height: Double { y1 - y0 }
        public var midY: Double { (y0 + y1) / 2 }
    }

    public struct Link: Hashable, Sendable, Identifiable {
        public var id: String { "\(source)→\(target)" }
        public let source: String
        public let target: String
        public let valueCents: Int
        /// rechter Rand der Quelle
        public let x0: Double
        /// linker Rand des Ziels
        public let x1: Double
        /// Band an der Quelle, oben und unten
        public let sourceY0: Double
        public let sourceY1: Double
        /// Band am Ziel, oben und unten
        public let targetY0: Double
        public let targetY1: Double

        public var thickness: Double { sourceY1 - sourceY0 }
    }

    public let width: Double
    public let height: Double
    public let nodes: [Node]
    public let links: [Link]
    /// Anzahl der Spalten (0 ohne Knoten)
    public let columns: Int
    /// Pixel je Cent
    public let scale: Double

    public init(flow: MoneyFlow, width: Double, height: Double, nodeWidth: Double = 14, nodePadding: Double = 12) {
        self.width = width
        self.height = height

        let known = Set(flow.nodes.map(\.id))
        let links = flow.links.filter {
            $0.valueCents > 0 && $0.source != $0.target && known.contains($0.source) && known.contains($0.target)
        }
        var incoming: [String: Int] = [:]
        var outgoing: [String: Int] = [:]
        for link in links {
            outgoing[link.source, default: 0] += link.valueCents
            incoming[link.target, default: 0] += link.valueCents
        }
        // Knoten ohne jede Verbindung zeichnen wir nicht.
        let used = flow.nodes.filter { incoming[$0.id] != nil || outgoing[$0.id] != nil }

        // Spalte = längster Weg von einer Quelle. Höchstens so viele Runden wie Knoten, damit ein
        // (fehlerhafter) Kreis nicht endlos läuft.
        var depth = Dictionary(used.map { ($0.id, 0) }, uniquingKeysWith: { a, _ in a })
        for _ in 0..<max(1, used.count) {
            var changed = false
            for link in links {
                let next = (depth[link.source] ?? 0) + 1
                if next > depth[link.target] ?? 0, next < used.count {
                    depth[link.target] = next
                    changed = true
                }
            }
            if !changed { break }
        }
        let last = depth.values.max() ?? 0
        for node in used where outgoing[node.id] == nil && incoming[node.id] != nil {
            depth[node.id] = last
        }
        columns = used.isEmpty ? 0 : last + 1

        // Gemeinsamer Maßstab: die vollste Spalte füllt die Höhe.
        func value(_ id: String) -> Int { max(incoming[id] ?? 0, outgoing[id] ?? 0) }
        let byColumn = (0..<columns).map { c in used.filter { depth[$0.id] == c } }
        var scale = Double.infinity
        for column in byColumn where !column.isEmpty {
            let sum = column.reduce(0) { $0 + value($1.id) }
            guard sum > 0 else { continue }
            let room = height - nodePadding * Double(column.count - 1)
            scale = min(scale, max(0, room) / Double(sum))
        }
        if !scale.isFinite { scale = 0 }
        self.scale = scale

        let step = columns > 1 ? (width - nodeWidth) / Double(columns - 1) : 0
        var placed: [String: Node] = [:]
        var order: [Node] = []
        for (c, column) in byColumn.enumerated() {
            let total = column.reduce(0.0) { $0 + Double(value($1.id)) * scale } + nodePadding * Double(max(0, column.count - 1))
            var y = max(0, (height - total) / 2)
            let x0 = Double(c) * step
            for node in column {
                let h = Double(value(node.id)) * scale
                let n = Node(
                    id: node.id, label: node.label, kind: node.kind, potKind: node.potKind, column: c,
                    valueCents: value(node.id), x0: x0, x1: x0 + nodeWidth, y0: y, y1: y + h
                )
                placed[node.id] = n
                order.append(n)
                y += h + nodePadding
            }
        }
        nodes = order

        // Bänder: an jedem Knoten von oben nach unten in der Reihenfolge der Gegenseite, damit
        // sich Bänder möglichst wenig kreuzen.
        let rank = Dictionary(links.enumerated().map { ($0.element.source + "\u{0}" + $0.element.target, $0.offset) },
                              uniquingKeysWith: { a, _ in a })
        func key(_ l: MoneyFlow.Link) -> String { l.source + "\u{0}" + l.target }
        var sourceOffset: [String: Double] = [:]
        var targetOffset: [String: Double] = [:]
        var startAt: [String: (Double, Double)] = [:]
        var endAt: [String: (Double, Double)] = [:]
        for node in order {
            let outs = links.filter { $0.source == node.id }.sorted {
                let a = placed[$0.target]!, b = placed[$1.target]!
                return (a.y0, rank[key($0)] ?? 0) < (b.y0, rank[key($1)] ?? 0)
            }
            for l in outs {
                let y = node.y0 + (sourceOffset[node.id] ?? 0)
                let h = Double(l.valueCents) * scale
                startAt[key(l)] = (y, y + h)
                sourceOffset[node.id, default: 0] += h
            }
            let ins = links.filter { $0.target == node.id }.sorted {
                let a = placed[$0.source]!, b = placed[$1.source]!
                return (a.y0, rank[key($0)] ?? 0) < (b.y0, rank[key($1)] ?? 0)
            }
            for l in ins {
                let y = node.y0 + (targetOffset[node.id] ?? 0)
                let h = Double(l.valueCents) * scale
                endAt[key(l)] = (y, y + h)
                targetOffset[node.id, default: 0] += h
            }
        }
        self.links = links.compactMap { l in
            guard let s = placed[l.source], let t = placed[l.target],
                  let start = startAt[key(l)], let end = endAt[key(l)] else { return nil }
            return Link(
                source: l.source, target: l.target, valueCents: l.valueCents, x0: s.x1, x1: t.x0,
                sourceY0: start.0, sourceY1: start.1, targetY0: end.0, targetY1: end.1
            )
        }
    }

    public func node(_ id: String) -> Node? {
        nodes.first { $0.id == id }
    }

    /// Band unter dem Zeiger (für den Hinweis beim Überfahren), oder nil. Die Bänder sind
    /// kubische Kurven mit beiden Kontrollpunkten auf halber Strecke; der Verlauf in der
    /// Senkrechten ist dann `3s² − 2s³`, mit s als Anteil der Strecke in der Waagrechten
    /// (genähert, für einen Treffer reicht das).
    public func link(atX x: Double, y: Double) -> Link? {
        links.last { l in
            guard l.x1 > l.x0, x >= l.x0, x <= l.x1 else { return false }
            let s = (x - l.x0) / (l.x1 - l.x0)
            let ease = s * s * (3 - 2 * s)
            let top = l.sourceY0 + (l.targetY0 - l.sourceY0) * ease
            let bottom = l.sourceY1 + (l.targetY1 - l.sourceY1) * ease
            return y >= top && y <= bottom
        }
    }

    /// Ob die Beschriftung links vom Knoten steht (erste Spalte) oder rechts.
    public func labelLeading(_ node: Node) -> Bool {
        node.column == 0 && columns > 1
    }
}
