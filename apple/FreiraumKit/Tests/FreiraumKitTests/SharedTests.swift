import Foundation
import Testing
@testable import FreiraumKit

// Gemeinsames Konto, private Töpfe, Ausgleich (FREI-29). Alle Namen und Beträge sind erfunden.

private let a = Person(id: "pa", displayName: "Person A")
private let b = Person(id: "pb", displayName: "Person B")
private let privatA = Household(id: "h1", kind: .privat, name: "Person A", members: [a])
private let gemeinsam = Household(id: "h2", kind: .gemeinsam, name: "Gemeinsam", members: [a, b])
private let households = [privatA, gemeinsam]
private let pots: [String: [Pot]] = [
    "h1": [
        Pot(id: "pp1", householdId: "h1", name: "Freizeit", kind: .monatlich, sortOrder: 1),
        Pot(id: "pp2", householdId: "h1", name: "Kleidung", kind: .monatlich, sortOrder: 0),
        Pot(id: "pp3", householdId: "h1", name: "Alt", kind: .monatlich, archived: true),
    ],
    "h2": [
        Pot(id: "gp1", householdId: "h2", name: "Lebensmittel", kind: .monatlich, groupName: "Alltag"),
        Pot(id: "gp2", householdId: "h2", name: "Miete", kind: .monatlich, groupName: "Fixkosten"),
    ],
]

@Suite struct SharedTargetTests {
    let shared = TargetContext(household: gemeinsam, households: households, pots: pots, me: a)
    let own = TargetContext(household: privatA, households: households, pots: pots, me: a)

    @Test func gemeinsamesKontoBietetEigenePrivateToepfeAn() {
        let groups = shared.groups(amountCents: -2_500)
        #expect(groups.map(\.title) == ["Alltag", "Fixkosten", "Privat (ich zahle zurück)", "Sonstiges"])
        let privat = groups[2]
        #expect(privat.options.map(\.label) == ["Kleidung", "Freizeit"])
        #expect(privat.options.map(\.target) == [.pot("pp2"), .pot("pp1")])
        #expect(privat.footer?.contains("keine Regel") == true)
        #expect(groups[3].options.map(\.label) == [
            "Einnahme", "Umbuchung", "Erstattung an mich", "Erstattung an Person B",
        ])
    }

    @Test func eingangAufsGemeinsameKonto() {
        let groups = shared.groups(amountCents: 50_000)
        #expect(groups.first?.title == "Sonstiges")
        #expect(groups.first?.options.map(\.label) == [
            "Einnahme", "Umbuchung", "Einzahlung von mir", "Rückzahlung von mir",
            "Einzahlung von Person B", "Rückzahlung von Person B",
        ])
        #expect(groups.first?.options[3].target == .settlement(personId: "pa"))
    }

    @Test func privatesKontoBietetGemeinsameToepfeAn() {
        let groups = own.groups(amountCents: -2_500)
        #expect(groups.map(\.title) == ["Töpfe", "Gemeinsam (wird erstattet)", "Sonstiges"])
        #expect(groups[1].options.map(\.label) == ["Lebensmittel", "Miete"])
        #expect(groups[2].options.map(\.label) == ["Einnahme", "Umbuchung", "Einzahlung ins Gemeinsame", "Rückzahlung ans Gemeinsame"])
        #expect(own.groups(amountCents: 2_500).first?.options.map(\.label) == ["Einnahme", "Umbuchung", "Erstattung vom Gemeinsamen"])
    }

    @Test func ohneGemeinsamenHaushaltKeineEinzahlung() {
        let allein = TargetContext(household: privatA, households: [privatA], pots: pots, me: a)
        #expect(allein.options(amountCents: -100).map(\.label) == ["Kleidung", "Freizeit", "Einnahme", "Umbuchung"])
    }

    @Test func beschriftungen() {
        #expect(shared.label(.pot("gp1"), amountCents: -100) == "Lebensmittel")
        #expect(shared.label(.pot("pp1"), amountCents: -100) == "Freizeit (privat)")
        // Privater Topf der anderen Person: Die App kennt ihn nicht, zeigt aber keinen Fehler.
        #expect(shared.label(.pot("fremd"), amountCents: -100) == "privat (Person B)")
        #expect(own.label(.pot("gp2"), amountCents: -100) == "Miete (gemeinsam)")
        #expect(own.label(.pot("fremd"), amountCents: -100) == "Unbekannter Topf")
        #expect(shared.label(.settlement(personId: "pb"), amountCents: -100) == "Erstattung an Person B")
        #expect(own.label(.contribution(personId: nil), amountCents: -100) == "Einzahlung ins Gemeinsame")
    }

    @Test func regelnNurInDerUeblichenRichtung() {
        #expect(shared.learnsRule(.pot("gp1"), amountCents: -100))
        #expect(!shared.learnsRule(.pot("pp1"), amountCents: -100))
        #expect(own.learnsRule(.pot("gp1"), amountCents: -100))
        #expect(shared.learnsRule(.settlement(personId: "pb"), amountCents: -100))
        #expect(!shared.learnsRule(.settlement(personId: "pa"), amountCents: 100))
        #expect(own.learnsRule(.settlement(personId: nil), amountCents: 100))
        #expect(!own.learnsRule(.settlement(personId: nil), amountCents: -100))
    }

    @Test func karteZeigtFremdenPrivatenTopfOhneFehler() {
        let t = Transaction(
            id: "t1", accountId: "a2", bookingDate: "2026-11-16", amountCents: -1_999, counterpartyName: "Laden",
            status: .vorgeschlagen,
            suggestion: Suggestion(source: .abgleich, target: .settlement(personId: "pb"), confidencePct: 100, reason: "Abgleich")
        )
        let card = ConfirmCard(transaction: t, account: nil, context: shared, today: "2026-11-17")
        #expect(card.suggestion == "Erstattung an Person B")
        #expect(card.isShared)
    }
}

