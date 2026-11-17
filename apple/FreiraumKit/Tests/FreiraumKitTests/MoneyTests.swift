import Testing
@testable import FreiraumKit

@Suite struct MoneyTests {
    @Test func formatiertKompaktUndExakt() {
        #expect(Money.format(21_500) == "215\u{00A0}€")
        #expect(Money.format(-3_418) == "\u{2212}34,18\u{00A0}€")
        #expect(Money.format(139_000) == "1.390\u{00A0}€")
        #expect(Money.format(123_456_789) == "1.234.567,89\u{00A0}€")
        #expect(Money.format(5) == "0,05\u{00A0}€")
        #expect(Money.format(0) == "0\u{00A0}€")
        #expect(Money.format(21_500, style: .exact) == "215,00\u{00A0}€")
        #expect(Money.format(1_000, sign: true) == "+10\u{00A0}€")
        #expect(Money.number(-99_900) == "\u{2212}999")
    }

    @Test(arguments: [
        ("4,50", 450), ("4,5", 450), ("4.50", 450), ("4", 400), ("1.234,56", 123_456),
        ("1.234", 123_400), (" 12 € ", 1_200), (",99", 99), ("0,01", 1), ("+3", 300),
        ("1234567", 123_456_700),
    ])
    func liestGueltigeBetraege(input: String, cents: Int) {
        #expect(Money.parse(input) == cents)
    }

    @Test(arguments: ["", "abc", "-4", "\u{2212}4", "4,567", "1,2,3", "12.34.5", "1.23.456", "€", "1234567890"])
    func lehntUngueltigeBetraegeAb(input: String) {
        #expect(Money.parse(input) == nil)
    }
}
