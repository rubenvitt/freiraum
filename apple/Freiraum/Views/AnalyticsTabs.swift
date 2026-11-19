#if os(iOS)
import FreiraumKit
import SwiftUI

/// Reiter „Auswertung“ am iPhone: Kennzahlen, Geldfluss als Liste „woher/wohin“, kompakter
/// Verlauf, Auffälligkeiten und Besitzkosten. Alle Zahlen rechnet der Server, die Texte
/// FreiraumKit (`AnalyticsState`). Am Mac: `AnalyticsView`.
struct PhoneAnalyticsView: View {
    @Environment(AppModel.self) private var model
    @State private var trend: Trend = .sparquote

    /// Welcher Verlauf im Diagramm steht.
    enum Trend: String, CaseIterable, Identifiable {
        case sparquote, fixkosten, alter
        var id: String { rawValue }
        var title: String {
            switch self {
            case .sparquote: "Sparquote"
            case .fixkosten: "Fixkosten"
            case .alter: "Alter"
            }
        }
    }

    var body: some View {
        @Bindable var model = model
        AnalyticsScaffold(title: "Auswertung") { state, household in
            Picker("Zeitraum", selection: $model.analyticsPeriod) {
                ForEach(AnalyticsPeriod.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                ForEach(state.tiles) { MetricTileView(tile: $0, compact: true) }
            }

            PhoneCard(title: "Geldfluss", trailing: state.periodTitle) {
                if state.flowList.isEmpty {
                    Text("Im Zeitraum gibt es noch keine zugeordneten Buchungen.")
                        .foregroundStyle(Theme.secondary)
                } else {
                    Text(state.flowSummary).font(.footnote).foregroundStyle(Theme.secondary)
                    if !state.flowList.incoming.isEmpty {
                        FlowListSection(title: "Woher", total: state.flowList.incomingTotal,
                                        rows: state.flowList.incoming, householdKind: household.kind)
                    }
                    if !state.flowList.outgoing.isEmpty {
                        Divider().overlay(Theme.secondary.opacity(0.2))
                        FlowListSection(title: "Wohin", total: state.flowList.outgoingTotal,
                                        rows: state.flowList.outgoing, householdKind: household.kind)
                    }
                }
                if let note = state.uncategorizedNote {
                    Label(note, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(Theme.warning)
                }
            }

            PhoneCard(title: "Verlauf", trailing: "bis zu 12 Monate") {
                Picker("Verlauf", selection: $trend) {
                    ForEach(Trend.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                switch trend {
                case .sparquote:
                    SavingsRateChart(points: state.savingsRate)
                case .fixkosten:
                    LineTrendChart(points: state.fixedCostShare, unit: "%", color: Theme.shared)
                case .alter:
                    LineTrendChart(points: state.ageOfMoney, unit: "Tage", color: Theme.accent)
                }
            }

            PhoneCard(title: "Auffällig im \(model.month.name)") {
                if state.anomalies.isEmpty {
                    Text("Nichts Auffälliges.").foregroundStyle(Theme.secondary)
                }
                ForEach(state.anomalies) { AnomalyRowView(row: $0) }
            }

            if !state.assets.isEmpty {
                PhoneCard(title: "Besitzkosten", trailing: state.periodTitle) {
                    if let summary = state.assetSummary {
                        Text(summary).font(.footnote).foregroundStyle(Theme.secondary)
                    }
                    ForEach(state.assets) { AssetRowView(row: $0) }
                }
            }
        }
    }
}

/// Reiter „Ziele“ am iPhone: Ziel-Töpfe des gewählten Haushalts mit Prognose (`GoalRow`).
struct GoalsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        AnalyticsScaffold(title: "Ziele") { state, household in
            if state.goals.isEmpty {
                ContentUnavailableView(
                    "Noch keine Ziele", systemImage: "flag",
                    description: Text("Ein Topf der Art „Ziel“ mit Betrag und Zielmonat erscheint hier mit Prognose.")
                )
            } else {
                ForEach(state.goals) { goal in
                    GlassCard {
                        GoalRowView(row: goal, color: Theme.goalColor(for: household.kind))
                    }
                }
            }
        }
    }
}

// MARK: - Gerüst

/// Gemeinsames Gerüst beider Reiter: Kopf mit Monat, Haushalt-Umschalter, Laden je Haushalt,
/// Monat und Zeitraum, Fehlerband und Ziehen zum Aktualisieren.
private struct AnalyticsScaffold<Content: View>: View {
    @Environment(AppModel.self) private var model
    let title: String
    @ViewBuilder let content: (AnalyticsState, Household) -> Content

    /// Neu laden, sobald Haushalt, Monat oder Zeitraum wechseln.
    private var loadKey: String {
        "\(model.selectedHousehold?.id ?? "")|\(model.month)|\(model.analyticsPeriod.rawValue)"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                GlowBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        HouseholdPicker()
                        if let message = model.errorMessage {
                            ErrorBanner(message: message) { Task { await load() } }
                        }
                        if let household = model.selectedHousehold, let state = model.analytics[household.id] {
                            content(state, household)
                        } else if model.isLoadingAnalytics || model.isLoading {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                        } else {
                            ContentUnavailableView(
                                "Keine Auswertung", systemImage: "chart.bar.xaxis",
                                description: Text("Für diesen Haushalt ist noch nichts geladen.")
                            )
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await load() }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .task(id: loadKey) { await load() }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.analytics[model.selectedHousehold?.id ?? ""]?.periodTitle ?? model.month.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.secondary)
                Text(title)
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
            }
            Spacer()
            if model.isLoadingAnalytics {
                ProgressView()
            }
            MonthMenu()
        }
        .padding(.top, 8)
    }

    private func load() async {
        guard let id = model.selectedHousehold?.id else { return }
        await model.loadAnalytics(householdId: id)
    }
}

/// Karte mit Überschrift für den schmalen Bildschirm.
private struct PhoneCard<Content: View>: View {
    var title: String
    var trailing: String?
    @ViewBuilder var content: Content

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
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
                content
            }
        }
    }
}
#endif
