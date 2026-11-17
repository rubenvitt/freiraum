import Foundation

/// Ein Budgetmonat, wie die API ihn schreibt: „2026-11“.
public struct YearMonth: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int

    public init(year: Int, month: Int) {
        precondition((1...12).contains(month), "Monat muss zwischen 1 und 12 liegen")
        self.year = year
        self.month = month
    }

    public init?(_ text: String) {
        let parts = text.split(separator: "-")
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), (1...12).contains(m)
        else { return nil }
        self.init(year: y, month: m)
    }

    /// Monat, in dem `date` in Deutschland liegt.
    public static func current(_ date: Date = Date(), timeZone: TimeZone = .berlin) -> YearMonth {
        let c = Calendar.gregorian(timeZone).dateComponents([.year, .month], from: date)
        return YearMonth(year: c.year ?? 1970, month: c.month ?? 1)
    }

    public var description: String {
        String(format: "%04d-%02d", year, month)
    }

    public var previous: YearMonth {
        month == 1 ? YearMonth(year: year - 1, month: 12) : YearMonth(year: year, month: month - 1)
    }

    public var next: YearMonth {
        month == 12 ? YearMonth(year: year + 1, month: 1) : YearMonth(year: year, month: month + 1)
    }

    /// „November 2026“
    public var title: String { "\(GermanDates.monthNames[month - 1]) \(year)" }

    /// „November“
    public var name: String { GermanDates.monthNames[month - 1] }

    public static func < (a: YearMonth, b: YearMonth) -> Bool {
        (a.year, a.month) < (b.year, b.month)
    }

    public init(from decoder: any Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let value = YearMonth(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Monat als JJJJ-MM erwartet"))
        }
        self = value
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(description)
    }
}

/// Deutsche Datumstexte, von Hand, damit sie überall gleich aussehen.
public enum GermanDates {
    public static let monthNames = [
        "Januar", "Februar", "März", "April", "Mai", "Juni",
        "Juli", "August", "September", "Oktober", "November", "Dezember",
    ]
    static let monthShort = ["Jan", "Feb", "März", "Apr", "Mai", "Juni", "Juli", "Aug", "Sept", "Okt", "Nov", "Dez"]
    static let weekdayShort = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]

    /// Buchungstag „2026-11-16“ → „Mo, 16. Nov“; mit `today` werden heute und gestern benannt.
    public static func bookingDay(_ iso: String, today: String? = nil) -> String {
        guard let date = parseISODate(iso) else { return iso }
        if let today {
            if iso == today { return "Heute" }
            if let t = parseISODate(today), let y = Calendar.gregorian(.utc).date(byAdding: .day, value: -1, to: t),
               isoDate(y, timeZone: .utc) == iso {
                return "Gestern"
            }
        }
        let c = Calendar.gregorian(.utc).dateComponents([.weekday, .day, .month], from: date)
        guard let wd = c.weekday, let d = c.day, let m = c.month else { return iso }
        return "\(weekdayShort[wd - 1]), \(d). \(monthShort[m - 1])"
    }

    /// „1. Nov“
    public static func dayAndMonth(_ iso: String) -> String {
        guard let date = parseISODate(iso) else { return iso }
        let c = Calendar.gregorian(.utc).dateComponents([.day, .month], from: date)
        guard let d = c.day, let m = c.month else { return iso }
        return "\(d). \(monthShort[m - 1])"
    }

    /// Kalendertag „JJJJ-MM-TT“ in der angegebenen Zeitzone.
    public static func isoDate(_ date: Date, timeZone: TimeZone = .berlin) -> String {
        let c = Calendar.gregorian(timeZone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    /// „JJJJ-MM-TT“ als Mitternacht UTC.
    public static func parseISODate(_ iso: String) -> Date? {
        let parts = iso.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        var c = DateComponents()
        c.year = y
        c.month = m
        c.day = d
        let cal = Calendar.gregorian(.utc)
        guard let date = cal.date(from: c) else { return nil }
        // Ungültige Tage wie 2026-02-31 nicht still verschieben.
        let back = cal.dateComponents([.year, .month, .day], from: date)
        guard back.year == y, back.month == m, back.day == d else { return nil }
        return date
    }
}

extension TimeZone {
    public static let berlin = TimeZone(identifier: "Europe/Berlin")!
    static let utc = TimeZone(identifier: "UTC")!
}

extension Calendar {
    static func gregorian(_ timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }
}
