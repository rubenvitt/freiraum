#if os(macOS)
import Charts
import FreiraumKit
import SwiftUI

/// Auswertungen eines Haushalts nach dem Entwurf „Mac/Web Auswertung“: Kennzahlen, Geldfluss
/// als Sankey, Verlauf, Auffälligkeiten, Ziele und Besitzkosten. Alle Zahlen rechnet der Server.
struct AnalyticsView: View {
    @Environment(AppModel.self) private var model
    /// Geldfluss über die eigenen Haushalte statt nur des gewählten
    @AppStorage("flowAcrossHouseholds") private var acrossHouseholds = false

    /// Neu laden, sobald Haushalt, Monat oder Zeitraum wechseln.
    private var loadKey: String {
        "\(model.selectedHousehold?.id ?? "")|\(model.month)|\(model.analyticsPeriod.rawValue)"
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ZStack {
                GlowBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if let error = model.errorMessage {
                            ErrorBanner(message: error) { reload() }
                        }
                        if let household = model.selectedHousehold, let state = model.analytics[household.id] {
                            content(state, household: household)
                        } else if model.isLoadingAnalytics || model.isLoading {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 300)
                        } else {
                            ContentUnavailableView(
                                "Keine Auswertung", systemImage: "chart.bar.xaxis",
                                description: Text("Für diesen Haushalt ist noch nichts geladen.")
                            )
                        }
                    }
                    .padding(28)
                    .frame(maxWidth: 1400)
                    .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Auswertungen")
            .navigationSubtitle(model.month.title)
            .toolbar {
                ToolbarItem(placement: .navigation) { MacMonthStepper() }
                ToolbarItem(placement: .principal) { MacHouseholdPicker() }
                ToolbarItem(placement: .primaryAction) {
                    Picker("Zeitraum", selection: $model.analyticsPeriod) {
                        ForEach(AnalyticsPeriod.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
                ToolbarItem(placement: .primaryAction) {
                    if model.isLoadingAnalytics {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Aktualisieren", systemImage: "arrow.clockwise") { reload() }
                    }
                }
            }
        }
        .task(id: loadKey) { await load() }
    }

    private var across: Bool {
        acrossHouseholds && model.personFlow != nil
    }

    private func load() async {
        guard let id = model.selectedHousehold?.id else { return }
        await model.loadAnalytics(householdId: id)
    }

    private func reload() {
        Task { await load() }
    }

    @ViewBuilder
    private func content(_ state: AnalyticsState, household: Household) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(state.periodTitle) · \(household.shortLabel)")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.secondary)
            Text(household.kind == .gemeinsam ? "Woher kommt euer Geld, wohin fließt es?" : "Woher kommt dein Geld, wohin fließt es?")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(Theme.text)
        }

        LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 16)], spacing: 16) {
            ForEach(state.tiles) { MetricTileView(tile: $0) }
        }

        MacCard(title: "Geldfluss", trailing: across ? "Einkommen → Ich → Gemeinsam" : state.flowSummary) {
            if model.personFlow != nil {
                Picker("Geldfluss", selection: $acrossHouseholds) {
                    Text("Nur \(household.shortLabel)").tag(false)
                    Text("Über meine Haushalte").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            }
            if across, let flow = model.personFlow, !flow.links.isEmpty {
                SankeyView(
                    flow: flow, householdKind: household.kind,
                    kinds: Dictionary(model.households.map { ($0.id, $0.kind) }, uniquingKeysWith: { a, _ in a })
                )
                .frame(height: 520)
            } else if !across, let flow = model.flows[household.id], !flow.links.isEmpty {
                SankeyView(flow: flow, householdKind: household.kind)
                    .frame(height: 440)
            } else {
                Text("Im Zeitraum gibt es noch keine zugeordneten Buchungen.")
                    .foregroundStyle(Theme.secondary)
            }
            if let note = state.uncategorizedNote {
                Label(note, systemImage: "exclamationmark.circle")
                    .font(.callout)
                    .foregroundStyle(Theme.warning)
            }
        }

        LazyVGrid(columns: [GridItem(.adaptive(minimum: 340), spacing: 16, alignment: .top)], alignment: .leading, spacing: 16) {
            MacCard(title: "Sparquote im Verlauf", trailing: "bis zu 12 Monate") {
                SavingsRateChart(points: state.savingsRate)
            }
            MacCard(title: "Fixkosten am Einkommen") {
                LineTrendChart(points: state.fixedCostShare, unit: "%", color: Theme.shared)
            }
            MacCard(title: "Alter des Geldes", trailing: "Tage am Monatsende") {
                LineTrendChart(points: state.ageOfMoney, unit: "Tage", color: Theme.accent)
            }
            MacCard(title: "Auffällig im \(model.month.name)") {
                if state.anomalies.isEmpty {
                    Text("Nichts Auffälliges.").foregroundStyle(Theme.secondary)
                }
                ForEach(state.anomalies) { AnomalyRowView(row: $0) }
            }
            MacCard(title: "Ziele") {
                if state.goals.isEmpty {
                    Text("Noch keine Ziel-Töpfe.").foregroundStyle(Theme.secondary)
                }
                ForEach(state.goals) { GoalRowView(row: $0, color: Theme.goalColor(for: household.kind)) }
            }
            MacCard(title: "Besitzkosten", trailing: state.periodTitle) {
                if state.assets.isEmpty {
                    Text("Noch kein Besitz angelegt. Ein Besitz bündelt die Töpfe seiner laufenden Kosten.")
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let summary = state.assetSummary {
                    Text(summary).font(.callout).foregroundStyle(Theme.secondary)
                }
                ForEach(state.assets) { AssetRowView(row: $0) }
            }
        }
    }
}
#endif
