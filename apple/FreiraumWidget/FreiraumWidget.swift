import FreiraumKit
import SwiftUI
import WidgetKit

/// Widget „Freies Budget“: „Noch ohne Aufgabe“, frei in den Monatstöpfen, wartende Buchungen.
/// Liest nur den Schnappschuss, den die App in die App Group schreibt.
@main
struct FreiraumWidgetBundle: WidgetBundle {
    var body: some Widget {
        FreeBudgetWidget()
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
    private var store: SnapshotStore? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FreiraumAppGroup") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        else { return nil }
        return SnapshotStore(directory: directory)
    }

    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        let snapshot = context.isPreview ? (store?.load() ?? .placeholder) : store?.load()
        completion(SnapshotEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        // Die App lädt das Widget nach jedem Laden neu; zusätzlich stündlich prüfen, ob der
        // Schnappschuss zu einem vergangenen Monat gehört.
        let entry = SnapshotEntry(date: Date(), snapshot: store?.load())
        completion(Timeline(entries: [entry], policy: .after(Date(timeIntervalSinceNow: 60 * 60))))
    }
}

struct FreeBudgetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FreiesBudget", provider: SnapshotProvider()) { entry in
            FreeBudgetView(entry: entry)
                .containerBackground(for: .widget) {
                    Color(red: 0x0A / 255, green: 0x0C / 255, blue: 0x10 / 255)
                }
        }
        .configurationDisplayName("Freies Budget")
        .description("Was noch ohne Aufgabe ist und was in den Töpfen frei ist.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

private enum WidgetColors {
    static let text = Color(red: 0xF2 / 255, green: 0xF4 / 255, blue: 0xF7 / 255)
    static let secondary = Color(red: 0x9A / 255, green: 0xA3 / 255, blue: 0xB2 / 255)
    static let accent = Color(red: 0x5E / 255, green: 0xE6 / 255, blue: 0xC8 / 255)
    static let warning = Color(red: 0xFF / 255, green: 0x9F / 255, blue: 0x5A / 255)
}

struct FreeBudgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snapshot = entry.snapshot, snapshot.month == YearMonth.current(entry.date) {
            switch family {
            case .accessoryInline:
                Text("\(Money.format(snapshot.readyToAssignCents)) ohne Aufgabe")
            case .accessoryRectangular:
                rectangular(snapshot)
            case .systemMedium:
                medium(snapshot)
            default:
                small(snapshot)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("Freiraum").font(.headline)
                Text("Öffne die App, um das Budget zu laden.")
                    .font(.caption)
                    .foregroundStyle(WidgetColors.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func small(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Noch ohne Aufgabe")
                .font(.caption.weight(.medium))
                .foregroundStyle(WidgetColors.secondary)
            Text(Money.format(s.readyToAssignCents))
                .font(.system(size: 30, weight: .semibold))
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .foregroundStyle(s.readyToAssignCents < 0 ? WidgetColors.warning : WidgetColors.text)
            Spacer(minLength: 0)
            Text("frei in Töpfen \(Money.format(s.freeInPotsCents))")
                .font(.caption2)
                .foregroundStyle(WidgetColors.secondary)
            if let pending = PendingText.title(s.pendingCount) {
                Label(pending, systemImage: "checklist")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WidgetColors.accent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ s: WidgetSnapshot) -> some View {
        HStack(alignment: .top, spacing: 16) {
            small(s)
            VStack(alignment: .leading, spacing: 6) {
                Text("Knapp")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(WidgetColors.secondary)
                ForEach(s.tightestPots, id: \.name) { pot in
                    HStack {
                        Text(pot.name).lineLimit(1)
                        Spacer()
                        Text(Money.format(pot.availableCents))
                            .monospacedDigit()
                            .foregroundStyle(pot.availableCents < 0 ? WidgetColors.warning : WidgetColors.text)
                    }
                    .font(.caption)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func rectangular(_ s: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Ohne Aufgabe").font(.caption2)
            Text(Money.format(s.readyToAssignCents)).font(.headline).monospacedDigit()
            if let pending = PendingText.title(s.pendingCount) {
                Text(pending).font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview(as: .systemMedium) {
    FreeBudgetWidget()
} timeline: {
    SnapshotEntry(date: Date(timeIntervalSince1970: 1_794_900_000), snapshot: .placeholder)
}
