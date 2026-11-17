/// Texte zum Bargeldbestand: abgehobenes Bargeld, für das noch keine Ausgaben erfasst sind
/// (der Server rechnet ihn je Bargeldkonto, siehe ADR 0004).
public enum CashText {
    /// Bestand aller Bargeldkonten eines Haushalts in Cent.
    public static func unrecordedCents(accounts: [Account], householdId: String) -> Int {
        accounts
            .filter { $0.householdId == householdId && $0.source == .bar }
            .reduce(0) { $0 + ($1.unrecordedCashCents ?? 0) }
    }

    /// Übersicht: „30 € Bargeld noch nicht erfasst“; nil, wenn nichts offen ist.
    public static func unrecorded(_ cents: Int) -> String? {
        cents > 0 ? "\(Money.format(cents)) Bargeld noch nicht erfasst" : nil
    }

    /// Nach dem Bestätigen: „Denk an die 50 € Bargeld“; nil, wenn nichts offen ist.
    public static func reminder(_ cents: Int) -> String? {
        cents > 0 ? "Denk an die \(Money.format(cents)) Bargeld" : nil
    }
}
