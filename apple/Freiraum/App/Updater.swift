#if os(macOS) && canImport(Sparkle)
import Combine
import Foundation
import FreiraumKit
import Observation
import Sparkle

/// Automatische Updates der Mac-App über Sparkle.
///
/// Sparkle startet nur, wenn die Info.plist eine brauchbare Feed-Adresse hat (`SUFeedURL`, im
/// Release-Build aus `FREIRAUM_UPDATE_FEED`). In Entwicklungs- und CI-Builds bleibt sie leer:
/// Dann gibt es keinen Updater, und die Menüeinträge „Nach Updates suchen …“ fehlen.
@MainActor @Observable
final class Updater {
    static let shared = Updater()

    /// `true`, wenn ein Feed eingetragen ist und Sparkle läuft.
    var isAvailable: Bool { controller != nil }

    /// Ob gerade eine Prüfung gestartet werden kann (aus `SPUUpdater.canCheckForUpdates`;
    /// `false`, solange eine Prüfung oder Installation läuft).
    private(set) var canCheck = false

    private let controller: SPUStandardUpdaterController?
    @ObservationIgnored private var observation: AnyCancellable?

    private init() {
        let raw = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String
        guard UpdateFeed.url(from: raw) != nil else {
            controller = nil
            return
        }
        let controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        self.controller = controller
        // KVO meldet den Startwert sofort und danach jede Änderung; Sparkle arbeitet auf dem
        // Hauptthread, `receive(on:)` sichert das für die Zuweisung trotzdem ab.
        observation = controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in
                MainActor.assumeIsolated {
                    self?.canCheck = value
                }
            }
    }

    /// Prüft sofort und zeigt Sparkles Dialog (auch „Kein Update verfügbar“).
    func checkForUpdates() {
        controller?.updater.checkForUpdates()
    }
}
#endif
