import Foundation
import FreiraumAPI

// Budgetbeginn und Anfangsbestand eines Haushalts (FREI-13, in der App seit FREI-30).
// Der Server rechnet: Anfangsbestand eines Kontos = Kontostand − Buchungen ab dem Startmonat bis
// zum Stichtag. Die Summe zählt im Startmonat zu „Noch ohne Aufgabe“.

/// Kontostand, wie ihn der Server kennt.
public struct AccountBalance: Hashable, Sendable, Codable {
    public enum Source: String, Sendable, Codable { case manuell, anbieter }

    public let cents: Int
    /// Stichtag „JJJJ-MM-TT“: Stand am Ende dieses Tages.
    public let date: String
    public let source: Source

    public init(cents: Int, date: String, source: Source = .manuell) {
        self.cents = cents
        self.date = date
        self.source = source
    }
}

public struct BudgetStart: Hashable, Sendable, Codable {
    public struct AccountOpening: Hashable, Sendable, Codable, Identifiable {
        public var id: String { accountId }
        public let accountId: String
        public let name: String
        public let balance: AccountBalance?
        /// Stand zu Beginn des Startmonats; nil ohne Kontostand.
        public let openingBalanceCents: Int?

        public init(accountId: String, name: String, balance: AccountBalance? = nil, openingBalanceCents: Int? = nil) {
            self.accountId = accountId
            self.name = name
            self.balance = balance
            self.openingBalanceCents = openingBalanceCents
        }
    }

    public let householdId: String
    public let month: YearMonth
    /// Summe der Konten; Konten ohne Kontostand zählen mit 0.
    public let openingBalanceCents: Int
    public let accounts: [AccountOpening]

    public init(householdId: String, month: YearMonth, openingBalanceCents: Int, accounts: [AccountOpening]) {
        self.householdId = householdId
        self.month = month
        self.openingBalanceCents = openingBalanceCents
        self.accounts = accounts
    }

    /// Konten, für die noch kein Kontostand erfasst ist.
    public var accountsWithoutBalance: [AccountOpening] {
        accounts.filter { $0.balance == nil }
    }

    /// Satz unter der Summe: wo der Anfangsbestand im Budget auftaucht.
    public var summary: String {
        if accounts.isEmpty {
            return "Noch kein Konto. Leg eins an und trag den Kontostand ein, dann zählt er im \(month.title) zu „Noch ohne Aufgabe“."
        }
        let missing = accountsWithoutBalance.count
        let base = "Zählt im \(month.title) zu „Noch ohne Aufgabe“, nicht zu den Einnahmen."
        switch missing {
        case 0: return base
        case 1: return base + " Ein Konto hat noch keinen Kontostand und zählt mit 0."
        default: return base + " \(missing) Konten haben noch keinen Kontostand und zählen mit 0."
        }
    }
}

/// Auswahl des Startmonats.
public enum BudgetStartChoices {
    /// Wählbare Startmonate, neueste zuerst: vom nächsten Monat bis `back` Monate vor `current`.
    /// Ein gesetzter Start außerhalb dieses Fensters bleibt wählbar.
    public static func months(current: YearMonth, selected: YearMonth? = nil, back: Int = 24) -> [YearMonth] {
        var months: [YearMonth] = []
        var m = current.next
        for _ in 0...(back + 1) {
            months.append(m)
            m = m.previous
        }
        if let selected, !months.contains(selected) {
            months.append(selected)
            months.sort(by: >)
        }
        return months
    }
}

/// Eingabe „Kontostand erfassen“: Betrag ohne Vorzeichen, Schalter fürs Minus, Stichtag.
public struct BalanceDraft: Hashable, Sendable {
    public var amountText: String
    /// Konto im Minus (Dispo, Kreditkarte).
    public var negative: Bool
    /// Stichtag „JJJJ-MM-TT“
    public var date: String
    public let today: String

    /// Vorbelegt mit dem bekannten Kontostand, sonst leer mit heute als Stichtag.
    public init(balance: AccountBalance? = nil, today: String = GermanDates.isoDate(Date())) {
        self.today = today
        if let balance {
            amountText = Money.number(abs(balance.cents), style: .exact)
            negative = balance.cents < 0
            date = balance.date
        } else {
            amountText = ""
            negative = false
            date = today
        }
    }

    /// Betrag mit Vorzeichen in Cent; nil bei ungültiger Eingabe.
    public var cents: Int? {
        Money.parse(amountText).map { negative ? -$0 : $0 }
    }

