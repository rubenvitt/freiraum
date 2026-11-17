import FreiraumKit
import SwiftUI

@main
struct FreiraumApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await model.load() }
            case .background:
                model.scheduleBackgroundRefresh()
            default:
                break
            }
        }
        #if os(iOS)
        .backgroundTask(.appRefresh(AppConfig.refreshTaskIdentifier)) {
            await model.backgroundRefresh()
        }
        #endif
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.isSignedIn {
            MainView()
        } else {
            LoginView()
        }
    }
}

/// Hauptansicht: Übersicht und Töpfe, „Barausgabe erfassen“ immer erreichbar.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var showCash = false

    var body: some View {
        TabView {
            Tab("Übersicht", systemImage: "house") {
                OverviewView()
            }
            Tab("Töpfe", systemImage: "square.grid.2x2") {
                PotsView()
            }
        }
        #if os(iOS)
        .tabViewBottomAccessory {
            Button {
                showCash = true
            } label: {
                Label("Barausgabe erfassen", systemImage: "plus")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .accessibilityHint("Öffnet die Eingabe für eine Barausgabe")
        }
        #else
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Barausgabe erfassen", systemImage: "plus") { showCash = true }
            }
        }
        #endif
        .sheet(isPresented: $showCash) {
            CashExpenseView()
        }
    }
}
