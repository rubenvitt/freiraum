import Foundation

/// Eine Karte im Ablauf „Buchungen bestätigen“.
public struct ConfirmCard: Hashable, Sendable, Identifiable {
    public let id: String
    /// „Mo, 16. Nov · Girokonto“
    public let when: String
    /// Gegenpartei, sonst Verwendungszweck
    public let title: String
    /// „−34,18 €“
    public let amount: String
    public let isIncome: Bool
    /// Vorschlag, z. B. „Lebensmittel“; nil = kein Vorschlag
    public let suggestion: String?
    /// „Ich“ oder „Gemeinsam“
    public let household: String
    public let isShared: Bool
    /// Begründung des Vorschlags in einem Satz
    public let reason: String?
    /// „sicher“, „ziemlich sicher“, „unsicher“
    public let confidence: String?
    /// Hinweis, z. B. bei Bargeldabhebung
    public let note: String?
    /// „Passt“ geht nur mit Vorschlag
    public let canConfirm: Bool
    /// Sieht nach einer Abhebung am Automaten aus
    public let isWithdrawal: Bool
    /// Abhebung, die noch nicht ins Bargeld gebucht ist: die App bietet „Ins Bargeld“ an
    public let offersCash: Bool

    /// Ohne Wissen über andere Haushalte (z. B. im Test): nur die Töpfe und Konten des Haushalts.
    /// - Parameter accounts: Konten des Haushalts (für Namen von Gegenkonten und das Bargeldkonto)
    public init(
        transaction t: Transaction, account: Account?, household: Household?, pots: [Pot],
        accounts: [Account] = [], today: String? = nil
    ) {
        self.init(
            transaction: t, account: account,
            context: TargetContext(household: household, pots: pots, accounts: accounts), today: today
        )
    }

    public init(transaction t: Transaction, account: Account?, context: TargetContext, today: String? = nil) {
        id = t.id
        let day = GermanDates.bookingDay(t.bookingDate, today: today)
        when = account.map { "\(day) · \($0.name)" } ?? day
        let name = t.counterpartyName?.trimmed ?? t.purpose?.trimmed
        title = name.flatMap { $0.isEmpty ? nil : $0 } ?? "Ohne Angaben"
        amount = Money.format(t.amountCents, style: .exact, sign: true)
        isIncome = t.amountCents > 0
        self.household = context.household?.shortLabel ?? ""
        isShared = context.household?.kind == .gemeinsam
        if let s = t.suggestion {
            suggestion = context.label(s.target, amountCents: t.amountCents)
            reason = s.reason.isEmpty ? nil : s.reason
            confidence = s.confidencePct >= 90 ? "sicher" : s.confidencePct >= 60 ? "ziemlich sicher" : "unsicher"
        } else {
            suggestion = nil
            reason = "Noch kein Vorschlag. Ordne die Buchung selbst zu, daraus wird eine Regel."
            confidence = nil
        }
        canConfirm = t.status == .vorgeschlagen && t.suggestion != nil
        let withdrawal = ConfirmCard.looksLikeWithdrawal(t)
        let cashIds = Set(context.cashAccounts.map(\.id))
        var bookedAsCash = false
        if case let .transferTo(id)? = t.suggestion?.target {
            bookedAsCash = cashIds.contains(id)
        }
        let offers = withdrawal && !bookedAsCash
        isWithdrawal = withdrawal
        offersCash = offers
        if offers {
            note = "Bargeld ist noch keine Ausgabe: ins Bargeld buchen und Ausgaben später mit dem Plus erfassen."
        } else if withdrawal {
            note = "Zählt als Bargeld, bis du Ausgaben mit dem Plus erfasst."
        } else {
            note = nil
        }
    }

    /// Abhebung am Automaten: ein Ausgang mit typischen Wörtern in Gegenpartei oder Zweck.
    public static func looksLikeWithdrawal(_ t: Transaction) -> Bool {
        guard t.amountCents < 0 else { return false }
        let text = "\(t.counterpartyName ?? "") \(t.purpose ?? "")".lowercased()
        return ["bargeld", "geldautomat", "auszahlung", "abhebung"].contains { text.contains($0) }
    }
}

/// Was die App über den Haushalt eines Kontos weiß, um Ziele anzubieten und zu benennen:
/// die Töpfe des Haushalts, Töpfe über die Haushaltsgrenze hinweg und wer angemeldet ist.
///
/// - Gemeinsames Konto: zusätzlich die eigenen privaten Töpfe. Die Ausgabe wird zur Schuld der
///   Person ans Gemeinsame (FREI-18). Private Töpfe der anderen Person kennt die App nicht; sie
///   heißen „privat (Name)“.
/// - Privates Konto: zusätzlich die Töpfe des gemeinsamen Haushalts. Die Ausgabe wird zur
///   Forderung ans Gemeinsame.
public struct TargetContext: Hashable, Sendable {
    public let household: Household?
    /// Töpfe des Haushalts, zu dem das Konto gehört
    public let pots: [Pot]
    /// Gemeinsames Konto: eigene private Töpfe; privates Konto: Töpfe des gemeinsamen Haushalts
    public let crossPots: [Pot]
    /// Mitglieder des gemeinsamen Haushalts (für Einzahlung und Ausgleich)
    public let sharedMembers: [Person]
    public let me: Person?
    /// Konten des Haushalts (für Namen von Gegenkonten und „Ins Bargeld“)
    public let accounts: [Account]

