import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private func node(_ id: String, _ kind: MoneyFlow.Node.Kind, _ label: String? = nil, pot: PotKind? = nil) -> MoneyFlow.Node {
    MoneyFlow.Node(id: id, label: label ?? id, kind: kind, potId: kind == .topf ? id : nil, potKind: pot)
}

private func link(_ s: String, _ t: String, _ v: Int) -> MoneyFlow.Link {
    MoneyFlow.Link(source: s, target: t, valueCents: v)
}

/// Wie die API ihn liefert: Haushalt zuerst, Quellen, Gruppen mit Töpfen, Töpfe ohne Gruppe, Rest.
private let sample = MoneyFlow(
    householdId: "h1", from: YearMonth(year: 2026, month: 11), to: YearMonth(year: 2026, month: 11),
    nodes: [
        node("haushalt", .haushalt, "Ich"),
        node("quelle:1", .quelle, "Gehalt"),
        node("quelle:2", .quelle, "Nebenjob"),
        node("gruppe:1", .gruppe, "Wohnen"),
        node("topf:miete", .topf, "Miete", pot: .monatlich),
        node("topf:strom", .topf, "Strom", pot: .monatlich),
        node("topf:depot", .topf, "Depot", pot: .erstIch),
        node("rest:uebrig", .rest, "Übrig"),
    ],
    links: [
        link("quelle:1", "haushalt", 300_000),
        link("quelle:2", "haushalt", 50_000),
        link("haushalt", "gruppe:1", 120_000),
        link("gruppe:1", "topf:miete", 100_000),
        link("gruppe:1", "topf:strom", 20_000),
        link("haushalt", "topf:depot", 50_000),
        link("haushalt", "rest:uebrig", 180_000),
    ],
    inCents: 350_000, outCents: 170_000
)

@Suite struct SankeyTests {
    let layout = SankeyLayout(flow: sample, width: 1000, height: 500, nodeWidth: 14, nodePadding: 10)

    @Test func spaltenNachLaengstemWegUndSenkenRechts() {
        #expect(layout.columns == 4)
        #expect(layout.node("quelle:1")?.column == 0)
        #expect(layout.node("haushalt")?.column == 1)
        #expect(layout.node("gruppe:1")?.column == 2)
        #expect(layout.node("topf:miete")?.column == 3)
        // Direkt am Haushalt, aber ohne Ausgang: ganz rechts wie die anderen Töpfe.
        #expect(layout.node("topf:depot")?.column == 3)
        #expect(layout.node("rest:uebrig")?.column == 3)
        #expect(layout.node("quelle:1")?.x0 == 0)
        #expect(layout.node("topf:miete")?.x1 == 1000)
        #expect(layout.labelLeading(layout.node("quelle:1")!))
        #expect(!layout.labelLeading(layout.node("topf:miete")!))
    }

    @Test func gemeinsamerMassstabFuelltDieVollsteSpalte() throws {
        // Spalte 3: 350.000 Cent in vier Knoten, drei Abstände.
        let expected = (500.0 - 3 * 10) / 350_000
        #expect(abs(layout.scale - expected) < 1e-12)
        let haushalt = try #require(layout.node("haushalt"))
        #expect(abs(haushalt.height - 350_000 * expected) < 1e-9)
        // Gleicher Betrag, gleiche Dicke, egal in welcher Spalte.
        let gehalt = try #require(layout.node("quelle:1"))
        #expect(abs(gehalt.height - 300_000 * expected) < 1e-9)
        // Haushalt steht allein in seiner Spalte und ist vertikal mittig.
        #expect(abs(haushalt.midY - 250) < 1e-9)
    }

    @Test func baenderSchliessenLueckenlosAnDieKnotenAn() throws {
        for n in layout.nodes {
            let outs = layout.links.filter { $0.source == n.id }.sorted { $0.sourceY0 < $1.sourceY0 }
            let ins = layout.links.filter { $0.target == n.id }.sorted { $0.targetY0 < $1.targetY0 }
            for list in [outs.map { ($0.sourceY0, $0.sourceY1) }, ins.map { ($0.targetY0, $0.targetY1) }] where !list.isEmpty {
                #expect(abs(list.first!.0 - n.y0) < 1e-9, "\(n.id) beginnt oben")
                for (a, b) in zip(list, list.dropFirst()) {
                    #expect(abs(a.1 - b.0) < 1e-9, "\(n.id) ohne Lücke")
                }
            }
        }
        let miete = try #require(layout.links.first { $0.target == "topf:miete" })
        #expect(abs((miete.sourceY1 - miete.sourceY0) - (miete.targetY1 - miete.targetY0)) < 1e-9)
        #expect(miete.x0 == layout.node("gruppe:1")?.x1)
        #expect(miete.x1 == layout.node("topf:miete")?.x0)
    }

