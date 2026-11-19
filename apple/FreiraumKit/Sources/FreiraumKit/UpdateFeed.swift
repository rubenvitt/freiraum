import Foundation

/// Entscheidet, ob die Feed-Adresse für Sparkle-Updates brauchbar ist.
/// Die Adresse kommt aus der Info.plist (`SUFeedURL = $(FREIRAUM_UPDATE_FEED)`); ohne Release-Build
/// bleibt sie leer oder als unaufgelöste Variable stehen – dann gibt es keine Update-Prüfung.
public enum UpdateFeed {
    /// `nil` bei `nil`, leer, nicht-https oder unaufgelöster Variable (`$(` am Anfang).
    public static func url(from raw: String?) -> URL? {
        guard let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty,
              !text.hasPrefix("$("),
              let url = URL(string: text),
              url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}
