#if os(macOS)
import FreiraumKit
import SwiftUI

/// Geldfluss als Sankey. Das Layout rechnet `SankeyLayout` (FreiraumKit, getestet); hier wird
/// nur gezeichnet. Farbe nur mit Bedeutung: Minze = Erst ich, Blau = gemeinsam, Violett =
/// privat, Orange = aus Erspartem, Grau = übrig oder nicht zugeordnet.
struct SankeyView: View {
    let flow: MoneyFlow
    /// Art des Haushalts beim Geldfluss eines Haushalts
    let householdKind: Household.Kind
    /// Art je Haushalt beim Geldfluss über Haushalte (Knoten nennen ihren Haushalt)
    var kinds: [String: Household.Kind] = [:]

    @State private var hovered: SankeyLayout.Link?
    @State private var pointer: CGPoint = .zero

    private let leftMargin: Double = 150
    private let rightMargin: Double = 190

    var body: some View {
        GeometryReader { geo in
            let layout = SankeyLayout(
                flow: flow, width: max(100, geo.size.width - leftMargin - rightMargin),
                height: max(100, geo.size.height - 8), nodeWidth: 14, nodePadding: 14
            )
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    context.translateBy(x: leftMargin, y: 4)
                    for link in layout.links {
                        let color = linkColor(link, in: layout)
                        let opacity = hovered == nil ? 0.30 : (hovered == link ? 0.55 : 0.14)
                        context.fill(ribbon(link), with: .color(color.opacity(opacity)))
                    }
                    for node in layout.nodes {
                        let rect = CGRect(x: node.x0, y: node.y0, width: node.x1 - node.x0, height: max(1, node.height))
                        context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(nodeColor(node)))
                    }
                }
                ForEach(layout.nodes) { node in
                    label(node, layout: layout)
                }
                if let hovered {
                    tooltip(hovered, layout: layout)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case let .active(point):
                    pointer = point
                    hovered = layout.link(atX: point.x - leftMargin, y: point.y - 4)
                case .ended:
                    hovered = nil
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Geldfluss")
            .accessibilityValue(description(layout))
        }
    }

    // MARK: Zeichnen

    /// Band als Fläche zwischen zwei kubischen Kurven (Kontrollpunkte auf halber Strecke).
    private func ribbon(_ l: SankeyLayout.Link) -> Path {
        let mid = (l.x0 + l.x1) / 2
        var p = Path()
        p.move(to: CGPoint(x: l.x0, y: l.sourceY0))
        p.addCurve(to: CGPoint(x: l.x1, y: l.targetY0),
                   control1: CGPoint(x: mid, y: l.sourceY0), control2: CGPoint(x: mid, y: l.targetY0))
        p.addLine(to: CGPoint(x: l.x1, y: l.targetY1))
        p.addCurve(to: CGPoint(x: l.x0, y: l.sourceY1),
                   control1: CGPoint(x: mid, y: l.targetY1), control2: CGPoint(x: mid, y: l.sourceY1))
        p.closeSubpath()
        return p
    }

    /// Blau = gemeinsam, Violett = privat; beim Geldfluss über Haushalte je Knoten.
    private func householdColor(_ node: SankeyLayout.Node?) -> Color {
        let kind = node?.householdId.flatMap { kinds[$0] } ?? householdKind
        return kind == .gemeinsam ? Theme.shared : Theme.personal
    }

    private func nodeColor(_ node: SankeyLayout.Node) -> Color {
        switch node.kind {
        case .haushalt: householdColor(node)
        case .quelle: node.localId == "quelle:erspartes" ? Theme.warning : householdColor(node)
        case .einzahlung: Theme.shared
        case .gruppe: Theme.text.opacity(0.85)
        case .topf: node.potKind == .erstIch ? Theme.accent : Theme.text.opacity(0.85)
        case .rest: Theme.secondary
        }
    }

    /// Band in der Farbe des Endes, das nicht der Haushalt ist (Quelle links, Ziel rechts);
    /// zwischen zwei Haushalten (Einzahlung) in der Farbe des Ziels.
    private func linkColor(_ link: SankeyLayout.Link, in layout: SankeyLayout) -> Color {
        let end = layout.node(link.source)?.kind == .haushalt ? layout.node(link.target) : layout.node(link.source)
        guard let end else { return householdColor(nil) }
        if end.kind == .topf, end.potKind == .erstIch { return Theme.accent }
        if end.localId == "quelle:erspartes" { return Theme.warning }
        if end.kind == .rest { return Theme.secondary }
        if end.kind == .einzahlung { return Theme.shared }
        return householdColor(end)
    }

    // MARK: Beschriftung

    private func label(_ node: SankeyLayout.Node, layout: SankeyLayout) -> some View {
        let leading = layout.labelLeading(node)
        let width = leading ? leftMargin - 14 : rightMargin - 14
        let x = leading ? leftMargin + node.x0 - 10 - width / 2 : leftMargin + node.x1 + 10 + width / 2
        return VStack(alignment: leading ? .trailing : .leading, spacing: 1) {
            Text(node.label)
                .font(.callout.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(Money.format(node.valueCents))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Theme.secondary)
        }
        .lineLimit(1)
        .truncationMode(.tail)
        .padding(.horizontal, 4)
        .background(node.column > 0 && !leading ? Theme.background.opacity(0.6) : .clear, in: .rect(cornerRadius: 4))
        .frame(width: width, alignment: leading ? .trailing : .leading)
        .position(x: x, y: 4 + node.midY)
        .allowsHitTesting(false)
    }

    private func tooltip(_ link: SankeyLayout.Link, layout: SankeyLayout) -> some View {
        let from = layout.node(link.source)?.label ?? link.source
        let to = layout.node(link.target)?.label ?? link.target
        return Text("\(from) → \(to): \(Money.format(link.valueCents))")
            .font(.callout.weight(.semibold))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .rect(cornerRadius: 10))
            .fixedSize()
            .offset(x: pointer.x + 14, y: pointer.y + 14)
            .allowsHitTesting(false)
    }

    /// Für VoiceOver: jede Verbindung als Satz.
    private func description(_ layout: SankeyLayout) -> String {
        layout.links.map { l in
            "\(layout.node(l.source)?.label ?? l.source) nach \(layout.node(l.target)?.label ?? l.target): \(Money.format(l.valueCents))"
        }
        .joined(separator: ". ")
    }
}
#endif
