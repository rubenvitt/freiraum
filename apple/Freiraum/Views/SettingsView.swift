import FreiraumKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Angemeldet") {
                    LabeledContent("Person", value: model.person?.displayName ?? "–")
                    LabeledContent("Server", value: model.service?.baseURL.host ?? "–")
                    if let last = model.lastLoaded {
                        LabeledContent("Zuletzt geladen", value: last.formatted(date: .omitted, time: .shortened))
                    }
                }
                Section {
                    Button("Benachrichtigungen erlauben") {
                        Task { await Notifications.requestPermission() }
                    }
                } footer: {
                    Text("Freiraum schaut im Hintergrund etwa stündlich nach neuen Buchungen und meldet sich, wenn welche warten. Wann genau, entscheidet iOS.")
                }
                Section {
                    Button("Abmelden", role: .destructive) {
                        Task {
                            await model.signOut()
                            dismiss()
                        }
                    }
                } footer: {
                    Text("Der Passkey bleibt erhalten; du kannst dich jederzeit wieder anmelden.")
                }
            }
            .navigationTitle("Einstellungen")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }
}
