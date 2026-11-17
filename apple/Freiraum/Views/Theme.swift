import FreiraumKit
import SwiftUI

/// Buchung aus FreiraumKit; überdeckt `SwiftUI.Transaction` in der ganzen App.
typealias Transaction = FreiraumKit.Transaction

/// Farben aus dem Design-Entwurf. Farbe nur mit Bedeutung: Minze = gut/Aktion,
/// Orange = knapp/überzogen/Hinweis, Blau = gemeinsam, Violett = privat.
enum Theme {
    static let background = Color(red: 0x0A / 255, green: 0x0C / 255, blue: 0x10 / 255)
    static let text = Color(red: 0xF2 / 255, green: 0xF4 / 255, blue: 0xF7 / 255)
    static let secondary = Color(red: 0x9A / 255, green: 0xA3 / 255, blue: 0xB2 / 255)
    static let accent = Color(red: 0x5E / 255, green: 0xE6 / 255, blue: 0xC8 / 255)
    static let onAccent = Color(red: 0x06 / 255, green: 0x23 / 255, blue: 0x1D / 255)
    static let warning = Color(red: 0xFF / 255, green: 0x9F / 255, blue: 0x5A / 255)
    static let shared = Color(red: 0xA9 / 255, green: 0xBC / 255, blue: 0xFF / 255)
    static let personal = Color(red: 0xD6 / 255, green: 0xCB / 255, blue: 0xFF / 255)
    static let glowBlue = Color(red: 0x1B / 255, green: 0x3A / 255, blue: 0x5C / 255)
    static let glowGreen = Color(red: 0x14 / 255, green: 0x46 / 255, blue: 0x3F / 255)

    static func color(for tone: OverviewState.Tone) -> Color {
        switch tone {
        case .ok: accent
        case .low, .overspent: warning
        }
    }
}

/// Hintergrund mit zwei weichen Lichtflecken wie im Entwurf.
struct GlowBackground: View {
    var body: some View {
        ZStack {
            Theme.background
            Circle().fill(Theme.glowBlue).frame(width: 320, height: 320).blur(radius: 90).opacity(0.7)
                .offset(x: 140, y: -320)
            Circle().fill(Theme.glowGreen).frame(width: 260, height: 260).blur(radius: 90).opacity(0.55)
                .offset(x: -160, y: 60)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// Glas-Karte mit abgerundeten Ecken (Liquid Glass).
struct GlassCard<Content: View>: View {
    var cornerRadius: CGFloat = 22
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }
}

/// Kleine Kapsel für Topf und Haushalt.
struct Chip: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 14)
            .frame(minHeight: 34)
            .background(color.opacity(0.16), in: .capsule)
    }
}

/// Fehlermeldung als schmales Band.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Theme.warning)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote)
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Erneut", action: retry)
                    .font(.footnote.weight(.semibold))
            }
        }
        .padding(12)
        .background(Theme.warning.opacity(0.12), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.warning.opacity(0.3)))
    }
}
