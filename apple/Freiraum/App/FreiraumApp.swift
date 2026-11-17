import FreiraumKit
import SwiftUI

@main
struct FreiraumApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        #if os(macOS)
        // Am Mac ein Hauptfenster und die Menüleiste. Ohne Fenster läuft die App in der
        // Menüleiste weiter und lädt regelmäßig neu (AppModel.startPeriodicRefresh).
        Window("Freiraum", id: AppConfig.mainWindowId) {
            root
        }
        .defaultSize(width: 1280, height: 860)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.load() } }
        }

        MenuBarExtra {
            MenuBarContent()
                .environment(model)
        } label: {
            MenuBarLabel()
                .environment(model)
        }
        .menuBarExtraStyle(.window)
        #else
        WindowGroup {
            root
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
        .backgroundTask(.appRefresh(AppConfig.refreshTaskIdentifier)) {
            await model.backgroundRefresh()
        }
        #endif
    }

    private var root: some View {
        RootView()
            .environment(model)
            .preferredColorScheme(.dark)
            .tint(Theme.accent)
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.isSignedIn {
            #if os(macOS)
            MacMainView()
            #else
            MainView()
            #endif
        } else {
            LoginView()
        }
    }
}

#if os(iOS)
/// Hauptansicht am iPhone: Übersicht und Töpfe, „Barausgabe erfassen“ immer erreichbar.
/// Am Mac: `MacMainView`.
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
        .sheet(isPresented: $showCash) {
            CashExpenseView()
        }
    }
}
#endif
