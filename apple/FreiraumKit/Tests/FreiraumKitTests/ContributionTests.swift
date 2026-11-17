import Foundation
import Testing
@testable import FreiraumKit

// Alle Namen, IDs und Beträge sind erfunden.

private let november = YearMonth(year: 2026, month: 11)
private let ichId = "11111111-1111-4111-8111-111111111111"
private let duId = "22222222-2222-4222-8222-222222222222"
private let hhId = "33333333-3333-4333-8333-333333333333"

private func ruleJSON(_ person: String, from: String, kind: String, amount: Int?, percent: Int?) -> String {
    """
    {"householdId":"\(hhId)","personId":"\(person)","validFrom":"\(from)","kind":"\(kind)",
     "amountCents":\(amount.map(String.init) ?? "null"),"percentBp":\(percent.map(String.init) ?? "null"),
     "updatedAt":"2026-11-17T10:00:00.000Z"}
    """
}

@Suite struct ContributionServiceTests {
    func service(_ transport: FakeTransport) -> FreiraumService {
        FreiraumService(baseURL: URL(string: "https://freiraum.test")!, token: { "frs_test" }, transport: transport)
    }

    @Test func sollUndIstMitVerborgenemSollUndOhneRegel() async throws {
        let transport = FakeTransport { _ in
            (200, """
            {"householdId":"\(hhId)","month":"2026-11","members":[
              {"personId":"\(ichId)","displayName":"Person A",
               "rule":\(ruleJSON(ichId, from: "2026-10", kind: "fest", amount: 40_000, percent: nil)),
               "targetCents":40000,"targetVisible":true,"paidCents":25000,"remainingCents":15000},
              {"personId":"\(duId)","displayName":"Person B",
               "rule":\(ruleJSON(duId, from: "2026-11", kind: "prozent", amount: nil, percent: 4_000)),
               "targetCents":null,"targetVisible":false,"paidCents":30000,"remainingCents":null}
            ]}
            """)
        }
        let c = try await service(transport).contributions(householdId: hhId, month: november)
        #expect(transport.requests.first?.path == "/v1/households/\(hhId)/contributions/2026-11")
        #expect(c.month == november)
        #expect(c.members.count == 2)
        #expect(c.members[0].rule == ContributionRule(
            householdId: hhId, personId: ichId, validFrom: YearMonth(year: 2026, month: 10), kind: .fest, amountCents: 40_000
        ))
        #expect(c.members[0].remainingCents == 15_000)
        #expect(c.members[1].rule?.percentBp == 4_000)
        #expect(c.members[1].targetVisible == false)
        #expect(c.members[1].targetCents == nil)

        // Ohne Regel liefert der Server null; das darf das Abbilden nicht scheitern lassen.
        let empty = FakeTransport { _ in
            (200, """
            {"householdId":"\(hhId)","month":"2026-11","members":[
              {"personId":"\(ichId)","displayName":"Person A","rule":null,"targetCents":null,
               "targetVisible":false,"paidCents":0,"remainingCents":null}]}
            """)
        }
        let none = try await service(empty).contributions(householdId: hhId, month: november)
        #expect(none.members.first?.rule == nil)
    }

    @Test func regelSetzenSendetNurDasPassendeFeld() async throws {
        let transport = FakeTransport { _ in (200, ruleJSON(ichId, from: "2026-12", kind: "fest", amount: 0, percent: nil)) }
        let saved = try await service(transport).setContributionRule(
            householdId: hhId, from: YearMonth(year: 2026, month: 12), rule: .fixed(cents: 0)
        )
        #expect(saved.text == "Pause")
        let request = try #require(transport.requests.first)
        #expect(request.method == .put)
        #expect(request.path == "/v1/households/\(hhId)/contribution-rules/2026-12")
        let body = try #require(request.body)
        #expect(body["kind"] as? String == "fest")
        #expect(body["amountCents"] as? Int == 0)
        #expect(body["percentBp"] == nil)

        let percent = FakeTransport { _ in (200, ruleJSON(ichId, from: "2026-11", kind: "prozent", amount: nil, percent: 1_250)) }
        _ = try await service(percent).setContributionRule(householdId: hhId, from: november, rule: .percent(bp: 1_250))
        let percentBody = try #require(percent.requests.first?.body)
        #expect(percentBody["kind"] as? String == "prozent")
        #expect(percentBody["percentBp"] as? Int == 1_250)
        #expect(percentBody["amountCents"] == nil)
    }

    @Test func historieLadenUndRegelLoeschen() async throws {
        let transport = FakeTransport { path in
            if path.hasSuffix("/contribution-rules") {
                return (200, """
                {"items":[\(ruleJSON(ichId, from: "2026-10", kind: "fest", amount: 40_000, percent: nil)),
                          \(ruleJSON(ichId, from: "2027-01", kind: "prozent", amount: nil, percent: 4_000))]}
                """)
            }
            return (204, "")
        }
        let svc = service(transport)
        let rules = try await svc.contributionRules(householdId: hhId)
        #expect(rules.map(\.validFrom) == [YearMonth(year: 2026, month: 10), YearMonth(year: 2027, month: 1)])
        try await svc.deleteContributionRule(householdId: hhId, from: YearMonth(year: 2027, month: 1))
        let delete = try #require(transport.requests.last)
        #expect(delete.method == .delete)
        #expect(delete.path == "/v1/households/\(hhId)/contribution-rules/2027-01")
    }

    @Test func freigabenLesenErteilenZuruecknehmen() async throws {
        let transport = FakeTransport { path in
            if path == "/v1/shares" {
                return (200, """
                {"granted":[{"personId":"\(duId)","displayName":"Person B","scope":"sparquote","createdAt":"2026-11-17T10:00:00.000Z"}],
                 "received":[{"personId":"\(duId)","displayName":"Person B","scope":"einzahlung_soll",
                              "createdAt":"2026-11-17T10:00:00.000Z","householdId":"\(hhId)"}]}
                """)
            }
            if path.hasPrefix("/v1/shares/"), path.hasSuffix("einzahlung_soll") {
                return (200, #"{"personId":"\#(duId)","displayName":"Person B","scope":"einzahlung_soll","createdAt":"2026-11-17T10:00:00.000Z"}"#)
            }
            return (204, "")
        }
        let svc = service(transport)
        let shares = try await svc.shares()
        #expect(shares.hasGranted(.sparquote, to: duId))
        #expect(!shares.hasGranted(.einzahlungSoll, to: duId))
        #expect(shares.received == [Share(personId: duId, displayName: "Person B", scope: .einzahlungSoll)])

        try await svc.grantShare(.einzahlungSoll, to: duId)
        #expect(transport.requests.last?.method == .put)
        #expect(transport.requests.last?.path == "/v1/shares/\(duId)/einzahlung_soll")

        try await svc.revokeShare(.erstIch, from: duId)
        #expect(transport.requests.last?.method == .delete)
        #expect(transport.requests.last?.path == "/v1/shares/\(duId)/erst_ich")
    }
}

