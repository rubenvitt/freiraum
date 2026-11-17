#if os(macOS)
import AppKit
import FreiraumKit
import SwiftUI

/// Beschriftung in der Menüleiste: Symbol und „Noch ohne Aufgabe“ des privaten Haushalts.
struct MenuBarLabel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let state = model.menuBar
        HStack(spacing: 4) {
            Image(systemName: state.pendingCount > 0 ? "eurosign.circle.fill" : "eurosign.circle")
            Text(model.isSignedIn ? state.label : "Freiraum")
                .monospacedDigit()
        }
        .accessibilityLabel(model.isSignedIn ? "Freiraum: \(state.readyToAssign) noch ohne Aufgabe" : "Freiraum")
    }
}

/// Fenster der Menüleiste: „Noch ohne Aufgabe“, wartende Buchungen, nächste Auffälligkeit.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let state = model.menuBar
        VStack(alignment: .leading, spacing: 14) {
            if model.isSignedIn {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Noch ohne Aufgabe · \(state.householdLabel) · \(YearMonth.current().name)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.secondary)
                    Text(state.readyToAssign)
                        .font(.system(size: 32, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(state.readyToAssignCents < 0 ? Theme.warning : Theme.text)
                }
                .accessibilityElement(children: .combine)

                Divider()

                Button {
                    open(section: .uebersicht)
                } label: {
                    Label(state.pending ?? "Keine Buchung wartet", systemImage: "tray.full")
                        .foregroundStyle(state.pendingCount > 0 ? Theme.warning : Theme.secondary)
                }
                .buttonStyle(.plain)
                .help("Öffnet die Übersicht zum Bestätigen")

                if let anomaly = state.nextAnomaly {
                    Button {
                        open(section: .auswertungen)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label("Auffällig", systemImage: "exclamationmark.circle")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.warning)
                            Text(anomaly)
                                .foregroundStyle(Theme.text)
                                .fixedSize(horizontal: false, vertical: true)
                            if let more = state.moreAnomalies {
                                Text(more).font(.caption).foregroundStyle(Theme.secondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text("Nicht angemeldet").font(.headline)
                Text("Melde dich im Fenster mit deinem Passkey an.")
                    .font(.callout)
                    .foregroundStyle(Theme.secondary)
            }

            Divider()

            HStack {
                Button("Freiraum öffnen") { open(section: nil) }
                Spacer()
                if model.isSignedIn {
                    Button("Aktualisieren", systemImage: "arrow.clockwise") {
                        Task { await model.load() }
                    }
                    .labelStyle(.iconOnly)
                    .disabled(model.isLoading)
                }
                Button("Beenden", systemImage: "power") { NSApplication.shared.terminate(nil) }
                    .labelStyle(.iconOnly)
            }
        }
        .padding(16)
        .frame(width: 300)
        .preferredColorScheme(.dark)
        .tint(Theme.accent)
    }

    private func open(section: MacSection?) {
        if let section { UserDefaults.standard.set(section.rawValue, forKey: "macSection") }
        openWindow(id: AppConfig.mainWindowId)
        NSApplication.shared.activate()
    }
}
#endif
