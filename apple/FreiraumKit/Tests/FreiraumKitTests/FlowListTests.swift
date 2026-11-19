import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private func node(_ id: String, _ kind: MoneyFlow.Node.Kind, _ label: String? = nil, pot: PotKind? = nil) -> MoneyFlow.Node {
    MoneyFlow.Node(id: id, label: label ?? id, kind: kind, potId: kind == .topf ? id : nil, potKind: pot)
}

private func link(_ s: String, _ t: String, _ v: Int) -> MoneyFlow.Link {
    MoneyFlow.Link(source: s, target: t, valueCents: v)
}

private let november = YearMonth(year: 2026, month: 11)

/// Privater Haushalt: zwei Quellen, eine Gruppe mit zwei Töpfen, Erst-ich-Topf, Einzahlung ins
/// Gemeinsame und „Übrig“.
private let privat = MoneyFlow(
    householdId: "h1", from: november, to: november,
    nodes: [
        node("haushalt", .haushalt, "Ich"),
        node("quelle:1", .quelle, "Gehalt"),
        node("quelle:2", .quelle, "Nebenjob"),
        node("gruppe:1", .gruppe, "Wohnen"),
        node("topf:miete", .topf, "Miete", pot: .monatlich),
        node("topf:strom", .topf, "Strom", pot: .monatlich),
        node("topf:depot", .topf, "Depot", pot: .erstIch),
        node("einzahlung:h2", .einzahlung, "Gemeinsam"),
        node("rest:uebrig", .rest, "Übrig"),
    ],
    links: [
        link("quelle:2", "haushalt", 50_000),
        link("quelle:1", "haushalt", 300_000),
        link("haushalt", "gruppe:1", 120_000),
        link("gruppe:1", "topf:miete", 100_000),
        link("gruppe:1", "topf:strom", 20_000),
        link("haushalt", "rest:uebrig", 80_000),
        link("haushalt", "topf:depot", 50_000),
        link("haushalt", "einzahlung:h2", 100_000),
    ],
    inCents: 350_000, outCents: 270_000
)

@Suite struct FlowListTests {
    @Test func woherSindDieZufluesseDesHaushaltsNachBetrag() {
        let list = FlowList(flow: privat)
        #expect(list.incoming.map(\.label) == ["Gehalt", "Nebenjob"])
        #expect(list.incoming.map(\.amount) == ["3.000\u{00A0}€", "500\u{00A0}€"])
        // Anteile am Zufluss: 300.000 / 350.000 und 50.000 / 350.000
        #expect(list.incoming.map(\.share) == ["86\u{00A0}%", "14\u{00A0}%"])
        #expect(list.incoming.first?.fraction == 300_000.0 / 350_000)
        #expect(list.incoming.allSatisfy { !$0.fromSavings })
        #expect(list.incomingTotal == "3.500\u{00A0}€")
    }

    @Test func wohinNenntGruppenStattEinzelnerToepfeUndUebrigZuletzt() {
        let list = FlowList(flow: privat)
        #expect(list.outgoing.map(\.label) == ["Wohnen", "Gemeinsam", "Depot", "Übrig"])
        #expect(list.outgoing.map(\.kind) == [.gruppe, .einzahlung, .topf, .rest])
        #expect(list.outgoing.map(\.potKind) == [nil, nil, .erstIch, nil])
        // Anteile am Abfluss des Haushalts (350.000 inklusive „Übrig“)
        #expect(list.outgoing.first?.share == "34\u{00A0}%")
        #expect(list.outgoing.last?.amount == "800\u{00A0}€")
        #expect(list.outgoingTotal == "3.500\u{00A0}€")
        #expect(!list.isEmpty)
    }

    @Test func gleicheBetraegeBehaltenDieReihenfolgeDerAPI() {
        let flow = MoneyFlow(
            householdId: "h1", from: november, to: november,
            nodes: [
                node("haushalt", .haushalt), node("quelle:a", .quelle, "A"), node("quelle:b", .quelle, "B"),
            ],
            links: [link("quelle:a", "haushalt", 10_000), link("quelle:b", "haushalt", 10_000)],
            inCents: 20_000, outCents: 0
        )
        let list = FlowList(flow: flow)
        #expect(list.incoming.map(\.label) == ["A", "B"])
        #expect(list.outgoing.isEmpty)
        #expect(list.outgoingTotal == nil)
    }

