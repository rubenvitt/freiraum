import Foundation
import Testing
@testable import FreiraumKit

// Alle Namen und Beträge sind erfunden.

private let ich = Household(id: "h1", kind: .privat, name: "Person A", members: [])
private let gemeinsam = Household(id: "h2", kind: .gemeinsam, name: "Gemeinsam", members: [])
private let november = YearMonth(year: 2026, month: 11)

@Suite struct OverviewTests {
    let pots = [
        Pot(id: "p1", householdId: "h1", name: "Freizeit", kind: .monatlich, amountCents: 15_000, sortOrder: 2),
        Pot(id: "p2", householdId: "h1", name: "Investieren", kind: .erstIch, amountCents: 90_000, sortOrder: 0),
        Pot(id: "p3", householdId: "h1", name: "Kfz-Versicherung", kind: .ruecklage, amountCents: 72_000, sortOrder: 3),
        Pot(id: "p4", householdId: "h1", name: "Urlaub", kind: .ziel, amountCents: 300_000,
            targetMonth: YearMonth(year: 2027, month: 7), sortOrder: 4),
        Pot(id: "p5", householdId: "h1", name: "Bücher", kind: .monatlich, sortOrder: 1),
    ]

    func budget(_ pots: [BudgetPot], ready: Int = 21_500) -> BudgetMonth {
        BudgetMonth(householdId: "h1", month: november, readyToAssignCents: ready, pots: pots)
    }

    @Test func zeigtToepfeInReihenfolgeUndErstIchGetrennt() {
        let state = OverviewState(
            budget: budget([
                BudgetPot(potId: "p1", name: "Freizeit", kind: .monatlich, assignedCents: 15_000,
                          activityCents: -8_800, availableCents: 6_200, planCents: 15_000),
                BudgetPot(potId: "p2", name: "Investieren", kind: .erstIch, assignedCents: 90_000,
                          availableCents: 90_000, planCents: 90_000, neededCents: 0),
                BudgetPot(potId: "p3", name: "Kfz-Versicherung", kind: .ruecklage, carryoverCents: 48_000,
                          assignedCents: 6_000, availableCents: 54_000, planCents: 6_000),
                BudgetPot(potId: "p4", name: "Urlaub", kind: .ziel, carryoverCents: 190_000,
                          assignedCents: 8_000, availableCents: 198_000, planCents: 12_750, neededCents: 4_750),
                BudgetPot(potId: "p5", name: "Bücher", kind: .monatlich, assignedCents: 6_000,
                          activityCents: -4_800, availableCents: 1_200, planCents: 0),
            ]),
            household: ich, pots: pots, pendingCount: 4
        )
        #expect(state.readyToAssign == "215")
        #expect(state.householdLabel == "Ich")
        #expect(state.erstIch.map(\.name) == ["Investieren"])
        #expect(state.erstIch.first?.done == true)
        #expect(state.erstIchDone)
        #expect(state.pots.map(\.name) == ["Bücher", "Freizeit", "Kfz-Versicherung", "Urlaub"])
        #expect(state.pots[1].detail == "noch 62\u{00A0}€ von 150\u{00A0}€")
        #expect(state.pots[1].available == "62\u{00A0}€")
        #expect(abs(state.pots[1].progress - 62.0 / 150.0) < 0.0001)
        #expect(state.pots[1].tone == .ok)
        #expect(state.pots[0].tone == .low)
        #expect(state.pots[2].detail == "540\u{00A0}€ von 720\u{00A0}€ im Jahr")
        #expect(state.pots[3].detail == "1.980\u{00A0}€ von 3.000\u{00A0}€ bis Juli 2027")
        #expect(state.neededCents == 4_750)
    }

    @Test func ueberzogenerTopf() {
        let row = OverviewState.row(
            BudgetPot(potId: "p1", name: "Freizeit", kind: .monatlich, assignedCents: 5_000,
                      activityCents: -6_250, availableCents: -1_250),
            pot: nil
        )
        #expect(row.tone == .overspent)
        #expect(row.detail == "12,50\u{00A0}€ überzogen")
        #expect(row.available == "\u{2212}12,50\u{00A0}€")
        #expect(row.progress == 1)
    }

