import Foundation
import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private let november = YearMonth(year: 2026, month: 11)

@Suite struct PotDraftTests {
    @Test func neuerErstIchTopfMitZehnProzent() throws {
        var draft = PotDraft(kind: .erstIch, today: november)
        #expect(draft.problem == "Wie soll der Topf heißen?")
        draft.name = "  Investieren "
        #expect(draft.erstIchMode == .anteil)
        #expect(draft.problem == "Welcher Anteil der Einnahmen? Z. B. 10 %.")
        draft.percentText = "10"
        draft.groupName = " Erst ich "
        let input = try #require(draft.input)
        #expect(input == PotInput(name: "Investieren", kind: .erstIch, groupName: "Erst ich", percentBp: 1_000))
    }

    @Test func anteilUndBetragWerdenGeprueft() {
        var draft = PotDraft(kind: .erstIch, today: november)
        draft.name = "Investieren"
        for (text, bp) in [("12,5", 1_250), ("0,25 %", 25), ("100", 10_000)] {
            draft.percentText = text
            #expect(draft.percentBp == bp)
        }
        draft.percentText = "120"
        #expect(draft.problem == "Der Anteil muss zwischen 0,01 und 100 % liegen.")
        draft.erstIchMode = .betrag
        #expect(draft.problem == "Wie viel soll jeden Monat zuerst in den Topf?")
        draft.amountText = "abc"
        #expect(draft.problem == "Den Betrag verstehe ich nicht, z. B. 250 oder 49,90.")
        draft.amountText = "200"
        #expect(draft.input?.amountCents == 20_000)
        // Der Anteil aus dem anderen Modus wird nicht mitgeschickt.
        #expect(draft.input?.percentBp == nil)
    }

    @Test func pflichtfelderJeArt() {
        var draft = PotDraft(kind: .monatlich, today: november)
        draft.name = "Lebensmittel"
        #expect(draft.problem == nil)
        #expect(draft.input?.amountCents == nil)
        draft.kind = .ruecklage
        #expect(draft.problem == "Wie viel kostet es im Jahr?")
        draft.kind = .ziel
        #expect(draft.problem == "Wie viel soll zusammenkommen?")
        draft.amountText = "1.500"
        #expect(draft.input?.amountCents == 150_000)
        #expect(draft.input?.targetMonth == nil)
        draft.hasTargetMonth = true
        #expect(draft.targetMonth == YearMonth(year: 2027, month: 11))
        #expect(draft.input?.targetMonth == YearMonth(year: 2027, month: 11))
        // Zielmonat nur bei Zielen.
        draft.kind = .ruecklage
        #expect(draft.input?.targetMonth == nil)
    }

    @Test func aenderungenSetzenUndLeeren() throws {
        let pot = Pot(id: "p1", householdId: "h1", name: "Investieren", kind: .erstIch, groupName: "Sparen", amountCents: 20_000)
        var draft = PotDraft(pot: pot, today: november)
        #expect(draft.erstIchMode == .betrag)
        #expect(draft.amountText == "200")
        #expect(try #require(draft.changes(from: pot)).isEmpty)

        // Von festem Betrag auf Anteil: Anteil setzen, Betrag leeren; Gruppe leeren.
        draft.erstIchMode = .anteil
        draft.percentText = "10"
        draft.groupName = ""
        let changes = try #require(draft.changes(from: pot))
        #expect(changes == PotChanges(percentBp: 1_000, clear: [.groupName, .amountCents]))
    }

    @Test func zielmonatEntfernenUndNamenAendern() throws {
        let pot = Pot(id: "p2", householdId: "h1", name: "Fahrrad", kind: .ziel, amountCents: 150_000,
                      targetMonth: YearMonth(year: 2027, month: 5))
        var draft = PotDraft(pot: pot, today: november)
        #expect(draft.hasTargetMonth)
        #expect(draft.amountText == "1.500")
        draft.hasTargetMonth = false
        draft.name = "Lastenrad"
        draft.amountText = "2.400"
        let changes = try #require(draft.changes(from: pot))
        #expect(changes == PotChanges(name: "Lastenrad", amountCents: 240_000, clear: [.targetMonth]))
    }