    @Test func gemeinsamerHaushaltBekommtEinzahlungenAlsWoher() {
        let flow = MoneyFlow(
            householdId: "h2", from: november, to: november,
            nodes: [
                node("haushalt", .haushalt, "Gemeinsam"),
                node("einzahlung:a", .einzahlung, "Person A"),
                node("einzahlung:b", .einzahlung, "Person B"),
                node("topf:miete", .topf, "Miete", pot: .monatlich),
            ],
            links: [
                link("einzahlung:a", "haushalt", 60_000),
                link("einzahlung:b", "haushalt", 90_000),
                link("haushalt", "topf:miete", 150_000),
            ],
            inCents: 150_000, outCents: 150_000
        )
        let list = FlowList(flow: flow)
        #expect(list.incoming.map(\.label) == ["Person B", "Person A"])
        #expect(list.incoming.map(\.kind) == [.einzahlung, .einzahlung])
        #expect(list.outgoing.map(\.share) == ["100\u{00A0}%"])
    }

    @Test func ohneHaushaltsknotenZaehlenQuellenUndSenken() {
        // Geldfluss einer Person über mehrere Haushalte: zwei Haushaltsknoten.
        let flow = MoneyFlow(
            householdId: nil, from: november, to: november,
            nodes: [
                node("h1/quelle:1", .quelle, "Gehalt"),
                node("h1/haushalt", .haushalt, "Ich"),
                node("h1/einzahlung", .einzahlung, "Einzahlung"),
                node("h2/haushalt", .haushalt, "Gemeinsam"),
                node("h1/topf:depot", .topf, "Depot", pot: .erstIch),
                node("h2/topf:miete", .topf, "Miete", pot: .monatlich),
            ],
            links: [
                link("h1/quelle:1", "h1/haushalt", 300_000),
                link("h1/haushalt", "h1/topf:depot", 100_000),
                link("h1/haushalt", "h1/einzahlung", 200_000),
                link("h1/einzahlung", "h2/haushalt", 200_000),
                link("h2/haushalt", "h2/topf:miete", 200_000),
            ],
            inCents: 300_000, outCents: 300_000
        )
        let list = FlowList(flow: flow)
        #expect(list.incoming.map(\.label) == ["Gehalt"])
        #expect(list.outgoing.map(\.label) == ["Miete", "Depot"])
    }

    @Test func leererFlussIstLeer() {
        let flow = MoneyFlow(householdId: "h1", from: november, to: november, nodes: [], links: [], inCents: 0, outCents: 0)
        let list = FlowList(flow: flow)
        #expect(list.isEmpty)
        #expect(list.incomingTotal == nil)
    }

    @Test func erspartesIstAlsSolchesMarkiert() {
        let flow = MoneyFlow(
            householdId: "h1", from: november, to: november,
            nodes: [node("haushalt", .haushalt), node("quelle:erspartes", .quelle, "Erspartes")],
            links: [link("quelle:erspartes", "haushalt", 5_000)],
            inCents: 5_000, outCents: 0
        )
        #expect(FlowList(flow: flow).incoming.map(\.fromSavings) == [true])
    }

    @Test func kleineAnteileMitNachkommastelle() {
        let flow = MoneyFlow(
            householdId: "h1", from: november, to: november,
            nodes: [node("haushalt", .haushalt), node("quelle:a", .quelle, "A"), node("quelle:b", .quelle, "B")],
            links: [link("quelle:a", "haushalt", 189_000), link("quelle:b", "haushalt", 11_000)],
            inCents: 200_000, outCents: 0
        )
        #expect(FlowList(flow: flow).incoming.map(\.share) == ["95\u{00A0}%", "5,5\u{00A0}%"])
    }
}