@Suite struct SettlementStateTests {
    let settlements = Settlements(
        householdId: "h2",
        balances: [
            .init(personId: "pb", displayName: "Person B", claimedCents: 6_000, repaidCents: 2_000, openCents: 4_000),
            .init(personId: "pa", displayName: "Person A", debtCents: 2_500, openCents: -2_500),
        ],
        openItems: [.init(transactionId: "t1", personId: "pb", bookingDate: "2026-11-03", counterpartyName: "Baumarkt",
                          amountCents: 6_000, openCents: 4_000)],
        openDebts: [.init(transactionId: "t2", personId: "pa", bookingDate: "2026-11-16", counterpartyName: nil,
                          amountCents: 2_500, openCents: 2_500)],
        manual: [
            .init(id: "m1", personId: "pb", amountCents: 2_000, settledOn: "2026-11-10", note: "bar"),
            .init(id: "m2", personId: "pa", kind: .verrechnung, amountCents: -1_000, settledOn: "2026-11-12"),
        ]
    )

    @Test func werWemWieVielSchuldet() {
        let state = SettlementState(settlements, me: a, today: "2026-11-17")
        #expect(!state.allSettled)
        #expect(state.balances.map(\.name) == ["Du", "Person B"])
        #expect(state.balances[0].direction == .personOwes)
        #expect(state.balances[0].sentence == "Du schuldest dem Gemeinsamen 25,00\u{00A0}€")
        #expect(state.balances[0].detail == "vom gemeinsamen Konto 25\u{00A0}€")
        #expect(state.balances[0].hint?.contains("Rückzahlung") == true)
        #expect(state.balances[1].direction == .owedToPerson)
        #expect(state.balances[1].sentence == "Das Gemeinsame schuldet Person B 40,00\u{00A0}€")
        #expect(state.balances[1].detail == "ausgelegt 60\u{00A0}€ · erstattet 20\u{00A0}€")
        #expect(state.summary == "Du schuldest dem Gemeinsamen 25,00\u{00A0}€")

        #expect(state.claims.first?.title == "Baumarkt")
        #expect(state.claims.first?.subtitle == "Di, 3. Nov · Person B")
        #expect(state.claims.first?.open == "40,00\u{00A0}€")
        #expect(state.claims.first?.ofTotal == "von 60,00\u{00A0}€")
        #expect(state.debts.first?.title == "Ohne Angaben")
        #expect(state.debts.first?.subtitle == "Gestern · Du")
        #expect(state.debts.first?.ofTotal == nil)
        #expect(state.manual.first?.title == "bar")
        #expect(state.manual.first?.subtitle == "Di, 10. Nov · Person B · Erstattung erhalten")
        #expect(state.manual.last?.title == "Rückzahlung mit Einzahlung verrechnet")
        #expect(state.manual.last?.subtitle == "Do, 12. Nov · Du")
        #expect(state.manual.last?.amount == "10,00\u{00A0}€")
    }

    @Test func ausgeglichen() {
        let state = SettlementState(
            Settlements(householdId: "h2", balances: [
                .init(personId: "pa", displayName: "Person A", openCents: 0),
                .init(personId: "pb", displayName: "Person B", openCents: 0),
            ]),
            me: a
        )
        #expect(state.allSettled)
        #expect(state.summary == "Alles ausgeglichen")
        #expect(state.balances[0].sentence == "Du bist ausgeglichen")
        #expect(state.balances[1].sentence == "Person B ist ausgeglichen")
        #expect(state.balances[0].amount.isEmpty)
    }