    @Test func monateVerschieben() {
        #expect(november.adding(months: 2) == YearMonth(year: 2027, month: 1))
        #expect(november.adding(months: -11) == YearMonth(year: 2025, month: 12))
        #expect(november.adding(months: 0) == november)
    }

    @Test func reihenfolgeWieSwiftUI() {
        let ids = ["a", "b", "c", "d"]
        #expect(PotOrder.move(ids, from: IndexSet(integer: 0), to: 4) == ["b", "c", "d", "a"])
        #expect(PotOrder.move(ids, from: IndexSet(integer: 3), to: 0) == ["d", "a", "b", "c"])
        #expect(PotOrder.move(ids, from: IndexSet([0, 2]), to: 2) == ["b", "a", "c", "d"])
        #expect(PotOrder.move(ids, from: IndexSet(integer: 1), to: 1) == ids)
    }
}

private let potJSON = """
{"id":"p1","householdId":"h1","name":"Investieren","kind":"erst_ich","groupName":null,"amountCents":null,
 "percentBp":1000,"targetMonth":null,"sortOrder":0,"archived":false,"createdAt":"2026-11-17T10:00:00.000Z"}
"""

@Suite struct PotServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func legtTopfAn() async throws {
        let transport = FakeTransport { _ in (201, potJSON) }
        let input = PotInput(name: "Investieren", kind: .erstIch, groupName: "Erst ich", percentBp: 1_000)
        let pot = try await service(transport).createPot(householdId: "h1", input: input)
        #expect(pot.kind == .erstIch)
        #expect(pot.percentBp == 1_000)
        let request = try #require(transport.requests.first)
        #expect(request.method == .post)
        #expect(request.path == "/v1/households/h1/pots")
        let body = try #require(request.body)
        #expect(body["kind"] as? String == "erst_ich")
        #expect(body["percentBp"] as? Int == 1_000)
        #expect(body["groupName"] as? String == "Erst ich")
        #expect(body["amountCents"] == nil)
    }

    @Test func leertFelderUeberClear() async throws {
        let transport = FakeTransport { _ in (200, potJSON) }
        let changes = PotChanges(percentBp: 1_000, clear: [.amountCents, .groupName])
        _ = try await service(transport).updatePot(id: "p1", changes: changes)
        let request = try #require(transport.requests.first)
        #expect(request.method == .patch)
        #expect(request.path == "/v1/pots/p1")
        let body = try #require(request.body)
        #expect(body["clear"] as? [String] == ["amountCents", "groupName"])
        #expect(body["percentBp"] as? Int == 1_000)
        #expect(body["amountCents"] == nil)
    }

    @Test func archiviert() async throws {
        let transport = FakeTransport { _ in (200, potJSON) }
        _ = try await service(transport).updatePot(id: "p1", changes: PotChanges(archived: true))
        let body = try #require(transport.requests.first?.body)
        #expect(body["archived"] as? Bool == true)
        #expect(body["name"] == nil)
    }

    @Test func sortiert() async throws {
        let transport = FakeTransport { _ in (200, "{\"items\":[\(potJSON)]}") }
        let pots = try await service(transport).reorderPots(householdId: "h1", potIds: ["p1"])
        #expect(pots.map(\.id) == ["p1"])
        let request = try #require(transport.requests.first)
        #expect(request.method == .put)
        #expect(request.path == "/v1/households/h1/pot-order")
        #expect(request.body?["potIds"] as? [String] == ["p1"])
    }

    @Test func meldetAbgelehntenPlan() async throws {
        let transport = FakeTransport { _ in
            (422, #"{"error":{"code":"topf_plan_ungueltig","message":"Eine Rücklage braucht einen Jahresbetrag."}}"#)
        }
        await #expect(throws: APIError.server(
            status: 422, code: "topf_plan_ungueltig", message: "Eine Rücklage braucht einen Jahresbetrag."
        )) {
            _ = try await service(transport).createPot(householdId: "h1", input: PotInput(name: "X", kind: .ruecklage))
        }
    }
}
