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
                ForEach(state.anomalies) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: row.systemImage)
                            .foregroundStyle(Theme.warning)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.badge).font(.caption.weight(.semibold)).foregroundStyle(Theme.warning)
                            Text(row.title).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            MacCard(title: "Ziele") {
                if state.goals.isEmpty {
                    Text("Noch keine Ziel-Töpfe.").foregroundStyle(Theme.secondary)
                }
                ForEach(state.goals) { GoalRowView(row: $0, color: household.kind == .gemeinsam ? Theme.shared : Theme.accent) }
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

// MARK: - Kacheln

private struct MetricTileView: View {
    let tile: MetricTile

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tile.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(tile.value)
                    .font(.system(size: 34, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.text)
                if let unit = tile.unit {
                    Text(unit).font(.title3.weight(.medium)).foregroundStyle(Theme.secondary)
                }
            }
            Text(tile.detail)
                .font(.caption.weight(tile.tone == .neutral ? .regular : .semibold))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch tile.tone {
        case .neutral: Theme.secondary
        case .good: Theme.accent
        case .warning: Theme.warning
        }
    }
}

// MARK: - Diagramme

/// Sparquote je Monat als Balken; der letzte Monat hervorgehoben, negative Monate orange.
private struct SavingsRateChart: View {
    let points: [TrendPoint]

    var body: some View {
        if points.allSatisfy({ $0.value == nil }) {
            Text("Noch kein Monat mit Einkommen.").foregroundStyle(Theme.secondary)
        } else {
            Chart(points) { p in
                if let value = p.value {
                    BarMark(x: .value("Monat", p.label), y: .value("Sparquote", value))
                        .foregroundStyle(color(p, value))
                        .cornerRadius(6)
                        .annotation(position: value >= 0 ? .top : .bottom) {
                            Text(p.text).font(.caption2.weight(.semibold)).foregroundStyle(Theme.secondary)
                        }
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine().foregroundStyle(.white.opacity(0.08))
                    AxisValueLabel { if let v = value.as(Double.self) { Text("\(Int(v)) %") } }
                }
            }
            .frame(height: 180)
            .accessibilityLabel("Sparquote je Monat")
            .accessibilityValue(points.map { "\($0.label) \($0.text)" }.joined(separator: ", "))
        }
    }

    private func color(_ p: TrendPoint, _ value: Double) -> Color {
        if value < 0 { return Theme.warning }
        return p.isCurrent ? Theme.accent : Theme.accent.opacity(0.45)
    }
}

/// Verlauf als Linie mit Punkten; Monate ohne Wert bleiben Lücken.
private struct LineTrendChart: View {
    let points: [TrendPoint]
    let unit: String
    let color: Color

    var body: some View {
        if points.allSatisfy({ $0.value == nil }) {
            Text("Noch keine Werte.").foregroundStyle(Theme.secondary)
        } else {
            Chart(points) { p in
                if let value = p.value {
                    LineMark(x: .value("Monat", p.label), y: .value(unit, value))
                        .foregroundStyle(color)
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("Monat", p.label), y: .value(unit, value))
                        .foregroundStyle(p.isCurrent ? color : color.opacity(0.6))
                        .symbolSize(p.isCurrent ? 60 : 30)
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine().foregroundStyle(.white.opacity(0.08))
                    AxisValueLabel { if let v = value.as(Double.self) { Text("\(Int(v)) \(unit)") } }
                }
            }
            .frame(height: 180)
            .accessibilityValue(points.map { "\($0.label) \($0.text)" }.joined(separator: ", "))
        }
    }
}

// MARK: - Ziele und Besitz

private struct GoalRowView: View {
    let row: GoalRow
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.name).font(.callout.weight(.semibold)).foregroundStyle(Theme.text)
                Spacer()
                Text(row.amount).font(.callout).monospacedDigit().foregroundStyle(Theme.secondary)
            }
            ProgressView(value: row.progress)
                .tint(row.onTrack ? color : Theme.warning)
            Text(row.detail)
                .font(.caption)
                .foregroundStyle(row.onTrack ? Theme.secondary : Theme.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AssetRowView: View {
    let row: AssetRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.name).font(.callout.weight(.semibold)).foregroundStyle(Theme.text)
                Text(row.classification)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .foregroundStyle(row.isLiability ? Theme.warning : Theme.accent)
                    .background((row.isLiability ? Theme.warning : Theme.accent).opacity(0.14), in: .capsule)
                Spacer()
                Text(row.cost).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.text)
            }
            Text(row.detail).font(.caption).foregroundStyle(Theme.secondary)
            if let note = row.valueNote {
                Text(note).font(.caption).foregroundStyle(Theme.secondary)
            }
            if !row.pots.isEmpty {
                Text(row.pots.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
#endif