    @Test func erstIchOffen() {
        let state = OverviewState(
            budget: budget([
                BudgetPot(potId: "p2", name: "Investieren", kind: .erstIch, assignedCents: 40_000,
                          availableCents: 40_000, planCents: 90_000, neededCents: 50_000),
            ]),
            household: ich, pots: pots, pendingCount: 0
        )
        #expect(!state.erstIchDone)
        #expect(state.erstIch.first?.done == false)
        #expect(state.pots.isEmpty)
    }

    @Test func bargeldNochNichtErfasst() {
        // 50 € abgehoben, 20 € als Barausgabe erfasst: Der Server liefert 30 € Bestand.
        let accounts = [
            Account(id: "a1", householdId: "h1", name: "Giro", source: .bank),
            Account(id: "c1", householdId: "h1", name: "Bargeld", source: .bar, unrecordedCashCents: 3_000),
            Account(id: "c2", householdId: "h2", name: "Bargeld", source: .bar, unrecordedCashCents: 1_000),
        ]
        let cents = CashText.unrecordedCents(accounts: accounts, householdId: "h1")
        #expect(cents == 3_000)
        let state = OverviewState(budget: budget([]), household: ich, pots: pots, pendingCount: 0, unrecordedCashCents: cents)
        #expect(state.cashHint == "30\u{00A0}€ Bargeld noch nicht erfasst")
        #expect(OverviewState(budget: budget([]), household: ich, pots: pots, pendingCount: 0).cashHint == nil)
        #expect(CashText.unrecorded(0) == nil)
        #expect(CashText.unrecorded(-500) == nil)
        #expect(CashText.reminder(5_000) == "Denk an die 50\u{00A0}€ Bargeld")
        #expect(CashText.reminder(0) == nil)
    }

    @Test func texteZuWartendenBuchungen() {
        #expect(PendingText.title(0) == nil)
        #expect(PendingText.title(1) == "1 Buchung wartet")
        #expect(PendingText.title(4) == "4 Buchungen warten")
        #expect(PendingText.subtitle(4, withSuggestions: 4) == "Vorschläge sind fertig · etwa 1 Minute")
        #expect(PendingText.subtitle(12, withSuggestions: 3) == "3 mit Vorschlag · etwa 2 Minuten")
        #expect(PendingText.subtitle(2, withSuggestions: 0) == "Noch ohne Vorschlag · etwa 1 Minute")
    }
}

@Suite struct ConfirmTests {
    let pots = [Pot(id: "p1", householdId: "h2", name: "Lebensmittel", kind: .monatlich)]
    let account = Account(id: "a1", householdId: "h2", name: "Gemeinsames Konto", source: .bank)

    @Test func karteMitVorschlag() {
        let t = Transaction(
            id: "t1", accountId: "a1", bookingDate: "2026-11-16", amountCents: -3_418,
            counterpartyName: "Supermarkt Beispiel", purpose: "Einkauf", status: .vorgeschlagen,
            suggestion: Suggestion(source: .regel, target: .pot("p1"), confidencePct: 95, reason: "Wie die letzten Einkäufe.")
        )
        let card = ConfirmCard(transaction: t, account: account, household: gemeinsam, pots: pots)
        #expect(card.when == "Mo, 16. Nov · Gemeinsames Konto")
        #expect(card.title == "Supermarkt Beispiel")
        #expect(card.amount == "\u{2212}34,18\u{00A0}€")
        #expect(card.suggestion == "Lebensmittel")
        #expect(card.household == "Gemeinsam")
        #expect(card.isShared)
        #expect(card.confidence == "sicher")
        #expect(card.canConfirm)
        #expect(card.note == nil)
    }

    @Test func karteOhneVorschlagUndBargeld() {
        let t = Transaction(
            id: "t2", accountId: "a1", bookingDate: "2026-11-13", amountCents: -5_000,
            counterpartyName: nil, purpose: "Bargeldauszahlung Geldautomat", status: .importiert
        )
        let card = ConfirmCard(transaction: t, account: nil, household: ich, pots: pots)
        #expect(card.title == "Bargeldauszahlung Geldautomat")
        #expect(card.when == "Fr, 13. Nov")
        #expect(card.suggestion == nil)
        #expect(!card.canConfirm)
        #expect(card.note != nil)
        #expect(card.isWithdrawal)
        #expect(card.offersCash)
        #expect(card.household == "Ich")
    }