@Suite struct ContributionPresentationTests {
    func rule(_ person: String, _ from: YearMonth, fest cents: Int) -> ContributionRule {
        ContributionRule(householdId: "h", personId: person, validFrom: from, kind: .fest, amountCents: cents)
    }

    func rule(_ person: String, _ from: YearMonth, prozent bp: Int) -> ContributionRule {
        ContributionRule(householdId: "h", personId: person, validFrom: from, kind: .prozent, percentBp: bp)
    }

    @Test func regelText() {
        #expect(rule("a", november, fest: 40_000).text == "400\u{00A0}€ im Monat")
        #expect(rule("a", november, fest: 45_050).text == "450,50\u{00A0}€ im Monat")
        #expect(rule("a", november, fest: 0).text == "Pause")
        #expect(rule("a", november, prozent: 4_000).text == "40\u{00A0}% vom Netto")
        #expect(rule("a", november, prozent: 1_250).text == "12,5\u{00A0}% vom Netto")
        #expect(Percent.format(25) == "0,25\u{00A0}%")
        #expect(Percent.format(10) == "0,1\u{00A0}%")
    }

    @Test func eigeneZeileObenUndSollDerAnderenVerborgen() {
        let state = ContributionsState(Contributions(householdId: "h", month: november, members: [
            MemberContribution(
                personId: "b", displayName: "Person B", rule: rule("b", november, prozent: 4_000),
                targetCents: nil, targetVisible: false, paidCents: 30_000, remainingCents: nil
            ),
            MemberContribution(
                personId: "a", displayName: "Person A", rule: rule("a", november, fest: 40_000),
                targetCents: 40_000, targetVisible: true, paidCents: 25_000, remainingCents: 15_000
            ),
        ]), me: "a")
        #expect(state.rows.map(\.name) == ["Du", "Person B"])
        #expect(!state.missingOwnRule)

        let me = state.rows[0]
        #expect(me.rule == "400\u{00A0}€ im Monat")
        #expect(me.target == "Soll 400\u{00A0}€")
        #expect(me.paid == "Ist 250\u{00A0}€")
        #expect(me.status == "noch 150\u{00A0}€ offen")
        #expect(me.progress == 0.625)
        #expect(!me.done)

        let other = state.rows[1]
        #expect(other.rule == "40\u{00A0}% vom Netto")
        #expect(other.target == "Soll nicht freigegeben")
        #expect(other.paid == "Ist 300\u{00A0}€")
        #expect(other.status == nil)
        #expect(other.progress == nil)
    }