    /// Was noch fehlt, in einem Satz; nil = bereit.
    public var problem: String? {
        if amountText.trimmingCharacters(in: .whitespaces).isEmpty { return "Wie viel ist auf dem Konto?" }
        if cents == nil { return "Den Betrag verstehe ich nicht, z. B. 1.234,56." }
        if GermanDates.parseISODate(date) == nil { return "Der Stichtag ist ungültig." }
        if date > today { return "Der Stichtag darf nicht in der Zukunft liegen." }
        return nil
    }
}

/// Fehler rund um den Budgetbeginn so erklären, dass klar ist, was zu tun ist.
public enum BudgetStartMessages {
    public static func explain(_ error: any Error) -> String {
        guard let api = error as? APIError else {
            return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        switch api.code {
        case "budgetbeginn_fest":
            return "Der Budgetbeginn steht fest, weil schon ein Monat abgeschlossen ist. Öffne die abgeschlossenen Monate wieder, den neuesten zuerst, dann lässt er sich verschieben."
        case "zuweisungen_vor_budgetbeginn":
            let message = humanizeMonths(in: api.errorDescription ?? "")
            return message + " Das geht in der Übersicht: Monat wählen, Töpfe antippen, Betrag 0."
        default:
            return api.errorDescription ?? "Unbekannter Fehler."
        }
    }

    /// „2026-09“ → „September 2026“
    static func humanizeMonths(in text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"\b\d{4}-\d{2}\b"#) else { return text }
        var result = text
        let ns = text as NSString
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            let token = ns.substring(with: match.range)
            guard let month = YearMonth(token), let range = Range(match.range, in: result) else { continue }
            result.replaceSubrange(range, with: month.title)
        }
        return result
    }
}

// MARK: - Dienst

extension FreiraumService {
    /// Budgetbeginn, Anfangsbestand und Kontostände eines Haushalts.
    public func budgetStart(householdId: String) async throws(APIError) -> BudgetStart {
        try await call {
            let out = try await client.getV1HouseholdsHouseholdIdBudgetStart(path: .init(householdId: householdId))
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetStart(try ok.body.json)
        }
    }

    /// Startmonat festlegen. 409, wenn schon ein Monat abgeschlossen ist oder vor dem neuen Start
    /// eigene Zuweisungen liegen (`BudgetStartMessages.explain`).
    public func setBudgetStart(householdId: String, month: YearMonth) async throws(APIError) -> BudgetStart {
        try await call {
            let out = try await client.putV1HouseholdsHouseholdIdBudgetStart(
                path: .init(householdId: householdId),
                body: .json(.init(month: month.description))
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetStart(try ok.body.json)
        }
    }

    /// Kontostand von Hand erfassen (Stand am Ende von `date`). Liefert den Budgetbeginn des
    /// Haushalts danach.
    public func setBalance(accountId: String, cents: Int, date: String) async throws(APIError) -> BudgetStart {
        try await call {
            let out = try await client.putV1AccountsAccountIdBalance(
                path: .init(accountId: accountId),
                body: .json(.init(balanceCents: cents, date: date))
            )
            guard case let .ok(ok) = out else { throw unexpected(out) }
            return try BudgetStart(try ok.body.json)
        }
    }

    /// Konto im Haushalt anlegen, etwa ein Girokonto, bevor der Kontoimport läuft.
    public func createAccount(householdId: String, name: String, source: Account.Source) async throws(APIError) -> Account {
        try await call {
            let out = try await client.postV1Accounts(body: .json(.init(
                householdId: householdId, name: name, source: try generatedEnum(source.rawValue)
            )))
            guard case let .created(created) = out else { throw unexpected(out) }
            return try Account(try created.body.json)
        }
    }
}

// MARK: - Abbildung

/// Wert eines generierten Enums aus dem Rohwert; der Typ ergibt sich aus dem Aufruf.
private func generatedEnum<T: RawRepresentable>(_ raw: String) throws -> T where T.RawValue == String {
    guard let value = T(rawValue: raw) else { throw MappingError(description: "Wert \(raw)") }
    return value
}

extension BudgetStart {
    init(_ s: Components.Schemas.BudgetStart) throws {
        guard let month = YearMonth(s.month) else { throw MappingError(description: "Monat \(s.month)") }
        self.init(
            householdId: s.householdId, month: month, openingBalanceCents: s.openingBalanceCents,
            accounts: try s.accounts.map { a in
                AccountOpening(
                    accountId: a.accountId, name: a.name,
                    balance: try a.balance.map { b in
                        guard let source = AccountBalance.Source(rawValue: b.source.rawValue) else {
                            throw MappingError(description: "Quelle \(b.source.rawValue)")
                        }
                        return AccountBalance(cents: b.cents, date: b.date, source: source)
                    },
                    openingBalanceCents: a.openingBalanceCents
                )
            }
        )
    }
}