    public init(
        household: Household?, pots: [Pot], crossPots: [Pot] = [], sharedMembers: [Person] = [], me: Person? = nil,
        accounts: [Account] = []
    ) {
        self.household = household
        self.pots = pots
        self.crossPots = crossPots
        self.sharedMembers = sharedMembers
        self.me = me
        self.accounts = accounts
    }

    /// Kontext für ein Konto aus allem, was die App geladen hat.
    /// - Parameter pots: Töpfe je Haushalts-ID
    /// - Parameter accounts: Konten des Haushalts, zu dem das Konto gehört
    public init(
        household: Household?, households: [Household], pots: [String: [Pot]], me: Person?, accounts: [Account] = []
    ) {
        let shared = households.filter { $0.kind == .gemeinsam }
        var cross: [Pot] = []
        var members: [Person] = []
        switch household?.kind {
        case .gemeinsam?:
            let own = households.first { $0.kind == .privat && (me == nil || $0.members.contains { $0.id == me?.id }) }
            cross = own.flatMap { pots[$0.id] } ?? []
            members = household?.members ?? []
        case .privat?:
            cross = shared.flatMap { pots[$0.id] ?? [] }
            members = shared.first?.members ?? []
        case nil:
            break
        }
        self.init(
            household: household, pots: household.flatMap { pots[$0.id] } ?? [], crossPots: cross,
            sharedMembers: members, me: me, accounts: accounts
        )
    }

    var isShared: Bool { household?.kind == .gemeinsam }

    /// Bargeldkonten des Haushalts
    var cashAccounts: [Account] { accounts.filter { $0.source == .bar } }

    /// Gibt es einen gemeinsamen Haushalt, mit dem Geld hin- und hergehen kann?
    var hasCounterpart: Bool { isShared || !sharedMembers.isEmpty }

    /// Name einer Person; die angemeldete Person heißt je nach Fall „mir“ bzw. „mich“.
    private func personName(_ id: String?, me pronoun: String) -> String {
        guard let id else { return "unbekannt" }
        if id == me?.id { return pronoun }
        return sharedMembers.first { $0.id == id }?.displayName ?? "anderer Person"
    }

    /// Andere Person(en) im gemeinsamen Haushalt, für „privat (Name)“.
    private var otherName: String {
        let others = sharedMembers.filter { $0.id != me?.id }
        return others.count == 1 ? others[0].displayName : "andere Person"
    }

    /// Anzeigename eines Ziels. Einzahlung und Ausgleich hängen von der Richtung ab.
    public func label(_ target: SplitTarget, amountCents: Int) -> String {
        let incoming = amountCents > 0
        switch target {
        case let .pot(id):
            if let pot = pots.first(where: { $0.id == id }) { return pot.name }
            if let pot = crossPots.first(where: { $0.id == id }) {
                return "\(pot.name) (\(isShared ? "privat" : "gemeinsam"))"
            }
            return isShared ? "privat (\(otherName))" : "Unbekannter Topf"
        case .income:
            return "Einnahme"
        case .transfer:
            return "Umbuchung"
        case let .transferTo(id):
            guard let account = accounts.first(where: { $0.id == id }) else { return "Umbuchung" }
            return account.source == .bar ? "Ins Bargeld" : "Umbuchung → \(account.name)"
        case let .contribution(personId):
            return isShared ? "Einzahlung von \(personName(personId, me: "mir"))" : "Einzahlung ins Gemeinsame"
        case let .settlement(personId):
            if isShared {
                return incoming
                    ? "Rückzahlung von \(personName(personId, me: "mir"))"
                    : "Erstattung an \(personName(personId, me: "mich"))"
            }
            return incoming ? "Erstattung vom Gemeinsamen" : "Rückzahlung ans Gemeinsame"
        }
    }

    /// Lernt der Server aus dieser Wahl eine Regel? Nicht bei privaten Töpfen auf dem gemeinsamen
    /// Konto und nicht bei einer Rückzahlung (Ausgleich gegen die übliche Richtung), siehe ADR 0006.
    public func learnsRule(_ target: SplitTarget, amountCents: Int) -> Bool {
        switch target {
        case let .pot(id):
            return !(isShared && !pots.contains { $0.id == id })
        case .settlement:
            // übliche Richtung: gemeinsam ein Ausgang (Erstattung), privat ein Eingang
            return isShared ? amountCents < 0 : amountCents > 0
        case .income, .transfer, .transferTo, .contribution:
            return true
        }
    }