    @Test func eigenerSaldoNullDannAndere() {
        let state = SettlementState(
            Settlements(householdId: "h2", balances: [
                .init(personId: "pa", displayName: "Person A", openCents: 0),
                .init(personId: "pb", displayName: "Person B", debtCents: 1_000, openCents: -1_000),
            ]),
            me: a
        )
        #expect(state.summary == "Person B schuldet dem Gemeinsamen 10,00\u{00A0}€")
    }
}

@Suite struct SharedServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func einzahlungUndAbgleichLassenSichAbbilden() async throws {
        let transport = FakeTransport { _ in
            (200, """
            {"items":[{"id":"t1","accountId":"a2","sourceId":null,"bookingDate":"2026-11-02","valueDate":null,
             "amountCents":50000,"currency":"EUR","counterpartyName":"Person A","counterpartyIban":null,"purpose":null,
             "status":"vorgeschlagen","recurringSeriesId":null,
             "splits":[{"kind":"einzahlung","potId":null,"personId":"pa","amountCents":50000}],
             "suggestion":{"source":"abgleich","kind":"ausgleich","potId":null,"personId":"pa","confidencePct":100,
              "reason":"Abgleich: Erstattung an Person A","ruleId":null}}]}
            """)
        }
        let items = try await service(transport).pendingTransactions()
        #expect(items.first?.splits == [Split(target: .contribution(personId: "pa"), amountCents: 50_000)])
        #expect(items.first?.suggestion?.source == .abgleich)
        #expect(items.first?.suggestion?.target == .settlement(personId: "pa"))
    }

    @Test func rueckzahlungSendetPerson() async throws {
        let transport = FakeTransport { _ in
            (200, """
            {"transaction":{"id":"t1","accountId":"a2","sourceId":null,"bookingDate":"2026-11-03","valueDate":null,
             "amountCents":2500,"currency":"EUR","counterpartyName":null,"counterpartyIban":null,"purpose":null,
             "status":"bestaetigt","recurringSeriesId":null,
             "splits":[{"kind":"ausgleich","potId":null,"personId":"pa","amountCents":2500}],"suggestion":null},
             "rule":null,"resuggested":0}
            """)
        }
        let t = try await service(transport).setSplits(
            transactionId: "t1", splits: [Split(target: .settlement(personId: "pa"), amountCents: 2_500)]
        )
        #expect(t.splits.first?.target == .settlement(personId: "pa"))
        let body = try #require(transport.requests.first?.body)
        let split = try #require((body["splits"] as? [[String: Any]])?.first)
        #expect(split["kind"] as? String == "ausgleich")
        #expect(split["personId"] as? String == "pa")
        #expect(split["potId"] == nil)
    }

    @Test func privaterTopfAufGemeinsamemKonto() async throws {
        let transport = FakeTransport { _ in (200, "{\"transaction\":\(sharedTransactionJSON),\"rule\":null,\"resuggested\":0}") }
        _ = try await service(transport).setSplits(transactionId: "t1", splits: [Split(target: .pot("pp1"), amountCents: -2_500)])
        let split = try #require((transport.requests.first?.body?["splits"] as? [[String: Any]])?.first)
        #expect(split["kind"] as? String == "topf")
        #expect(split["potId"] as? String == "pp1")
        #expect(split["personId"] == nil)
    }

    @Test func ausgleichLaden() async throws {
        let transport = FakeTransport { _ in
            (200, """
            {"householdId":"h2",
             "balances":[{"personId":"pa","displayName":"Person A","claimedCents":0,"repaidCents":0,
               "debtCents":2500,"paidBackCents":0,"openCents":-2500}],
             "openItems":[],
             "openDebts":[{"transactionId":"t1","personId":"pa","bookingDate":"2026-11-16","counterpartyName":"Laden",
               "amountCents":2500,"openCents":2500}],
             "manual":[{"id":"m1","personId":"pa","kind":"zahlung","amountCents":500,"settledOn":"2026-11-10","note":null,
               "createdAt":"2026-11-10T10:00:00.000Z"}]}
            """)
        }
        let s = try await service(transport).settlements(householdId: "h2")
        #expect(transport.requests.first?.path == "/v1/households/h2/settlements")
        #expect(s.balances.first?.debtCents == 2_500)
        #expect(s.balances.first?.openCents == -2_500)
        #expect(s.openDebts.first?.counterpartyName == "Laden")
        #expect(s.manual.first?.note == nil)
        #expect(s.manual.first?.kind == .zahlung)
    }
}

private let sharedTransactionJSON = """
{"id":"t1","accountId":"a2","sourceId":null,"bookingDate":"2026-11-16","valueDate":null,"amountCents":-2500,
 "currency":"EUR","counterpartyName":"Laden","counterpartyIban":null,"purpose":null,"status":"bestaetigt",
 "recurringSeriesId":null,"splits":[{"kind":"topf","potId":"pp1","personId":null,"amountCents":-2500}],"suggestion":null}
"""
