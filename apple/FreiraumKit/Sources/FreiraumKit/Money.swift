/// Beträge sind immer ganze Cent (Int). Formatiert wird von Hand, damit die Darstellung auf
/// jedem Gerät und in den Tests gleich ist (deutsch: Tausenderpunkt, Dezimalkomma, echtes Minus).
public enum Money {
    /// Typografisches Minus (U+2212), wie im Design.
    public static let minus = "\u{2212}"

    public enum Style: Sendable {
        /// Ganze Euro ohne Nachkommastellen, sonst mit zwei: „215 €“, „34,18 €“
        case compact
        /// Immer zwei Nachkommastellen: „215,00 €“
        case exact
    }

    /// „−34,18 €“, „1.390 €“. Mit `sign: true` bekommen positive Beträge ein „+“.
    public static func format(_ cents: Int, style: Style = .compact, sign: Bool = false, currency: Bool = true) -> String {
        let magnitude = cents.magnitude
        let euros = magnitude / 100
        let rest = magnitude % 100
        var text = grouped(euros)
        if style == .exact || rest != 0 {
            text += "," + (rest < 10 ? "0" : "") + String(rest)
        }
        if cents < 0 {
            text = minus + text
        } else if sign && cents > 0 {
            text = "+" + text
        }
        return currency ? text + "\u{00A0}€" : text
    }

    /// Nur die Zahl ohne Währung, für große Anzeigen mit eigenem „€“.
    public static func number(_ cents: Int, style: Style = .compact) -> String {
        format(cents, style: style, currency: false)
    }

    private static func grouped(_ value: UInt) -> String {
        let digits = Array(String(value))
        var out = ""
        for (i, d) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(".") }
            out.append(d)
        }
        return out
    }

    /// Eingabe eines Betrags in Cent, z. B. „4,50“, „4.5“, „1.234,56“, „12 €“.
    /// Liefert nil bei leerer oder ungültiger Eingabe, negativen Werten oder mehr als zwei
    /// Nachkommastellen.
    public static func parse(_ input: String) -> Int? {
        var s = input.filter { !$0.isWhitespace && $0 != "€" && $0 != "\u{00A0}" }
        guard !s.isEmpty, !s.hasPrefix("-"), !s.hasPrefix(minus) else { return nil }
        if s.hasPrefix("+") { s.removeFirst() }

        let integerPart: Substring
        let fraction: Substring
        if let comma = s.lastIndex(of: ",") {
            // Komma = Dezimaltrenner, Punkte davor sind Tausenderpunkte.
            integerPart = s[..<comma]
            fraction = s[s.index(after: comma)...]
            guard !integerPart.contains(",") else { return nil }
        } else if let dot = s.lastIndex(of: "."), s.filter({ $0 == "." }).count == 1,
                  s.distance(from: dot, to: s.endIndex) - 1 <= 2 {
            // Ein Punkt mit höchstens zwei Ziffern danach = Dezimaltrenner („4.50“).
            integerPart = s[..<dot]
            fraction = s[s.index(after: dot)...]
        } else {
            integerPart = Substring(s)
            fraction = ""
        }

        let digitsOnly = String(integerPart.filter { $0 != "." })
        guard fraction.count <= 2,
              digitsOnly.allSatisfy(\.isASCIIDigit), fraction.allSatisfy(\.isASCIIDigit),
              !(digitsOnly.isEmpty && fraction.isEmpty),
              digitsOnly.count <= 9
        else { return nil }
        if integerPart.contains(".") {
            // Tausenderpunkte nur an der richtigen Stelle („1.234“, nicht „12.34.5“).
            let groups = integerPart.split(separator: ".", omittingEmptySubsequences: false)
            guard let first = groups.first, (1...3).contains(first.count),
                  groups.dropFirst().allSatisfy({ $0.count == 3 })
            else { return nil }
        }
        let euros = Int(digitsOnly.isEmpty ? "0" : digitsOnly) ?? 0
        let cents = fraction.isEmpty ? 0 : (Int(fraction) ?? 0) * (fraction.count == 1 ? 10 : 1)
        return euros * 100 + cents
    }
}

extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