    @Test func erreichtPauseUndOhneRegel() {
        let state = ContributionsState(Contributions(householdId: "h", month: november, members: [
            MemberContribution(
                personId: "a", displayName: "Person A", rule: nil,
                targetCents: nil, targetVisible: false, paidCents: 0, remainingCents: nil
            ),
            MemberContribution(
                personId: "b", displayName: "Person B", rule: rule("b", november, prozent: 4_000),
                targetCents: 120_000, targetVisible: true, paidCents: 130_000, remainingCents: 0
            ),
            MemberContribution(
                personId: "c", displayName: "Person C", rule: rule("c", november, fest: 0),
                targetCents: 0, targetVisible: true, paidCents: 0, remainingCents: 0
            ),
        ]), me: "a")
        #expect(state.missingOwnRule)
        #expect(state.rows[0].rule == "Keine Regel")
        #expect(state.rows[0].target == nil)
        #expect(state.rows[1].status == "Soll erreicht")
        #expect(state.rows[1].progress == 1)
        #expect(state.rows[1].done)
        #expect(state.rows[2].status == "Pause")
        #expect(state.rows[2].progress == nil)
    }

    @Test func historieMitGueltigerUndKuenftigerRegel() {
        let oktober = YearMonth(year: 2026, month: 10)
        let januar = YearMonth(year: 2027, month: 1)
        let rules = [
            rule("a", oktober, fest: 40_000),
            rule("b", oktober, prozent: 4_000),
            rule("a", januar, prozent: 3_500),
            rule("a", YearMonth(year: 2026, month: 6), fest: 30_000),
        ]
        let members = [Person(id: "b", displayName: "Person B"), Person(id: "a", displayName: "Person A")]
        let history = ContributionHistory(rules: rules, members: members, me: "a", month: november)
        #expect(history.people.map(\.name) == ["Du", "Person B"])

        let mine = history.people[0].entries
        #expect(mine.map(\.since) == ["ab Januar 2027", "ab Oktober 2026", "ab Juni 2026"])
        #expect(mine.map(\.active) == [false, true, false])
        #expect(mine.map(\.upcoming) == [true, false, false])
        #expect(mine.map(\.deletable) == [true, true, true])
        #expect(history.people[1].entries.map(\.deletable) == [false])
        #expect(ContributionRule.active(in: rules, personId: "a", month: januar)?.percentBp == 3_500)
        #expect(ContributionRule.active(in: rules, personId: "a", month: YearMonth(year: 2026, month: 5)) == nil)
    }

    @Test func regelEingabe() {
        var draft = ContributionRuleDraft(rule: nil, month: november)
        #expect(draft.validFrom == november)
        #expect(draft.kind == .fest)
        #expect(draft.problem == "Wie viel zahlst du jeden Monat ein? 0 € heißt Pause.")
        draft.amountText = "abc"
        #expect(draft.problem == "Den Betrag verstehe ich nicht, z. B. 400 oder 450,50.")
        draft.amountText = "0"
        #expect(draft.input == .fixed(cents: 0))
        draft.amountText = "450,50"
        #expect(draft.input == .fixed(cents: 45_050))

        draft.kind = .prozent
        #expect(draft.problem == "Welcher Anteil deines Netto? Z. B. 40 %.")
        draft.percentText = "120"
        #expect(draft.problem == "Der Anteil muss zwischen 0,01 und 100 % liegen.")
        draft.percentText = "12,5 %"
        // Der Betrag aus der anderen Art wird nicht mitgeschickt.
        #expect(draft.input == .percent(bp: 1_250))

        let prefilled = ContributionRuleDraft(rule: rule("a", YearMonth(year: 2026, month: 10), prozent: 4_000), month: november)
        #expect(prefilled.kind == .prozent)
        #expect(prefilled.percentText == "40")
        #expect(prefilled.validFrom == november)
    }

    @Test func hinweisZurFreigabe() {
        let percent = ContributionPrivacy.hint(rule: rule("a", november, prozent: 4_000), partner: "Person B")
        #expect(percent.contains("Ist ÷ 40\u{00A0}%"))
        #expect(percent.contains("Person B"))
        let fixed = ContributionPrivacy.hint(rule: rule("a", november, fest: 40_000), partner: "Person B")
        #expect(fixed.hasPrefix("Ein fester Betrag ist für Person B ohnehin sichtbar."))
    }
}