    /// Mögliche Ziele für eine Buchung mit diesem Betrag, in Gruppen.
    public func groups(amountCents: Int) -> [TargetGroup] {
        let forIncome = amountCents > 0
        func sorted(_ pots: [Pot]) -> [Pot] {
            pots.filter { !$0.archived }.sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
        }
        func option(_ target: SplitTarget, group: String) -> TargetOption {
            TargetOption(target: target, label: label(target, amountCents: amountCents), group: group)
        }

        // Töpfe des Haushalts nach Gruppe, in der Reihenfolge des ersten Auftretens.
        var potGroups: [TargetGroup] = []
        for pot in sorted(pots) {
            let title = pot.groupName ?? "Töpfe"
            let item = TargetOption(target: .pot(pot.id), label: pot.name, group: title)
            if let i = potGroups.firstIndex(where: { $0.title == title }) {
                potGroups[i].options.append(item)
            } else {
                potGroups.append(TargetGroup(title: title, options: [item]))
            }
        }

        var cross: TargetGroup?
        let crossActive = sorted(crossPots)
        if !crossActive.isEmpty {
            let title = isShared ? "Privat (ich zahle zurück)" : "Gemeinsam (wird erstattet)"
            cross = TargetGroup(
                title: title,
                options: crossActive.map { TargetOption(target: .pot($0.id), label: $0.name, group: title) },
                footer: isShared
                    ? "Belastet deinen privaten Topf. Den Betrag schuldest du dem gemeinsamen Konto, er steht im Ausgleich. Daraus entsteht keine Regel."
                    : "Belastet den gemeinsamen Topf. Das Gemeinsame schuldet dir den Betrag, er steht im Ausgleich."
            )
        }

        // Bei Ausgängen zuerst „Ins Bargeld“ (Umbuchung mit dem Bargeldkonto als Gegenkonto).
        let cash = forIncome ? [] : cashAccounts
        var special = cash.map {
            TargetOption(
                target: .transferTo($0.id), label: cash.count == 1 ? "Ins Bargeld" : "Ins Bargeld (\($0.name))",
                group: "Sonstiges"
            )
        }
        special += [option(.income, group: "Sonstiges"), option(.transfer, group: "Sonstiges")]
        if hasCounterpart {
            if isShared {
                let members = sharedMembers.filter { $0.id == me?.id } + sharedMembers.filter { $0.id != me?.id }
                for person in members {
                    if forIncome { special.append(option(.contribution(personId: person.id), group: "Sonstiges")) }
                    special.append(option(.settlement(personId: person.id), group: "Sonstiges"))
                }
            } else {
                if !forIncome { special.append(option(.contribution(personId: nil), group: "Sonstiges")) }
                special.append(option(.settlement(personId: nil), group: "Sonstiges"))
            }
        }
        let other = TargetGroup(
            title: "Sonstiges", options: special,
            footer: special.contains { !learnsRule($0.target, amountCents: amountCents) }
                ? "Eine Rückzahlung wird nicht zur Regel, sonst würden künftige Einzahlungen zu Rückzahlungen."
                : nil
        )

        var result = potGroups
        if let cross { result.append(cross) }
        return forIncome ? [other] + result : result + [other]
    }

    /// Alle Ziele ohne Gruppen (z. B. für eine Auswahlliste).
    public func options(amountCents: Int) -> [TargetOption] {
        groups(amountCents: amountCents).flatMap(\.options)
    }
}

/// Mögliches Ziel für eine Buchung.
public struct TargetOption: Hashable, Sendable, Identifiable {
    public var id: SplitTarget { target }
    public let target: SplitTarget
    public let label: String
    public let group: String

    public init(target: SplitTarget, label: String, group: String) {
        self.target = target
        self.label = label
        self.group = group
    }

    /// Ohne Wissen über andere Haushalte: aktive Töpfe, Einnahme, Umbuchung.
    /// - Parameter cashAccounts: Bargeldkonten des Haushalts; bei Ausgängen gibt es „Ins Bargeld“
    public static func options(pots: [Pot], forIncome: Bool, cashAccounts: [Account] = []) -> [TargetOption] {
        TargetContext(household: nil, pots: pots, accounts: cashAccounts).options(amountCents: forIncome ? 1 : -1)
    }
}

/// Gruppe in der Zielauswahl, z. B. „Fixkosten“ oder „Privat (ich zahle zurück)“.
public struct TargetGroup: Hashable, Sendable, Identifiable {
    public var id: String { title }
    public let title: String
    public var options: [TargetOption]
    /// Erklärung unter der Gruppe
    public let footer: String?

    public init(title: String, options: [TargetOption], footer: String? = nil) {
        self.title = title
        self.options = options
        self.footer = footer
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}