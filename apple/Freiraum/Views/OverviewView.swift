import FreiraumKit
import SwiftUI

/// Übersicht eines Haushalts: „Noch ohne Aufgabe“, wartende Buchungen, Erst ich, Töpfe.
struct OverviewView: View {
    @Environment(AppModel.self) private var model
    @State private var showConfirm = false
    @State private var showDistribute = false
    @State private var showSettings = false
    @State private var showCash = false
    @State private var contributionsOf: Household?

    var body: some View {
        NavigationStack {
            ZStack {
                GlowBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        header
                        HouseholdPicker()
                        if let message = model.errorMessage {
                            ErrorBanner(message: message) { Task { await model.load() } }
                        }
                        if let household = model.selectedHousehold, let state = model.overview(for: household) {
                            content(state)
                        } else if model.isLoading {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await model.load() }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Einstellungen", systemImage: "gearshape") { showSettings = true }
                }
            }
            #if os(iOS)
            .toolbarBackground(.hidden, for: .navigationBar)
            #endif
        }
        .sheet(isPresented: $showConfirm) { ConfirmView() }
        .sheet(isPresented: $showDistribute) { DistributeView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showCash) { CashExpenseView() }
        .sheet(item: $contributionsOf) { household in ContributionsView(household: household) }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.month.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.secondary)
                Text("Freiraum")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(Theme.text)
            }
            Spacer()
            MonthMenu()
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private func content(_ state: OverviewState) -> some View {
        ReadyToAssignHero(state: state) { showDistribute = true }

        if let title = PendingText.title(state.pendingCount) {
            Button { showConfirm = true } label: {
                PendingCard(title: title, subtitle: pendingSubtitle)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet „Buchungen bestätigen“")
        }

        if let cashHint = state.cashHint {
            Button { showCash = true } label: {
                PendingCard(
                    title: cashHint, subtitle: "Ausgaben daraus mit dem Plus erfassen",
                    systemImage: "banknote", color: Theme.warning
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet „Barausgabe erfassen“")
        }

        if let household = model.selectedHousehold, let contributions = model.contributionsState(for: household) {
            ContributionsCard(state: contributions) { contributionsOf = household }
        }

        if !state.erstIch.isEmpty {
            ErstIchCard(rows: state.erstIch, done: state.erstIchDone)
        }

        if !state.pots.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Töpfe").font(.headline).foregroundStyle(Theme.text)
                    Spacer()
                    Text("noch verfügbar").font(.footnote).foregroundStyle(Theme.secondary)
                }
                .padding(.horizontal, 4)
                ForEach(state.pots) { row in
                    PotRowView(row: row)
                }
            }
        }

        if state.closed {
            Label("Dieser Monat ist abgeschlossen.", systemImage: "lock")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
        }
    }

    private var pendingSubtitle: String {
        let household = model.selectedHousehold?.id
        let items = model.pending.filter { model.household(of: $0)?.id == household }
        return PendingText.subtitle(items.count, withSuggestions: items.filter { $0.suggestion != nil }.count)
    }
}

/// Umschalter „Ich / Gemeinsam“, nur wenn es mehr als einen Haushalt gibt.
struct HouseholdPicker: View {
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
        }
    }
}

/// Monat wechseln.
struct MonthMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            if model.month > model.budgetStartMonth {
                Button("Vormonat (\(model.month.previous.title))") { Task { await model.show(month: model.month.previous) } }
            }
            if model.month != .current() {
                Button("Aktueller Monat") { Task { await model.show(month: .current()) } }
            }
            Button("Nächster Monat (\(model.month.next.title))") { Task { await model.show(month: model.month.next) } }
        } label: {
            Image(systemName: "calendar")
                .font(.title3)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .accessibilityLabel("Monat wählen")
    }
}

/// „Noch ohne Aufgabe“ groß, darunter „Verteilen“.
struct ReadyToAssignHero: View {
    let state: OverviewState
    let distribute: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Noch ohne Aufgabe")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(state.readyToAssign)
                    .font(.system(size: 64, weight: .semibold))
                    .monospacedDigit()
                    .kerning(-2.5)
                    .foregroundStyle(state.readyToAssignCents < 0 ? Theme.warning : Theme.text)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Text("€")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(Theme.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Noch ohne Aufgabe: \(Money.format(state.readyToAssignCents))")

            HStack(spacing: 12) {
                if !state.closed && (state.readyToAssignCents > 0 || state.neededCents > 0) {
                    Button("Verteilen", action: distribute)
                        .font(.body.weight(.semibold))
                        .buttonStyle(.glassProminent)
                        .controlSize(.large)
                }
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 10)
        }
        .padding(.top, 8)
    }

    private var hint: String {
        if state.readyToAssignCents < 0 {
            return "Mehr verteilt als da ist. Nimm in einem Topf etwas zurück."
        }
        if state.readyToAssignCents == 0 {
            return "Jeder Euro hat eine Aufgabe."
        }
        return "Gib jedem Euro eine Aufgabe, bevor der Monat es tut."
    }
}

struct PendingCard: View {
    let title: String
    let subtitle: String
    var systemImage = "checklist"
    var color = Theme.accent

    var body: some View {
        GlassCard {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .foregroundStyle(color)
                    .frame(width: 44, height: 44)
                    .background(color.opacity(0.14), in: .rect(cornerRadius: 14))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline).foregroundStyle(Theme.text)
                    Text(subtitle).font(.footnote).foregroundStyle(Theme.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(Theme.secondary)
                    .accessibilityHidden(true)
            }
        }
    }
}

struct ErstIchCard: View {
    let rows: [OverviewState.ErstIchRow]
    let done: Bool

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Erst ich bezahlen").font(.headline).foregroundStyle(Theme.text)
                    Spacer()
                    Text(done ? "Erledigt" : "Offen")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(done ? Theme.accent : Theme.warning)
                }
                ForEach(rows) { row in
                    HStack {
                        Image(systemName: row.done ? "checkmark.circle" : "circle.dashed")
                            .foregroundStyle(row.done ? Theme.accent : Theme.secondary)
                            .accessibilityLabel(row.done ? "erledigt" : "offen")
                        Text(row.name).foregroundStyle(Theme.text)
                        Spacer()
                        Text(row.amount).monospacedDigit().fontWeight(.semibold).foregroundStyle(Theme.text)
                    }
                    .font(.subheadline)
                }
            }
        }
    }
}

struct PotRowView: View {
    let row: OverviewState.PotRow

    var body: some View {
        GlassCard(cornerRadius: 18, padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
                        Text(row.detail).font(.footnote).foregroundStyle(row.tone == .overspent ? Theme.warning : Theme.secondary)
                    }
                    Spacer()
                    Text(row.available)
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(row.tone == .overspent ? Theme.warning : Theme.text)
                }
                ProgressBar(progress: row.progress, color: Theme.color(for: row.tone))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct ProgressBar: View {
    let progress: Double
    let color: Color

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.08))
                Capsule().fill(color).frame(width: max(4, proxy.size.width * progress))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}
