#if os(macOS)
import FreiraumKit
import SwiftUI

/// Bereiche der Mac-App in der Seitenleiste.
enum MacSection: String, CaseIterable, Identifiable, Hashable {
    case uebersicht, planung, auswertungen, toepfe

    var id: String { rawValue }

    var title: String {
        switch self {
        case .uebersicht: "Übersicht"
        case .planung: "Planung"
        case .auswertungen: "Auswertungen"
        case .toepfe: "Töpfe"
        }
    }

    var systemImage: String {
        switch self {
        case .uebersicht: "house"
        case .planung: "square.grid.2x2"
        case .auswertungen: "chart.bar.xaxis"
        case .toepfe: "tray.2"
        }
    }
}

/// Hauptfenster am Mac: Seitenleiste mit Übersicht, Planung, Auswertungen und Töpfen.
/// Übersicht und Töpfe sind dieselben Ansichten wie am iPhone.
struct MacMainView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("macSection") private var stored = MacSection.planung.rawValue
    @State private var showCash = false

    private var selection: Binding<MacSection?> {
        Binding(
            get: { MacSection(rawValue: stored) ?? .planung },
            set: { stored = ($0 ?? .planung).rawValue }
        )
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(MacSection.allCases) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
            .safeAreaInset(edge: .bottom) { SidebarStatus() }
        } detail: {
            switch selection.wrappedValue ?? .planung {
            case .uebersicht: OverviewView()
            case .planung: PlanningView()
            case .auswertungen: AnalyticsView()
            case .toepfe: PotsView()
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Barausgabe erfassen", systemImage: "plus") { showCash = true }
            }
        }
        .sheet(isPresented: $showCash) {
            CashExpenseView()
        }
        .frame(minWidth: 960, minHeight: 640)
    }
}

/// Unten in der Seitenleiste: wartende Buchungen und wann zuletzt geladen wurde.
private struct SidebarStatus: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle()
                    .fill(model.pending.isEmpty ? Theme.accent : Theme.warning)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(PendingText.title(model.pending.count) ?? "Alles bestätigt")
                    .font(.callout.weight(.semibold))
            }
            if let last = model.lastLoaded {
                Text("Geladen \(last.formatted(date: .omitted, time: .shortened)) Uhr")
                    .font(.caption)
                    .foregroundStyle(Theme.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.white.opacity(0.04), in: .rect(cornerRadius: 14))
        .padding(12)
        .accessibilityElement(children: .combine)
    }
}

/// Haushalt wählen (Ich / Gemeinsam) für Planung und Auswertungen, in der Werkzeugleiste.
struct MacHouseholdPicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if model.households.count > 1 {
            Picker("Haushalt", selection: $model.selectedHouseholdId) {
                ForEach(model.households) { household in
                    Text(household.shortLabel).tag(Optional(household.id))
                }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        }
    }
}

/// Monat vor und zurück, in der Werkzeugleiste.
struct MacMonthStepper: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ControlGroup {
            Button("Vormonat", systemImage: "chevron.left") {
                Task { await model.show(month: model.month.previous) }
            }
            .disabled(model.month <= model.budgetStartMonth)
            Button("Aktueller Monat", systemImage: "calendar") {
                Task { await model.show(month: .current()) }
            }
            .disabled(model.month == .current())
            Button("Nächster Monat", systemImage: "chevron.right") {
                Task { await model.show(month: model.month.next) }
            }
        }
        .help("Monat wählen")
    }
}

/// Karte im Stil des Entwurfs (dunkles Glas) für die Mac-Ansichten.
struct MacCard<Content: View>: View {
    var title: String?
    var trailing: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title {
                HStack(alignment: .firstTextBaseline) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    if let trailing {
                        Text(trailing).font(.caption).foregroundStyle(Theme.secondary)
                    }
                }
            }
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}
#endif