    @Test func abhebungInsBargeld() {
        let cash = Account(id: "c1", householdId: "h1", name: "Bargeld", source: .bar, unrecordedCashCents: 0)
        let giro = Account(id: "a1", householdId: "h1", name: "Giro", source: .bank)
        let suggested = Transaction(
            id: "t4", accountId: "a1", bookingDate: "2026-11-13", amountCents: -5_000,
            counterpartyName: "Geldautomat Beispielbank", purpose: nil, status: .vorgeschlagen,
            suggestion: Suggestion(source: .regel, target: .transferTo("c1"), confidencePct: 100, reason: "Regel")
        )
        let card = ConfirmCard(transaction: suggested, account: giro, household: ich, pots: pots, accounts: [giro, cash])
        #expect(card.suggestion == "Ins Bargeld")
        #expect(card.isWithdrawal)
        #expect(!card.offersCash)
        #expect(card.note == "Zählt als Bargeld, bis du Ausgaben mit dem Plus erfasst.")
        let context = TargetContext(household: ich, pots: [], accounts: [giro])
        #expect(context.label(.transferTo("a1"), amountCents: -5_000) == "Umbuchung → Giro")
        #expect(context.label(.transferTo("x"), amountCents: -5_000) == "Umbuchung")

        // Ausgänge bieten „Ins Bargeld“ an, Eingänge nicht.
        let out = TargetOption.options(pots: pots, forIncome: false, cashAccounts: [cash, giro])
        #expect(out.contains { $0.target == .transferTo("c1") && $0.label == "Ins Bargeld" })
        #expect(!out.contains { $0.target == .transferTo("a1") })
        let incoming = TargetOption.options(pots: pots, forIncome: true, cashAccounts: [cash])
        #expect(!incoming.contains { $0.target == .transferTo("c1") })

        let groceries = Transaction(id: "t5", accountId: "a1", bookingDate: "2026-11-13", amountCents: -2_000,
                                    counterpartyName: "Supermarkt Beispiel", status: .importiert)
        #expect(!ConfirmCard.looksLikeWithdrawal(groceries))
    }

    @Test func eingangMitPlus() {
        let t = Transaction(id: "t3", accountId: "a1", bookingDate: "2026-11-01", amountCents: 250_000,
                            counterpartyName: "  ", purpose: nil, status: .importiert)
        let card = ConfirmCard(transaction: t, account: nil, household: ich, pots: [])
        #expect(card.amount == "+2.500,00\u{00A0}€")
        #expect(card.isIncome)
        #expect(card.title == "Ohne Angaben")
        let options = TargetOption.options(pots: pots, forIncome: true)
        #expect(options.first?.target == .income)
        #expect(TargetOption.options(pots: pots, forIncome: false).first?.target == .pot("p1"))
    }
}

@Suite struct DraftTests {
    @Test func barausgabe() {
        var draft = CashExpenseDraft(clientId: "c1", bookingDate: "2026-11-17")
        #expect(draft.problem == "Wie viel hast du ausgegeben?")
        draft.amountText = "4,5x"
        #expect(draft.problem == "Den Betrag verstehe ich nicht, z. B. 4,50.")
        draft.amountText = "0"
        #expect(draft.expense == nil)
        draft.amountText = "4,50"
        #expect(draft.problem == "Aus welchem Topf?")
        draft.potId = "p1"
        draft.description = "  Bäcker  "
        #expect(draft.problem == nil)
        #expect(draft.expense == CashExpense(clientId: "c1", bookingDate: "2026-11-17", amountCents: 450, description: "Bäcker", potId: "p1"))
    }

