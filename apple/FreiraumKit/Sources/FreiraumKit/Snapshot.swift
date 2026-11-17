import Foundation

/// Was das Widget zeigt. Die App schreibt den Schnappschuss nach jedem Laden in den
/// gemeinsamen App-Group-Ordner; das Widget liest nur ihn und fragt den Server nie selbst
/// (kein Token im Widget, keine Netzlast im Hintergrund).
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    public struct PotLine: Codable, Hashable, Sendable {
        public let name: String
        public let availableCents: Int

        public init(name: String, availableCents: Int) {
            self.name = name
            self.availableCents = availableCents
        }
    }

    public let updatedAt: Date
    public let month: YearMonth
    public let householdLabel: String
    /// „Noch ohne Aufgabe“
    public let readyToAssignCents: Int
    /// Frei in den Monatstöpfen (Summe der positiven Verfügbar-Beträge)
    public let freeInPotsCents: Int
    public let pendingCount: Int
    /// Die knappsten Monatstöpfe zuerst, höchstens drei
    public let tightestPots: [PotLine]

    public init(
        updatedAt: Date, month: YearMonth, householdLabel: String, readyToAssignCents: Int,
        freeInPotsCents: Int, pendingCount: Int, tightestPots: [PotLine]
    ) {
        self.updatedAt = updatedAt
        self.month = month
        self.householdLabel = householdLabel
        self.readyToAssignCents = readyToAssignCents
        self.freeInPotsCents = freeInPotsCents
        self.pendingCount = pendingCount
        self.tightestPots = tightestPots
    }

    public init(budget: BudgetMonth, household: Household, pendingCount: Int, now: Date = Date()) {
        let monthly = budget.pots.filter { $0.kind == .monatlich && !$0.archived }
        self.init(
            updatedAt: now, month: budget.month, householdLabel: household.shortLabel,
            readyToAssignCents: budget.readyToAssignCents,
            freeInPotsCents: monthly.reduce(0) { $0 + max(0, $1.availableCents) },
            pendingCount: pendingCount,
            tightestPots: monthly
                .filter { $0.carryoverCents + $0.assignedCents > 0 || $0.availableCents < 0 }
                .sorted { ($0.availableCents, $0.name) < ($1.availableCents, $1.name) }
                .prefix(3)
                .map { PotLine(name: $0.name, availableCents: $0.availableCents) }
        )
    }

    /// Beispielwerte für die Widget-Vorschau (erfunden).
    public static let placeholder = WidgetSnapshot(
        updatedAt: Date(timeIntervalSince1970: 1_794_900_000), month: YearMonth(year: 2026, month: 11),
        householdLabel: "Ich", readyToAssignCents: 21_500, freeInPotsCents: 30_900, pendingCount: 4,
        tightestPots: [
            PotLine(name: "Bücher & Lernen", availableCents: 1_200),
            PotLine(name: "Freizeit", availableCents: 6_200),
            PotLine(name: "Mobilität", availableCents: 9_500),
        ]
    )
}

/// Liest und schreibt den Schnappschuss als JSON-Datei.
public struct SnapshotStore: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// Ordner der App Group, z. B. `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`.
    public init(directory: URL) {
        url = directory.appendingPathComponent("widget-snapshot.json")
    }

    public func load() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    public func save(_ snapshot: WidgetSnapshot) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(snapshot).write(to: url, options: .atomic)
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Entscheidet, ob „Buchungen warten“ gemeldet wird: nur wenn seit der letzten Meldung neue
/// Buchungen dazugekommen sind. Gemerkt werden die IDs, nicht die Anzahl, damit eine bestätigte
/// und eine neue Buchung nicht als „nichts Neues“ durchgehen.
public struct PendingNotifier: Sendable {
    public struct Notice: Hashable, Sendable {
        public let title: String
        public let body: String
    }

    public init() {}

    /// - Returns: Meldung (oder nil) und die IDs, die als gesehen gelten.
    public func evaluate(pendingIds: Set<String>, withSuggestions: Int, seen: Set<String>) -> (notice: Notice?, seen: Set<String>) {
        // Erledigte vergessen, damit die Menge nicht wächst.
        let stillOpen = seen.intersection(pendingIds)
        let fresh = pendingIds.subtracting(seen)
        guard !fresh.isEmpty, let title = PendingText.title(pendingIds.count) else {
            return (nil, stillOpen)
        }
        let body = PendingText.subtitle(pendingIds.count, withSuggestions: withSuggestions)
        return (Notice(title: title, body: body), pendingIds)
    }
}