    @Test func reihenfolgeInDerSpalteWieVonDerAPI() throws {
        let miete = try #require(layout.node("topf:miete"))
        let strom = try #require(layout.node("topf:strom"))
        let depot = try #require(layout.node("topf:depot"))
        let rest = try #require(layout.node("rest:uebrig"))
        #expect(miete.y1 < strom.y0)
        #expect(strom.y1 < depot.y0)
        #expect(depot.y1 < rest.y0)
        // Abgehende Bänder des Haushalts folgen der Lage ihrer Ziele.
        let fromHousehold = layout.links.filter { $0.source == "haushalt" }.sorted { $0.sourceY0 < $1.sourceY0 }
        #expect(fromHousehold.map(\.target) == ["gruppe:1", "topf:depot", "rest:uebrig"])
    }

    @Test func trefferBeimUeberfahren() throws {
        let gehalt = try #require(layout.links.first { $0.source == "quelle:1" })
        // Am Anfang des Bands, mittig in seiner Dicke.
        let hit = layout.link(atX: gehalt.x0 + 0.1, y: (gehalt.sourceY0 + gehalt.sourceY1) / 2)
        #expect(hit?.source == "quelle:1")
        // Am Ende des Bands, beim Haushalt.
        let end = layout.link(atX: gehalt.x1 - 0.1, y: (gehalt.targetY0 + gehalt.targetY1) / 2)
        #expect(end?.source == "quelle:1")
        // Auf einem Knoten, über allen Bändern oder außerhalb: kein Band.
        #expect(layout.link(atX: 5, y: 100) == nil)
        #expect(layout.link(atX: gehalt.x0 + 0.1, y: gehalt.sourceY0 - 1) == nil)
        #expect(layout.link(atX: -10, y: 100) == nil)
        #expect(layout.link(atX: 2_000, y: 100) == nil)
    }

    @Test func leererFlussUndUngueltigeKanten() {
        let empty = SankeyLayout(
            flow: MoneyFlow(householdId: "h1", from: YearMonth(year: 2026, month: 11), to: YearMonth(year: 2026, month: 11),
                            nodes: [node("haushalt", .haushalt)], links: [], inCents: 0, outCents: 0),
            width: 800, height: 400
        )
        #expect(empty.nodes.isEmpty)
        #expect(empty.links.isEmpty)
        #expect(empty.columns == 0)

        let odd = SankeyLayout(
            flow: MoneyFlow(
                householdId: "h1", from: YearMonth(year: 2026, month: 11), to: YearMonth(year: 2026, month: 11),
                nodes: [node("haushalt", .haushalt), node("quelle:1", .quelle)],
                links: [link("quelle:1", "haushalt", 1_000), link("quelle:1", "fehlt", 500), link("haushalt", "haushalt", 10),
                        link("quelle:1", "haushalt", 0)],
                inCents: 1_000, outCents: 0
            ),
            width: 800, height: 400
        )
        #expect(odd.links.count == 1)
        #expect(odd.columns == 2)
        #expect(odd.node("haushalt")?.x1 == 800)
    }

    @Test func kreisLaeuftNichtEndlos() {
        let loop = SankeyLayout(
            flow: MoneyFlow(
                householdId: "h1", from: YearMonth(year: 2026, month: 11), to: YearMonth(year: 2026, month: 11),
                nodes: [node("a", .quelle), node("b", .haushalt), node("c", .topf)],
                links: [link("a", "b", 100), link("b", "c", 100), link("c", "b", 50)],
                inCents: 100, outCents: 100
            ),
            width: 600, height: 300
        )
        #expect(loop.nodes.count == 3)
        #expect(loop.columns <= 3)
    }
}