    @Test func aufteilen() {
        let t = Transaction(
            id: "t1", accountId: "a1", bookingDate: "2026-11-16", amountCents: -5_000, status: .vorgeschlagen,
            suggestion: Suggestion(source: .llm, target: .pot("p1"), confidencePct: 70, reason: "")
        )
        var draft = SplitDraft(transaction: t)
        #expect(draft.rows.count == 2)
        #expect(draft.rows[0].amountText == "50,00")
        #expect(draft.problem == nil)
        #expect(draft.splits == [Split(target: .pot("p1"), amountCents: -5_000)])

        draft.rows[0].amountText = "35"
        #expect(draft.remainingCents == 1_500)
        #expect(draft.problem == "Noch 15\u{00A0}€ zu verteilen.")
        draft.fillRemainder()
        #expect(draft.rows[1].amountText == "15,00")
        #expect(draft.problem == "Jeder Betrag braucht ein Ziel.")
        draft.rows[1].target = .pot("p2")
        #expect(draft.splits == [Split(target: .pot("p1"), amountCents: -3_500), Split(target: .pot("p2"), amountCents: -1_500)])

        draft.rows[1].target = .pot("p1")
        #expect(draft.splits == [Split(target: .pot("p1"), amountCents: -5_000)])

        draft.rows[1].amountText = "20"
        #expect(draft.problem == "5\u{00A0}€ zu viel verteilt.")
        draft.rows[1].amountText = "abc"
        #expect(draft.problem == "Ein Betrag ist ungültig, z. B. 4,50.")
    }

    @Test func aufteilenEingangBleibtPositiv() {
        let t = Transaction(id: "t1", accountId: "a1", bookingDate: "2026-11-01", amountCents: 10_000, status: .importiert)
        var draft = SplitDraft(transaction: t)
        draft.rows[0].target = .income
        #expect(draft.splits == [Split(target: .income, amountCents: 10_000)])
    }
}

@Suite struct SnapshotTests {
    @Test func schnappschussAusBudget() throws {
        let budget = BudgetMonth(householdId: "h1", month: november, readyToAssignCents: 21_500, pots: [
            BudgetPot(potId: "p1", name: "Freizeit", kind: .monatlich, assignedCents: 15_000, availableCents: 6_200),
            BudgetPot(potId: "p2", name: "Bücher", kind: .monatlich, assignedCents: 6_000, availableCents: 1_200),
            BudgetPot(potId: "p3", name: "Essen", kind: .monatlich, assignedCents: 5_000, availableCents: -300),
            BudgetPot(potId: "p4", name: "Leer", kind: .monatlich),
            BudgetPot(potId: "p5", name: "Rücklage", kind: .ruecklage, availableCents: 50_000),
            BudgetPot(potId: "p6", name: "Mobilität", kind: .monatlich, assignedCents: 18_000, availableCents: 9_500),
        ])
        let now = Date(timeIntervalSince1970: 1_794_900_000)
        let snap = WidgetSnapshot(budget: budget, household: ich, pendingCount: 3, now: now)
        #expect(snap.freeInPotsCents == 6_200 + 1_200 + 9_500)
        #expect(snap.tightestPots.map(\.name) == ["Essen", "Bücher", "Freizeit"])

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SnapshotStore(directory: dir)
        #expect(store.load() == nil)
        try store.save(snap)
        #expect(store.load() == snap)
        store.clear()
        #expect(store.load() == nil)
    }

    @Test func meldetNurNeueBuchungen() {
        let n = PendingNotifier()
        let first = n.evaluate(pendingIds: ["a", "b"], withSuggestions: 2, seen: [])
        #expect(first.notice?.title == "2 Buchungen warten")
        #expect(first.seen == ["a", "b"])

        let same = n.evaluate(pendingIds: ["a", "b"], withSuggestions: 2, seen: first.seen)
        #expect(same.notice == nil)

        // a bestätigt, c neu: gleiche Anzahl, trotzdem melden
        let swapped = n.evaluate(pendingIds: ["b", "c"], withSuggestions: 1, seen: same.seen)
        #expect(swapped.notice?.body == "1 mit Vorschlag · etwa 1 Minute")

        let done = n.evaluate(pendingIds: [], withSuggestions: 0, seen: swapped.seen)
        #expect(done.notice == nil)
        #expect(done.seen.isEmpty)
    }
}
