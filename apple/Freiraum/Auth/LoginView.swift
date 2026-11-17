import SwiftUI

/// Anmelden mit Passkey oder Einladung einlösen. Es gibt kein Sign-up: Einladungen entstehen
/// auf dem Server (`cli person-anlegen`, `cli einladen`).
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var passkeys = PasskeyController()
    @State private var invitation = ""
    @State private var showInvitation = false
    @State private var busy = false

    var body: some View {
        @Bindable var model = model
        ZStack {
            GlowBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Freiraum")
                            .font(.system(size: 40, weight: .bold))
                            .foregroundStyle(Theme.text)
                        Text("Jeder Euro bekommt eine Aufgabe.")
                            .font(.title3)
                            .foregroundStyle(Theme.secondary)
                    }
                    .padding(.top, 60)

                    GlassCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Server")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.secondary)
                            TextField("freiraum.example.org", text: $model.serverText)
                                .autocorrectionDisabled()
                                #if os(iOS)
                                .textContentType(.URL)
                                .keyboardType(.URL)
                                .textInputAutocapitalization(.never)
                                #endif
                                .font(.body)
                        }
                    }

                    Button {
                        Task {
                            busy = true
                            await model.signIn(using: passkeys)
                            busy = false
                        }
                    } label: {
                        Label("Mit Passkey anmelden", systemImage: "person.badge.key")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(busy)

                    DisclosureGroup("Einladung einlösen", isExpanded: $showInvitation) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Für das erste Gerät, ein weiteres Gerät oder nach Verlust: Token aus der Einladung einfügen, dann legt die App einen Passkey an.")
                                .font(.footnote)
                                .foregroundStyle(Theme.secondary)
                            TextField("Einladungs-Token", text: $invitation)
                                .autocorrectionDisabled()
                                #if os(iOS)
                                .textInputAutocapitalization(.never)
                                #endif
                                .textFieldStyle(.roundedBorder)
                            Button {
                                Task {
                                    busy = true
                                    await model.register(invitationToken: invitation, using: passkeys)
                                    busy = false
                                }
                            } label: {
                                Text("Passkey anlegen")
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(.glass)
                            .disabled(busy || invitation.isEmpty)
                        }
                        .padding(.top, 8)
                    }
                    .foregroundStyle(Theme.text)

                    if busy {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if let message = model.errorMessage {
                        ErrorBanner(message: message)
                    }
                }
                .padding(.horizontal, 20)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
        }
    }
}
