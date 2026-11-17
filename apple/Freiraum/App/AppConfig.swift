import Foundation

/// Werte aus der Info.plist (kommen aus Config/*.xcconfig).
enum AppConfig {
    /// Domain des Backends aus dem Build, z. B. „freiraum.example.org“. Leer oder Beispiel = keine Vorgabe.
    static var defaultDomain: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "FreiraumDomain") as? String,
              !value.isEmpty, value != "freiraum.example.org"
        else { return nil }
        return value
    }

    /// App Group für den Austausch mit dem Widget.
    static var appGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "FreiraumAppGroup") as? String
    }

    /// Ordner, den App und Widget teilen; ohne App Group (z. B. macOS) der eigene Support-Ordner.
    static var sharedDirectory: URL {
        if let group = appGroup,
           let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            return url
        }
        return URL.applicationSupportDirectory.appending(path: "Freiraum", directoryHint: .isDirectory)
    }

    /// Hauptfenster am Mac (die Menüleiste öffnet es wieder, wenn es geschlossen ist).
    static let mainWindowId = "main"

    static var refreshTaskIdentifier: String {
        (Bundle.main.bundleIdentifier ?? "freiraum") + ".refresh"
    }

    /// „freiraum.example.org“ oder „https://freiraum.example.org/“ → https-URL ohne Pfad.
    static func serverURL(from input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text),
              components.scheme == "https", let host = components.host, !host.isEmpty
        else { return nil }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }
}
