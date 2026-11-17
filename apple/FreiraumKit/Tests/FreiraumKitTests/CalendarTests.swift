import Foundation
import Testing
@testable import FreiraumKit

@Suite struct CalendarTests {
    @Test func monatLesenUndSchreiben() throws {
        let m = try #require(YearMonth("2026-11"))
        #expect(m.description == "2026-11")
        #expect(m.title == "November 2026")
        #expect(m.next == YearMonth(year: 2026, month: 12))
        #expect(m.next.next == YearMonth(year: 2027, month: 1))
        #expect(YearMonth(year: 2027, month: 1).previous == YearMonth(year: 2026, month: 12))
        #expect(YearMonth("2026-13") == nil)
        #expect(YearMonth("26-11") == nil)
    }

    @Test func aktuellerMonatInBerlin() {
        // 31.10.2026, 23:30 UTC ist in Berlin schon der 1. November (Winterzeit, UTC+1).
        let date = Date(timeIntervalSince1970: 1_793_489_400)
        #expect(GermanDates.isoDate(date, timeZone: .init(identifier: "UTC")!) == "2026-10-31")
        #expect(YearMonth.current(date) == YearMonth(year: 2026, month: 11))
        #expect(GermanDates.isoDate(date) == "2026-11-01")
    }

    @Test func buchungstage() {
        #expect(GermanDates.bookingDay("2026-11-16") == "Mo, 16. Nov")
        #expect(GermanDates.bookingDay("2026-03-01") == "So, 1. März")
        #expect(GermanDates.bookingDay("2026-11-17", today: "2026-11-17") == "Heute")
        #expect(GermanDates.bookingDay("2026-11-16", today: "2026-11-17") == "Gestern")
        #expect(GermanDates.bookingDay("2026-11-15", today: "2026-11-17") == "So, 15. Nov")
        #expect(GermanDates.bookingDay("kein Datum") == "kein Datum")
        #expect(GermanDates.parseISODate("2026-02-31") == nil)
        #expect(GermanDates.dayAndMonth("2026-11-01") == "1. Nov")
    }
}
