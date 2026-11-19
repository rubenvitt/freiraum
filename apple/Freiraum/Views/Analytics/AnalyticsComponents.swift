import Charts
import FreiraumKit
import SwiftUI

// Bausteine der Auswertungen, gemeinsam für iPhone und Mac. Alle Zahlen und Texte kommen
// fertig aus FreiraumKit (`AnalyticsState`, `FlowList`); hier wird nur gezeichnet.

// MARK: - Kacheln

struct MetricTileView: View {
    let tile: MetricTile
    /// Zwei Kacheln nebeneinander am iPhone: kleinere Zahl, weniger Rand
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tile.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(tile.value)
                    .font(.system(size: compact ? 26 : 34, weight: .semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(Theme.text)
                if let unit = tile.unit {
                    Text(unit).font((compact ? Font.callout : .title3).weight(.medium)).foregroundStyle(Theme.secondary)
                }
            }
            Text(tile.detail)
                .font(.caption.weight(tile.tone == .neutral ? .regular : .semibold))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(compact ? 14 : 18)
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
struct SavingsRateChart: View {
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
struct LineTrendChart: View {
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

struct GoalRowView: View {
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

struct AssetRowView: View {
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

// MARK: - Auffälligkeiten

struct AnomalyRowView: View {
    let row: AnomalyRow

    var body: some View {
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

// MARK: - Geldfluss als Liste (iPhone)

/// Eine Seite des Geldflusses („Woher“ oder „Wohin“): Name, Betrag, Anteil als schmaler Balken.
struct FlowListSection: View {
    let title: String
    let total: String?
    let rows: [FlowList.Row]
    let householdKind: Household.Kind

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if let total {
                    Text(total).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.text)
                }
            }
            ForEach(rows) { FlowListRowView(row: $0, color: color(for: $0)) }
        }
    }

    /// Farben wie im Sankey am Mac: Erst ich Minze, Einzahlung Blau, „Übrig“ grau,
    /// Quellen in der Farbe des Haushalts, Erspartes orange.
    private func color(for row: FlowList.Row) -> Color {
        switch row.kind {
        case .quelle: row.fromSavings
            ? Theme.warning : (householdKind == .gemeinsam ? Theme.shared : Theme.personal)
        case .einzahlung: Theme.shared
        case .topf: row.potKind == .erstIch ? Theme.accent : Theme.text.opacity(0.7)
        case .rest: Theme.secondary
        case .haushalt: householdKind == .gemeinsam ? Theme.shared : Theme.personal
        case .gruppe: Theme.text.opacity(0.7)
        }
    }
}

struct FlowListRowView: View {
    let row: FlowList.Row
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.label).font(.callout).foregroundStyle(Theme.text).lineLimit(1)
                Spacer(minLength: 8)
                Text(row.amount).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Theme.text)
                Text(row.share)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.secondary)
                    .frame(minWidth: 44, alignment: .trailing)
            }
            GeometryReader { proxy in
                Capsule()
                    .fill(color)
                    .frame(width: max(4, proxy.size.width * row.fraction))
            }
            .frame(height: 5)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
    }
}
